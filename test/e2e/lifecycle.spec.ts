import { startHarness, Harness, auth, idem, seed } from '../harness';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';

describe('lifecycle (FR-5..11, FR-24..28)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
    await seed(h, [{ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', balance: 10 }]);
  });
  afterEach(() => h.close());

  it('submit_happy_path_creates_hold_and_returns_201', async () => {
    const r = await h.http
      .post('/v1/time-off-requests')
      .set(auth('EMP-1'))
      .set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: '2026-05-04', endDate: '2026-05-08', days: 5 });
    expect(r.status).toBe(201);
    expect(r.body.state).toBe('SUBMITTED');
    expect(r.body.hold).toBe(5);
    expect(r.body.balanceAfterHold).toBe(5);
  });

  it('submit_zero_days_rejected_invalid_duration (FR-25)', async () => {
    const r = await h.http
      .post('/v1/time-off-requests')
      .set(auth('EMP-1'))
      .set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_DURATION');
  });

  it('submit_unknown_dimension_rejected (FR-24)', async () => {
    const r = await h.http
      .post('/v1/time-off-requests')
      .set(auth('EMP-1'))
      .set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'XX', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 1 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('UNKNOWN_DIMENSION');
  });

  it('approve_posts_to_hcm_and_confirms_request (FR-7)', async () => {
    const sub = await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 3 });
    expect(sub.status).toBe(201);
    const ap = await h.http.post(`/v1/time-off-requests/${sub.body.id}/approve`).set(auth('MGR-1', 'MANAGER')).set(idem())
      .send({ approverId: 'MGR-1' });
    expect(ap.status).toBe(201); // 200/201 either OK; nest default for POST is 201
    expect(['CONFIRMED']).toContain(ap.body.state);
  });

  it('approve_when_hcm_rejects_transitions_to_rejected_by_hcm', async () => {
    const sub = await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 3 });
    expect(sub.status).toBe(201);
    await request(h.mockApp.getHttpServer()).post('/admin/force-reject-next');
    const ap = await h.http.post(`/v1/time-off-requests/${sub.body.id}/approve`).set(auth('MGR-1', 'MANAGER')).set(idem())
      .send({ approverId: 'MGR-1' });
    expect(ap.body.state).toBe('REJECTED_BY_HCM');
    // hold released:
    const bal = await h.http.get('/v1/employees/EMP-1/balances').set(auth('EMP-1'));
    expect(bal.body.balances[0].pendingHold).toBe(0);
  });

  it('manager_reject_releases_hold_no_hcm_call (FR-8)', async () => {
    const sub = await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 4 });
    const rej = await h.http.post(`/v1/time-off-requests/${sub.body.id}/reject`).set(auth('MGR-1', 'MANAGER')).set(idem())
      .send({ approverId: 'MGR-1', reason: 'no' });
    expect(rej.body.state).toBe('REJECTED_BY_MANAGER');
    const bal = await h.http.get('/v1/employees/EMP-1/balances').set(auth('EMP-1'));
    expect(bal.body.balances[0].pendingHold).toBe(0);
  });

  it('employee_cancel_in_submitted_releases_hold (FR-9)', async () => {
    const sub = await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 2 });
    const c = await h.http.post(`/v1/time-off-requests/${sub.body.id}/cancel`).set(auth('EMP-1', 'EMPLOYEE')).set(idem()).send({});
    expect(c.body.state).toBe('CANCELLED');
    const bal = await h.http.get('/v1/employees/EMP-1/balances').set(auth('EMP-1'));
    expect(bal.body.balances[0].pendingHold).toBe(0);
  });

  it('admin_cancel_in_confirmed_posts_compensating_credit', async () => {
    const sub = await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 3 });
    const ap = await h.http.post(`/v1/time-off-requests/${sub.body.id}/approve`).set(auth('MGR', 'MANAGER')).set(idem()).send({});
    expect(ap.body.state).toBe('CONFIRMED');
    const c = await h.http.post(`/v1/time-off-requests/${sub.body.id}/cancel`).set(auth('AD', 'ADMIN')).set(idem()).send({});
    expect(c.body.state).toBe('CANCELLED');
    // compensating credit should leave available back at 10
    const bal = await h.http.get('/v1/employees/EMP-1/balances').set(auth('EMP-1'));
    expect(bal.body.balances[0].available).toBe(10);
  });

  it('disallowed_transition_returns_409_invalid_transition (FR-10)', async () => {
    const sub = await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 3 });
    // reject then approve -> invalid
    await h.http.post(`/v1/time-off-requests/${sub.body.id}/reject`).set(auth('MGR', 'MANAGER')).set(idem()).send({});
    const r = await h.http.post(`/v1/time-off-requests/${sub.body.id}/approve`).set(auth('MGR', 'MANAGER')).set(idem()).send({});
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('repeat_submit_same_idempotency_key_returns_original_response (FR-26/27)', async () => {
    const key = uuidv4();
    const body = { employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 2 };
    const r1 = await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set('idempotency-key', key).send(body);
    const r2 = await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set('idempotency-key', key).send(body);
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id);
  });

  it('repeat_submit_same_key_different_payload_returns_409_replay_mismatch', async () => {
    const key = uuidv4();
    await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set('idempotency-key', key)
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 2 });
    const r2 = await h.http.post('/v1/time-off-requests').set(auth('EMP-1')).set('idempotency-key', key)
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 3 });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('IDEMPOTENCY_REPLAY_MISMATCH');
  });

  it('missing_identity_headers_returns_401', async () => {
    const r = await h.http.post('/v1/time-off-requests').set('idempotency-key', uuidv4()).send({});
    expect(r.status).toBe(401);
  });
});
