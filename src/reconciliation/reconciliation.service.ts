import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Balance, BalanceLedger, DriftEvent, HcmBatch, LeaveRequest } from '../entities';
import { isConflict } from '../balances/domain/balance.math';

export interface BatchRow {
  tenantId: string;
  employeeId: string;
  locationId: string;
  leaveType: string;
  balance: number;
}

export interface BatchSummary {
  batchId: string;
  received: number;
  unchanged: number;
  updated: number;
  conflicts: number;
  malformed: number;
  duplicateOfBatch: string | null;
}

@Injectable()
export class ReconciliationService {
  constructor(
    @InjectRepository(Balance) private balRepo: Repository<Balance>,
    @InjectRepository(BalanceLedger) private ledRepo: Repository<BalanceLedger>,
    @InjectRepository(DriftEvent) private driftRepo: Repository<DriftEvent>,
    @InjectRepository(HcmBatch) private batchRepo: Repository<HcmBatch>,
    @InjectRepository(LeaveRequest) private reqRepo: Repository<LeaveRequest>,
    private ds: DataSource,
  ) {}

  validateRow(r: any): r is BatchRow {
    return (
      r &&
      typeof r.tenantId === 'string' &&
      typeof r.employeeId === 'string' &&
      typeof r.locationId === 'string' &&
      typeof r.leaveType === 'string' &&
      typeof r.balance === 'number' &&
      Number.isFinite(r.balance)
    );
  }

  async ingestBatch(batchId: string, rows: any[]): Promise<BatchSummary> {
    const existing = await this.batchRepo.findOne({ where: { batchId } });
    if (existing) {
      return JSON.parse(existing.summaryJson);
    }
    let unchanged = 0,
      updated = 0,
      conflicts = 0,
      malformed = 0;

    for (const raw of rows) {
      if (!this.validateRow(raw)) {
        malformed++;
        continue;
      }
      const row = raw;
      let bal = await this.balRepo.findOne({
        where: {
          tenantId: row.tenantId,
          employeeId: row.employeeId,
          locationId: row.locationId,
          leaveType: row.leaveType,
        },
      });
      const localAvail = bal ? parseFloat(bal.available) : 0;
      const localHold = bal ? parseFloat(bal.pendingHold) : 0;

      if (bal && Math.abs(localAvail - row.balance) < 0.005) {
        unchanged++;
        bal.lastSyncedAt = new Date();
        bal.lastSource = 'HCM_BATCH';
        await this.balRepo.save(bal);
        continue;
      }

      if (!bal) {
        bal = this.balRepo.create({
          tenantId: row.tenantId,
          employeeId: row.employeeId,
          locationId: row.locationId,
          leaveType: row.leaveType,
          available: row.balance.toFixed(2),
          pendingHold: '0.00',
          lastSource: 'HCM_BATCH',
          lastSyncedAt: new Date(),
          version: 0,
        });
        await this.balRepo.save(bal);
        await this.ledRepo.save(
          this.ledRepo.create({
            balanceId: bal.id,
            delta: row.balance.toFixed(2),
            reason: 'HCM_BATCH_SYNC',
            source: 'HCM_BATCH',
            actor: 'SYSTEM',
          }),
        );
        updated++;
        continue;
      }

      const delta = row.balance - localAvail;
      const conflict = isConflict({ newHcmBalance: row.balance, pendingHold: localHold });

      // Always emit DriftEvent for mismatches (FR-18).
      await this.driftRepo.save(
        this.driftRepo.create({
          balanceId: bal.id,
          employeeId: row.employeeId,
          locationId: row.locationId,
          leaveType: row.leaveType,
          localValue: localAvail.toFixed(2),
          hcmValue: row.balance.toFixed(2),
          delta: delta.toFixed(2),
          kind: conflict ? 'CONFLICT' : delta > 0 ? 'BONUS' : 'SHORTFALL',
          source: 'HCM_BATCH',
          resolution: conflict ? 'REQUIRES_REVIEW' : 'AUTO_APPLIED',
        }),
      );

      // FR-19: HCM wins, but flag affected in-flight requests for review.
      bal.available = row.balance.toFixed(2);
      bal.lastSource = 'HCM_BATCH';
      bal.lastSyncedAt = new Date();
      bal.version = (bal.version ?? 0) + 1;
      await this.balRepo.save(bal);
      await this.ledRepo.save(
        this.ledRepo.create({
          balanceId: bal.id,
          delta: delta.toFixed(2),
          reason: delta > 0 ? 'ANNIVERSARY_BONUS' : 'HCM_BATCH_SYNC',
          source: 'HCM_BATCH',
          actor: 'SYSTEM',
        }),
      );

      if (conflict) {
        conflicts++;
        const active = await this.reqRepo
          .createQueryBuilder('r')
          .where('r.tenantId = :t AND r.employeeId = :e AND r.locationId = :l AND r.leaveType = :lt', {
            t: row.tenantId,
            e: row.employeeId,
            l: row.locationId,
            lt: row.leaveType,
          })
          .andWhere('r.state IN (:...states)', { states: ['SUBMITTED', 'APPROVED', 'PENDING_HCM_POST'] })
          .getMany();
        for (const r of active) {
          r.requiresReview = true;
          await this.reqRepo.save(r);
        }
      } else {
        updated++;
      }
    }

    const summary: BatchSummary = {
      batchId,
      received: rows.length,
      unchanged,
      updated,
      conflicts,
      malformed,
      duplicateOfBatch: null,
    };
    await this.batchRepo.save(
      this.batchRepo.create({
        batchId,
        rowCount: rows.length,
        updatedCount: updated,
        conflictCount: conflicts,
        unchangedCount: unchanged,
        malformedCount: malformed,
        status: 'COMPLETED',
        summaryJson: JSON.stringify(summary),
      }),
    );
    return summary;
  }

  async listDriftEvents(filters: { employeeId?: string; from?: string; to?: string; unresolved?: boolean; page?: number; size?: number }) {
    const qb = this.driftRepo.createQueryBuilder('d');
    if (filters.employeeId) qb.andWhere('d.employeeId = :e', { e: filters.employeeId });
    if (filters.from) qb.andWhere('d.createdAt >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('d.createdAt <= :to', { to: filters.to });
    if (filters.unresolved) qb.andWhere('d.resolved = :r', { r: false });
    const page = filters.page ?? 1;
    const size = filters.size ?? 50;
    qb.orderBy('d.createdAt', 'DESC').skip((page - 1) * size).take(size);
    return qb.getMany();
  }
}
