import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('drift_events')
export class DriftEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'varchar', nullable: true }) balanceId!: string | null;
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
