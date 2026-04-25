import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Unique,
} from 'typeorm';

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
