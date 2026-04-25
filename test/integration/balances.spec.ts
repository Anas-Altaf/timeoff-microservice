import { startHarness, Harness, auth, seed } from '../harness';

describe('balances read (FR-1..4)', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(() => h.close());

  it('get_balances_returns_all_dimensions with lastSyncedAt and source (FR-1,3)', async () => {
    await seed(h, [
      { employeeId: 'E1', locationId: 'NY', leaveType: 'PTO', balance: 12 },
      { employeeId: 'E1', locationId: 'NY', leaveType: 'SICK', balance: 5 },
    ]);
    const r = await h.http.get('/v1/employees/E1/balances').set(auth('E1'));
    expect(r.status).toBe(200);
    expect(r.body.balances.length).toBe(2);
    for (const b of r.body.balances) {
      expect(b).toHaveProperty('lastSyncedAt');
      expect(b).toHaveProperty('source');
      expect(b).toHaveProperty('effective');
    }
  });

  it('balance_read_with_refresh_calls_hcm_and_updates_cache (FR-4, FR-21)', async () => {
    await seed(h, [{ employeeId: 'E1', locationId: 'NY', leaveType: 'PTO', balance: 12 }]);
    // mutate HCM directly
    const supertest = (await import('supertest')).default;
    await supertest(h.mockApp.getHttpServer()).post('/admin/seed').send({
      rows: [{ tenantId: 'T1', employeeId: 'E1', locationId: 'NY', leaveType: 'PTO', balance: 16 }],
    });
    const r = await h.http.get('/v1/employees/E1/balances/NY/PTO?refresh=true').set(auth('E1'));
    expect(r.body.available).toBe(16);
    expect(r.body.source).toBe('HCM_REALTIME');
    const drift = await h.http.get('/v1/internal/drift-events?employeeId=E1').set(auth('a', 'ADMIN'));
    expect(drift.body.events.length).toBeGreaterThan(0);
  });

  it('healthz/readyz/metrics work', async () => {
    expect((await h.http.get('/healthz')).status).toBe(200);
    expect((await h.http.get('/readyz')).status).toBe(200);
    const m = await h.http.get('/metrics');
    expect(m.status).toBe(200);
    expect(m.text).toContain('process_cpu_user_seconds_total');
  });
});
