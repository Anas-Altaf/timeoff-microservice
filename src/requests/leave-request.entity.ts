import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

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
  @Column({ type: 'varchar', nullable: true }) note!: string | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('request_audit')
export class RequestAudit {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() @Index() requestId!: string;
  @Column({ type: 'varchar', nullable: true }) fromState!: string | null;
  @Column() toState!: string;
  @Column() actor!: string;
  @Column({ type: 'varchar', nullable: true }) reason!: string | null;
  @CreateDateColumn() createdAt!: Date;
}
