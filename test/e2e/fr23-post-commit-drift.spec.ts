import { startHarness, Harness, auth, idem, seed } from '../harness';
import request from 'supertest';

// FR-23 / Sequence 10.5: when HCM accepts an adjust but the balance it
// returns disagrees with what we computed locally, we must (a) confirm the
// request, (b) emit a POST_COMMIT_DRIFT event, and (c) snap our cached
// balance to whatever HCM reported (HCM is the source of truth).
describe('FR-23 post-commit drift detection', () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(() => h.close());

  it('confirms request, writes POST_COMMIT_DRIFT, snaps cache to HCM value', async () => {
    await seed(h, [{ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', balance: 12 }]);

    // Submit a 5-day request.
    const sub = await h.http
      .post('/v1/time-off-requests')
      .set(auth('EMP-1'))
      .set(idem())
      .send({ employeeId: 'EMP-1', locationId: 'US-NY', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: 5 });
    expect(sub.status).toBe(201);

    // Arm the mock HCM to return a stale (mismatched) balance on the next adjust success.
    // Mock implementation: reportedBalance = next + 100. With local cache 12 and -5 delta,
    // expected post-commit local = 7, but HCM will report 107.
    await request(h.mockApp.getHttpServer()).post('/admin/return-stale-on-success').send({});

    const ap = await h.http
      .post(`/v1/time-off-requests/${sub.body.id}/approve`)
      .set(auth('MGR-1', 'MANAGER'))
      .set(idem())
      .send({ approverId: 'MGR-1' });

    // (a) request is CONFIRMED — HCM accepted.
    expect(ap.status).toBe(201);
    expect(ap.body.state).toBe('CONFIRMED');

    // (b) a POST_COMMIT_DRIFT DriftEvent row exists for this employee.
    const drift = await h.http
      .get('/v1/internal/drift-events?employeeId=EMP-1')
      .set(auth('admin', 'ADMIN'));
    const postCommit = drift.body.events.find((e: any) => e.kind === 'POST_COMMIT_DRIFT');
    expect(postCommit).toBeTruthy();
    expect(parseFloat(postCommit.hcmValue)).toBe(107);
    expect(parseFloat(postCommit.localValue)).toBe(7);

    // (c) local cached balance == HCM-reported value (HCM wins).
    const bal = await h.http.get('/v1/employees/EMP-1/balances').set(auth('EMP-1'));
    expect(bal.body.balances[0].available).toBe(107);
    expect(bal.body.balances[0].pendingHold).toBe(0);
  });
});
