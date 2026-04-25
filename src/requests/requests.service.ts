import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { LeaveRequest, RequestAudit, HcmSyncEvent, DriftEvent } from '../entities';
import { DomainError } from '../common/errors';
import { canSubmit } from '../balances/domain/balance.math';
import {
  ActorRole,
  cancelConfirmed,
  RequestState,
  transition,
} from './domain/request.state-machine';
import { BalancesService } from '../balances/balances.service';
import { HcmClient, HcmRejectedError, HcmUnavailableError } from '../hcm/hcm.client';

@Injectable()
export class RequestsService {
  private readonly log = new Logger('RequestsService');

  constructor(
    @InjectRepository(LeaveRequest) private reqRepo: Repository<LeaveRequest>,
    @InjectRepository(RequestAudit) private auditRepo: Repository<RequestAudit>,
    @InjectRepository(HcmSyncEvent) private syncRepo: Repository<HcmSyncEvent>,
    @InjectRepository(DriftEvent) private driftRepo: Repository<DriftEvent>,
    private balances: BalancesService,
    private hcm: HcmClient,
  ) {}

  private async audit(requestId: string, from: string | null, to: string, actor: string, reason?: string) {
    await this.auditRepo.save(this.auditRepo.create({ requestId, fromState: from, toState: to, actor, reason: reason ?? null }));
  }

  async getById(id: string): Promise<LeaveRequest> {
    const r = await this.reqRepo.findOne({ where: { id } });
    if (!r) throw new DomainError('INVALID_TRANSITION', `Request ${id} not found`);
    return r;
  }

  async submit(args: {
    tenantId: string;
    employeeId: string;
    locationId: string;
    leaveType: string;
    startDate: string;
    endDate: string;
    days: number;
    note?: string;
    idempotencyKey: string;
    actor: string;
  }) {
    const balance = await this.balances.findOrThrow(args.tenantId, args.employeeId, args.locationId, args.leaveType);
    let hcmReported: number | null = null;
    let degraded = false;
    try {
      hcmReported = await this.hcm.readBalance({
        tenantId: args.tenantId,
        employeeId: args.employeeId,
        locationId: args.locationId,
        leaveType: args.leaveType,
      });
    } catch (e) {
      if (e instanceof HcmUnavailableError) {
        degraded = true; // FR-15
      } else {
        throw e;
      }
    }

    const verdict = canSubmit({
      cachedAvailable: parseFloat(balance.available),
      cachedPendingHold: parseFloat(balance.pendingHold),
      hcmReportedAvailable: hcmReported,
      requestedDays: args.days,
      policyStrict: false,
    });
    if (!verdict.ok) {
      throw new DomainError(verdict.code, `Cannot submit: ${verdict.code}`, {
        requested: args.days,
        cachedAvailable: parseFloat(balance.available),
        hcmReported,
      });
    }

    await this.balances.adjustHold(balance.id, args.days);

    const req = this.reqRepo.create({
      id: uuidv4(),
      tenantId: args.tenantId,
      employeeId: args.employeeId,
      locationId: args.locationId,
      leaveType: args.leaveType,
      startDate: args.startDate,
      endDate: args.endDate,
      days: args.days.toFixed(2),
      state: 'SUBMITTED',
      idempotencyKey: args.idempotencyKey,
      note: args.note ?? null,
    });
    await this.reqRepo.save(req);
    await this.audit(req.id, null, 'SUBMITTED', args.actor);
    return { request: req, degraded };
  }

