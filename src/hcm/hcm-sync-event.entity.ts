import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('hcm_sync_events')
export class HcmSyncEvent {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() direction!: string; // OUTBOUND | INBOUND
  @Column() kind!: string; // ADJUST_OK, ADJUST_FAIL, READ_OK, READ_FAIL, BATCH
  @Column('text') payloadJson!: string;
  @Column({ type: 'int', nullable: true }) httpStatus!: number | null;
  @Column({ type: 'varchar', nullable: true }) idempotencyKey!: string | null;
  @Column({ type: 'varchar', nullable: true }) requestId!: string | null;
  @CreateDateColumn() createdAt!: Date;
}
