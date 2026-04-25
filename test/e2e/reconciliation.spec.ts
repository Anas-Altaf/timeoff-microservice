import { startHarness, Harness, auth, idem, seed } from '../harness';

describe('reconciliation (FR-16..21, FR-22)', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(() => h.close());

  const batch = (rows: any[], batchId = 'B-' + Math.random()) => ({
    batchId,
    asOf: new Date().toISOString(),
    rows,
  });

  it('batch_with_no_changes_emits_zero_drift', async () => {
    await seed(h, [{ employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 5 }]);
    const r = await h.http.post('/v1/internal/hcm/batch-sync').set(auth('a', 'ADMIN')).set(idem())
      .send(batch([{ tenantId: 'T1', employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 5 }]));
    expect(r.body.unchanged).toBe(1);
    expect(r.body.updated).toBe(0);
  });

  it('batch_lowers_balance_outside_hold_emits_drift_and_overwrites_cache (FR-18)', async () => {
    await seed(h, [{ employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 10 }]);
    const r = await h.http.post('/v1/internal/hcm/batch-sync').set(auth('a', 'ADMIN')).set(idem())
      .send(batch([{ tenantId: 'T1', employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 8 }]));
    expect(r.body.updated).toBe(1);
    const bal = await h.http.get('/v1/employees/E1/balances').set(auth('E1'));
    expect(bal.body.balances[0].available).toBe(8);
    const drift = await h.http.get('/v1/internal/drift-events').set(auth('a', 'ADMIN'));
    expect(drift.body.events.length).toBeGreaterThan(0);
  });

  it('batch_lowers_balance_below_pending_hold_flags_request_for_review (FR-19)', async () => {
    await seed(h, [{ employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 10 }]);
    const sub = await h.http.post('/v1/time-off-requests').set(auth('E1')).set(idem())
      .send({ employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 5 });
    expect(sub.status).toBe(201);
    const r = await h.http.post('/v1/internal/hcm/batch-sync').set(auth('a', 'ADMIN')).set(idem())
      .send(batch([{ tenantId: 'T1', employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 1 }]));
    expect(r.body.conflicts).toBe(1);
    // Request NOT auto-cancelled; flagged for review.
    const get = await h.http.get(`/v1/time-off-requests/${sub.body.id}`).set(auth('E1'));
    expect(get.body.state).toBe('SUBMITTED');
    expect(get.body.requiresReview).toBe(true);
  });

  it('duplicate_batch_id_is_idempotent (FR-17)', async () => {
    await seed(h, [{ employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 5 }]);
    const id = 'BATCH-DUP-1';
    const r1 = await h.http.post('/v1/internal/hcm/batch-sync').set(auth('a', 'ADMIN')).set(idem())
      .send(batch([{ tenantId: 'T1', employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 7 }], id));
    const r2 = await h.http.post('/v1/internal/hcm/batch-sync').set(auth('a', 'ADMIN')).set(idem())
      .send(batch([{ tenantId: 'T1', employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 99 }], id));
    expect(r2.body).toEqual(r1.body);
    const bal = await h.http.get('/v1/employees/E1/balances').set(auth('E1'));
    expect(bal.body.balances[0].available).toBe(7); // unchanged on dup
  });

  it('malformed_row_quarantined_others_processed (FR-20)', async () => {
    await seed(h, [{ employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 5 }]);
    const r = await h.http.post('/v1/internal/hcm/batch-sync').set(auth('a', 'ADMIN')).set(idem())
      .send(batch([
        { tenantId: 'T1', employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 6 },
        { tenantId: 'T1', employeeId: 'E2' }, // malformed
      ]));
    expect(r.body.malformed).toBe(1);
    expect(r.body.updated).toBe(1);
  });

  it('drift_events_endpoint_paginates_and_filters (FR-22)', async () => {
    await seed(h, [{ employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 10 }]);
    await h.http.post('/v1/internal/hcm/batch-sync').set(auth('a', 'ADMIN')).set(idem())
      .send(batch([{ tenantId: 'T1', employeeId: 'E1', locationId: 'L1', leaveType: 'PTO', balance: 8 }]));
    const r = await h.http.get('/v1/internal/drift-events?employeeId=E1&page=1&size=10').set(auth('a', 'ADMIN'));
    expect(r.body.events.length).toBe(1);
    expect(r.body.events[0].employeeId).toBe('E1');
  });
});