  async approve(id: string, actor: ActorRole, actorId: string) {
    const r = await this.getById(id);
    const t1 = transition(r.state as RequestState, { type: 'approve', actor });
    r.state = t1.to;
    await this.reqRepo.save(r);
    await this.audit(r.id, 'SUBMITTED', t1.to, actorId);

    // Now post deduction to HCM.
    const balance = await this.balances.findOrThrow(r.tenantId, r.employeeId, r.locationId, r.leaveType);
    const days = parseFloat(r.days);
    try {
      const result = await this.hcm.adjustBalance({
        tenantId: r.tenantId,
        employeeId: r.employeeId,
        locationId: r.locationId,
        leaveType: r.leaveType,
        delta: -days,
        idempotencyKey: r.idempotencyKey, // NFR-6: same key
      });
      await this.syncRepo.save(
        this.syncRepo.create({
          direction: 'OUTBOUND',
          kind: 'ADJUST_OK',
          payloadJson: JSON.stringify({ delta: -days, result }),
          httpStatus: 200,
          idempotencyKey: r.idempotencyKey,
          requestId: r.id,
        }),
      );
      const t2 = transition(r.state as RequestState, { type: 'hcm.ack' });
      r.state = t2.to;
      await this.reqRepo.save(r);
      await this.audit(r.id, 'APPROVED', t2.to, 'SYSTEM');
      await this.balances.commitLedger({
        balanceId: balance.id,
        delta: -days,
        reason: 'REQUEST_CONFIRMED',
        source: 'HCM_REALTIME',
        requestId: r.id,
        hcmEventId: result.hcmEventId,
        actor: actorId,
        releaseHold: days,
      });

      // FR-23 / Sequence 10.5: post-commit drift detection.
      // Compare expected post-commit balance with HCM-reported value; on mismatch,
      // emit a POST_COMMIT_DRIFT event, snap the local cache to the HCM value
      // (HCM wins), and log a warning.
      const expected = parseFloat(balance.available) - days;
      const reported = Number(result.newBalance);
      if (Number.isFinite(reported) && Math.abs(reported - expected) >= 0.005) {
        const driftDelta = reported - expected;
        await this.driftRepo.save(
          this.driftRepo.create({
            balanceId: balance.id,
            employeeId: r.employeeId,
            locationId: r.locationId,
            leaveType: r.leaveType,
            localValue: expected.toFixed(2),
            hcmValue: reported.toFixed(2),
            delta: driftDelta.toFixed(2),
            kind: 'POST_COMMIT_DRIFT',
            source: 'HCM_REALTIME',
            resolution: 'AUTO_APPLIED',
          }),
        );
        // Snap local cache to HCM-reported value.
        const reconciled = await this.balances.findOrThrow(r.tenantId, r.employeeId, r.locationId, r.leaveType);
        await this.balances.commitLedger({
          balanceId: reconciled.id,
          delta: driftDelta,
          reason: 'POST_COMMIT_DRIFT_SNAP',
          source: 'HCM_REALTIME',
          requestId: r.id,
          hcmEventId: result.hcmEventId,
          actor: 'SYSTEM',
          releaseHold: 0,
        });
        this.log.warn(
          `POST_COMMIT_DRIFT request=${r.id} expected=${expected.toFixed(2)} reported=${reported.toFixed(2)} delta=${driftDelta.toFixed(2)}`,
        );
      }
      return r;
    } catch (e) {
      if (e instanceof HcmRejectedError) {
        await this.syncRepo.save(
          this.syncRepo.create({
            direction: 'OUTBOUND',
            kind: 'ADJUST_FAIL',
            payloadJson: JSON.stringify({ error: e.message }),
            httpStatus: e.httpStatus,
            idempotencyKey: r.idempotencyKey,
            requestId: r.id,
          }),
        );
        const t2 = transition(r.state as RequestState, { type: 'hcm.reject' });
        r.state = t2.to;
        await this.reqRepo.save(r);
        await this.audit(r.id, 'APPROVED', t2.to, 'SYSTEM', e.message);
        await this.balances.adjustHold(balance.id, -days);
        return r;
      }
      if (e instanceof HcmUnavailableError) {
        const t2 = transition(r.state as RequestState, { type: 'hcm.unavailable' });
        r.state = t2.to;
        await this.reqRepo.save(r);
        await this.audit(r.id, 'APPROVED', t2.to, 'SYSTEM', 'HCM circuit open');
        return r;
      }
      throw e;
    }
  }

  async reject(id: string, actorId: string, reason?: string) {
    const r = await this.getById(id);
    const t = transition(r.state as RequestState, { type: 'reject', actor: 'MANAGER' });
    r.state = t.to;
    await this.reqRepo.save(r);
    await this.audit(r.id, 'SUBMITTED', t.to, actorId, reason);
    const b = await this.balances.findOrThrow(r.tenantId, r.employeeId, r.locationId, r.leaveType);
    await this.balances.adjustHold(b.id, -parseFloat(r.days));
    return r;
  }

