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
  @Column({ type: 'varchar', nullable: true }) requestId!: string | null;
  @Column({ type: 'varchar', nullable: true }) hcmEventId!: string | null;
  @Column() actor!: string;
  @CreateDateColumn() @Index() createdAt!: Date;
}
