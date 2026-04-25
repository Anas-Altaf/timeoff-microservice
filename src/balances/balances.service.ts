import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Balance, BalanceLedger, DriftEvent } from '../entities';
import { DomainError } from '../common/errors';
import { isDrift, sumLedger } from './domain/balance.math';
import { HcmClient } from '../hcm/hcm.client';

@Injectable()
export class BalancesService {
  constructor(
    @InjectRepository(Balance) private balRepo: Repository<Balance>,
    @InjectRepository(BalanceLedger) private ledRepo: Repository<BalanceLedger>,
    @InjectRepository(DriftEvent) private driftRepo: Repository<DriftEvent>,
    private dataSource: DataSource,
    private hcm: HcmClient,
  ) {}

  async findOrThrow(tenantId: string, employeeId: string, locationId: string, leaveType: string) {
    const b = await this.balRepo.findOne({ where: { tenantId, employeeId, locationId, leaveType } });
    if (!b) throw new DomainError('UNKNOWN_DIMENSION', `No balance for ${employeeId}/${locationId}/${leaveType}`);
    return b;
  }

  async listByEmployee(tenantId: string, employeeId: string) {
    return this.balRepo.find({ where: { tenantId, employeeId } });
  }

  async upsert(args: {
    tenantId: string;
    employeeId: string;
    locationId: string;
    leaveType: string;
    available: number;
    source: string;
  }) {
    let b = await this.balRepo.findOne({
      where: {
        tenantId: args.tenantId,
        employeeId: args.employeeId,
        locationId: args.locationId,
        leaveType: args.leaveType,
      },
    });
    if (!b) {
      b = this.balRepo.create({
        tenantId: args.tenantId,
        employeeId: args.employeeId,
        locationId: args.locationId,
        leaveType: args.leaveType,
        available: args.available.toFixed(2),
        pendingHold: '0.00',
        lastSource: args.source,
        lastSyncedAt: new Date(),
        version: 0,
      });
      await this.balRepo.save(b);
    } else {
      b.available = args.available.toFixed(2);
      b.lastSource = args.source;
      b.lastSyncedAt = new Date();
      b.version = (b.version ?? 0) + 1;
      await this.balRepo.save(b);
    }
    return b;
  }

  // Refresh from HCM (FR-4, FR-21).
  async refreshFromHcm(tenantId: string, employeeId: string, locationId: string, leaveType: string) {
    const b = await this.findOrThrow(tenantId, employeeId, locationId, leaveType);
    const hcmVal = await this.hcm.readBalance({ tenantId, employeeId, locationId, leaveType });
    const local = parseFloat(b.available);
    const hold = parseFloat(b.pendingHold);
    if (isDrift({ cachedAvailable: local, hcmAvailable: hcmVal, pendingHold: hold })) {
      await this.driftRepo.save(
        this.driftRepo.create({
          balanceId: b.id,
          employeeId,
          locationId,
          leaveType,
          localValue: local.toFixed(2),
          hcmValue: hcmVal.toFixed(2),
          delta: (hcmVal - local).toFixed(2),
          kind: hcmVal > local ? 'BONUS' : 'SHORTFALL',
          source: 'HCM_REALTIME',
          resolution: 'AUTO_APPLIED',
        }),
      );
    }
    b.available = hcmVal.toFixed(2);
    b.lastSource = 'HCM_REALTIME';
    b.lastSyncedAt = new Date();
    b.version = (b.version ?? 0) + 1;
    await this.balRepo.save(b);
    await this.ledRepo.save(
      this.ledRepo.create({
        balanceId: b.id,
        delta: (hcmVal - local).toFixed(2),
        reason: 'HCM_REALTIME_SYNC',
        source: 'HCM_REALTIME',
        actor: 'SYSTEM',
      }),
    );
    return b;
  }

  // Adjust hold optimistically with version (TRD §11.3).
  async adjustHold(balanceId: string, deltaDays: number) {
    return this.dataSource.transaction(async (mgr) => {
      const b = await mgr.findOne(Balance, { where: { id: balanceId } });
      if (!b) throw new DomainError('UNKNOWN_DIMENSION', 'Balance vanished');
      const newHold = parseFloat(b.pendingHold) + deltaDays;
      const result = await mgr
        .createQueryBuilder()
        .update(Balance)
        .set({ pendingHold: newHold.toFixed(2), version: b.version + 1 })
        .where('id = :id AND version = :v', { id: b.id, v: b.version })
        .execute();
      if (result.affected !== 1) {
        throw new DomainError('INTERNAL', 'Optimistic concurrency conflict on balance');
      }
      return { ...b, pendingHold: newHold.toFixed(2), version: b.version + 1 } as Balance;
    });
  }

  async commitLedger(args: {
    balanceId: string;
    delta: number;
    reason: string;
    source: string;
    requestId?: string;
    hcmEventId?: string;
    actor: string;
    releaseHold: number; // amount to release from pending_hold
  }) {
    return this.dataSource.transaction(async (mgr) => {
      const b = await mgr.findOne(Balance, { where: { id: args.balanceId } });
      if (!b) throw new DomainError('UNKNOWN_DIMENSION', 'Balance vanished');
      const newAvail = parseFloat(b.available) + args.delta;
      const newHold = parseFloat(b.pendingHold) - args.releaseHold;
      const r = await mgr
        .createQueryBuilder()
        .update(Balance)
        .set({
          available: newAvail.toFixed(2),
          pendingHold: newHold.toFixed(2),
          version: b.version + 1,
          lastSource: args.source,
          lastSyncedAt: new Date(),
        })
        .where('id = :id AND version = :v', { id: b.id, v: b.version })
        .execute();
      if (r.affected !== 1) {
        throw new DomainError('INTERNAL', 'Optimistic concurrency conflict on commit');
      }
      await mgr.save(BalanceLedger, {
        balanceId: b.id,
        delta: args.delta.toFixed(2),
        reason: args.reason,
        source: args.source,
        requestId: args.requestId ?? null,
        hcmEventId: args.hcmEventId ?? null,
        actor: args.actor,
      });
    });
  }

  async getLedger(employeeId: string, locationId?: string, leaveType?: string, page = 1, size = 50) {
    const qb = this.ledRepo
      .createQueryBuilder('l')
      .innerJoin(Balance, 'b', 'b.id = l.balanceId')
      .where('b.employeeId = :employeeId', { employeeId });
    if (locationId) qb.andWhere('b.locationId = :locationId', { locationId });
    if (leaveType) qb.andWhere('b.leaveType = :leaveType', { leaveType });
    qb.orderBy('l.createdAt', 'DESC').skip((page - 1) * size).take(size);
    return qb.getMany();
  }

  // Recompute available from ledger sum (used by tests / property checks).
  async availableFromLedger(balanceId: string): Promise<number> {
    const rows = await this.ledRepo.find({ where: { balanceId } });
    return sumLedger(rows.map((r) => ({ delta: parseFloat(r.delta), reason: r.reason as any, source: r.source as any })));
  }
}