  async cancel(id: string, actor: ActorRole, actorId: string, reason?: string) {
    const r = await this.getById(id);
    if (r.state === 'CONFIRMED') {
      cancelConfirmed(r.state as RequestState, actor); // throws if not ADMIN
      const days = parseFloat(r.days);
      const b = await this.balances.findOrThrow(r.tenantId, r.employeeId, r.locationId, r.leaveType);
      // Compensating credit to HCM (FR-9, §16.2).
      const compKey = `cancel-${r.id}`;
      try {
        const result = await this.hcm.adjustBalance({
          tenantId: r.tenantId,
          employeeId: r.employeeId,
          locationId: r.locationId,
          leaveType: r.leaveType,
          delta: +days,
          idempotencyKey: compKey,
        });
        await this.syncRepo.save(
          this.syncRepo.create({
            direction: 'OUTBOUND',
            kind: 'COMPENSATING_OK',
            payloadJson: JSON.stringify({ delta: days, result }),
            httpStatus: 200,
            idempotencyKey: compKey,
            requestId: r.id,
          }),
        );
      } catch (e: any) {
        await this.syncRepo.save(
          this.syncRepo.create({
            direction: 'OUTBOUND',
            kind: 'COMPENSATING_FAIL',
            payloadJson: JSON.stringify({ error: e.message }),
            httpStatus: e?.httpStatus ?? null,
            idempotencyKey: compKey,
            requestId: r.id,
          }),
        );
        // Still mark cancelled per spec; SRE handles compensation queue.
      }
      r.state = 'CANCELLED';
      await this.reqRepo.save(r);
      await this.audit(r.id, 'CONFIRMED', 'CANCELLED', actorId, reason);
      await this.balances.commitLedger({
        balanceId: b.id,
        delta: +days,
        reason: 'REQUEST_CANCELLED_COMPENSATING',
        source: 'HCM_REALTIME',
        requestId: r.id,
        actor: actorId,
        releaseHold: 0,
      });
      return r;
    }
    // Employee cancel from SUBMITTED.
    const t = transition(r.state as RequestState, { type: 'cancel', actor, isOwner: actor === 'EMPLOYEE' });
    r.state = t.to;
    await this.reqRepo.save(r);
    await this.audit(r.id, 'SUBMITTED', t.to, actorId, reason);
    const b = await this.balances.findOrThrow(r.tenantId, r.employeeId, r.locationId, r.leaveType);
    await this.balances.adjustHold(b.id, -parseFloat(r.days));
    return r;
  }

  // Drain queue when circuit closes (FR-15).
  async drainPendingHcmPost(): Promise<number> {
    const pending = await this.reqRepo.find({ where: { state: 'PENDING_HCM_POST' } });
    let drained = 0;
    for (const r of pending) {
      const days = parseFloat(r.days);
      try {
        const result = await this.hcm.adjustBalance({
          tenantId: r.tenantId,
          employeeId: r.employeeId,
          locationId: r.locationId,
          leaveType: r.leaveType,
          delta: -days,
          idempotencyKey: r.idempotencyKey,
        });
        const t = transition(r.state as RequestState, { type: 'hcm.ack' });
        r.state = t.to;
        await this.reqRepo.save(r);
        await this.audit(r.id, 'PENDING_HCM_POST', t.to, 'SYSTEM');
        const b = await this.balances.findOrThrow(r.tenantId, r.employeeId, r.locationId, r.leaveType);
        await this.balances.commitLedger({
          balanceId: b.id,
          delta: -days,
          reason: 'REQUEST_CONFIRMED',
          source: 'HCM_REALTIME',
          requestId: r.id,
          hcmEventId: result.hcmEventId,
          actor: 'SYSTEM',
          releaseHold: days,
        });
        drained++;
      } catch (e) {
        if (e instanceof HcmRejectedError) {
          const t = transition(r.state as RequestState, { type: 'hcm.reject' });
          r.state = t.to;
          await this.reqRepo.save(r);
          await this.audit(r.id, 'PENDING_HCM_POST', t.to, 'SYSTEM', e.message);
          const b = await this.balances.findOrThrow(r.tenantId, r.employeeId, r.locationId, r.leaveType);
          await this.balances.adjustHold(b.id, -days);
          drained++;
        }
        // unavailable: leave queued for next pass.
      }
    }
    return drained;
  }

  async activeForBalance(balanceKey: { tenantId: string; employeeId: string; locationId: string; leaveType: string }) {
    return this.reqRepo.find({
      where: { ...balanceKey, state: In(['SUBMITTED', 'APPROVED', 'PENDING_HCM_POST']) },
    });
  }

  async flagRequiresReview(ids: string[]) {
    if (!ids.length) return;
    await this.reqRepo.update({ id: In(ids) }, { requiresReview: true });
  }
}
