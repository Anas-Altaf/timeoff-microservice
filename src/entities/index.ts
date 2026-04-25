import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@Entity('balances')
@Unique(['tenantId', 'employeeId', 'locationId', 'leaveType'])
export class Balance {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() @Index() tenantId!: string;
  @Column() @Index() employeeId!: string;
  @Column() locationId!: string;
  @Column() leaveType!: string;
  @Column('decimal', { precision: 10, scale: 2, default: 0 }) available!: string;
  @Column('decimal', { precision: 10, scale: 2, default: 0 }) pendingHold!: string;
  @Column({ type: 'datetime', nullable: true }) lastSyncedAt!: Date | null;
  @Column({ default: 'LOCAL' }) lastSource!: string;
  @Column({ default: 0 }) version!: number;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('balance_ledger')
export class BalanceLedger {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() @Index() balanceId!: string;
  @Column('decimal', { precision: 10, scale: 2 }) delta!: string;
  @Column() reason!: string;
  @Column() source!: string;
  @Column({ nullable: true }) requestId!: string | null;
  @Column({ nullable: true }) hcmEventId!: string | null;
  @Column() actor!: string;
  @CreateDateColumn() @Index() createdAt!: Date;
}

@Entity('leave_requests')
export class LeaveRequest {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() @Index() tenantId!: string;
  @Column() @Index() employeeId!: string;
  @Column() locationId!: string;
  @Column() leaveType!: string;
  @Column() startDate!: string;
  @Column() endDate!: string;
  @Column('decimal', { precision: 6, scale: 2 }) days!: string;
  @Column() @Index() state!: string;
  @Column({ default: false }) requiresReview!: boolean;
  @Column() idempotencyKey!: string;
  @Column({ nullable: true }) note!: string | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('request_audit')
export class RequestAudit {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() @Index() requestId!: string;
  @Column({ nullable: true }) fromState!: string | null;
  @Column() toState!: string;
  @Column() actor!: string;
  @Column({ nullable: true }) reason!: string | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('hcm_sync_events')
export class HcmSyncEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() direction!: string; // OUTBOUND | INBOUND
  @Column() kind!: string; // ADJUST_OK, ADJUST_FAIL, READ_OK, READ_FAIL, BATCH
  @Column('text') payloadJson!: string;
  @Column({ nullable: true }) httpStatus!: number | null;
  @Column({ nullable: true }) idempotencyKey!: string | null;
  @Column({ nullable: true }) requestId!: string | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('drift_events')
export class DriftEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ nullable: true }) balanceId!: string | null;
  @Column() employeeId!: string;
  @Column() locationId!: string;
  @Column() leaveType!: string;
  @Column('decimal', { precision: 10, scale: 2 }) localValue!: string;
  @Column('decimal', { precision: 10, scale: 2 }) hcmValue!: string;
  @Column('decimal', { precision: 10, scale: 2 }) delta!: string;
  @Column() kind!: string;
  @Column() source!: string;
  @Column() resolution!: string;
  @Column({ default: false }) resolved!: boolean;
  @CreateDateColumn() @Index() createdAt!: Date;
}

@Entity('idempotency_keys')
@Unique(['tenantId', 'route', 'key'])
export class IdempotencyKey {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() tenantId!: string;
  @Column() route!: string;
  @Column() key!: string;
  @Column('text') payloadHash!: string;
  @Column('text') responseSnapshot!: string;
  @Column() statusCode!: number;
  @CreateDateColumn() createdAt!: Date;
  @Column({ type: 'datetime' }) expiresAt!: Date;
}

@Entity('hcm_batches')
export class HcmBatch {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ unique: true }) batchId!: string;
  @CreateDateColumn() receivedAt!: Date;
  @Column() rowCount!: number;
  @Column() updatedCount!: number;
  @Column() conflictCount!: number;
  @Column() unchangedCount!: number;
  @Column() malformedCount!: number;
  @Column() status!: string;
  @Column('text') summaryJson!: string;
}

export const ALL_ENTITIES = [
  Balance,
  BalanceLedger,
  LeaveRequest,
  RequestAudit,
  HcmSyncEvent,
  DriftEvent,
  IdempotencyKey,
  HcmBatch,
];
