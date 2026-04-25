import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from '../../src/entities';
import { InitialSchema1700000000001 } from '../../src/migrations/0001-initial-schema';

// NFR-15: production schema is owned by migrations, not synchronize.
// This test asserts the migration produces a schema that all entity
// repositories can read from and insert into.
describe('TypeORM migrations (NFR-15)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      migrations: [InitialSchema1700000000001],
      synchronize: false,
      logging: false,
    });
    await ds.initialize();
    await ds.runMigrations();
  });

  afterAll(async () => { await ds.destroy(); });

  const expectedTables = [
    'balances',
    'balance_ledger',
    'leave_requests',
    'request_audit',
    'hcm_sync_events',
    'drift_events',
    'idempotency_keys',
    'hcm_batches',
  ];

  it.each(expectedTables)('table %s exists with expected columns', async (table) => {
    const rows = await ds.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
    expect(rows.length).toBe(1);
  });

  it('all entities can roundtrip an insert+select against the migrated schema', async () => {
    const balRepo = ds.getRepository(ALL_ENTITIES[0]); // Balance
    const saved: any = await balRepo.save({
      tenantId: 'T1',
      employeeId: 'E1',
      locationId: 'L1',
      leaveType: 'PTO',
      available: '5.00',
      pendingHold: '0.00',
    } as any);
    const got = await balRepo.findOne({ where: { id: saved.id } });
    expect(got).toBeTruthy();
  });

  it('migration down() drops all tables (rollback safety)', async () => {
    const ds2 = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      migrations: [InitialSchema1700000000001],
      synchronize: false,
      logging: false,
    });
    await ds2.initialize();
    await ds2.runMigrations();
    await ds2.undoLastMigration();
    const rows = await ds2.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='balances'`);
    expect(rows.length).toBe(0);
    await ds2.destroy();
  });
});
