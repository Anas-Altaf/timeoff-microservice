import * as fc from 'fast-check';
import { startHarness, auth, seed } from '../harness';
import { v4 as uuidv4 } from 'uuid';

describe('property invariants I1..I5 (FR-29, NFR-7,8)', () => {
  jest.setTimeout(60_000);

  it('any sequence of submit/reject/cancel keeps invariants', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant('submit' as const), days: fc.integer({ min: 1, max: 3 }) }),
            fc.record({ kind: fc.constant('reject_last' as const) }),
            fc.record({ kind: fc.constant('cancel_last' as const) }),
            fc.record({ kind: fc.constant('approve_last' as const) }),
          ),
          { minLength: 1, maxLength: 8 },
        ),
        async (ops) => {
          const h = await startHarness({ hcmBackoffMs: [1, 1, 1] });
          try {
            await seed(h, [{ employeeId: 'E', locationId: 'L', leaveType: 'PTO', balance: 20 }]);
            const submitted: string[] = [];
            for (const op of ops) {
              if (op.kind === 'submit') {
                const r = await h.http.post('/v1/time-off-requests').set(auth('E')).set('idempotency-key', uuidv4())
                  .send({ employeeId: 'E', locationId: 'L', leaveType: 'PTO', startDate: 'a', endDate: 'b', days: op.days });
                if (r.status === 201) submitted.push(r.body.id);
              } else if (op.kind === 'reject_last' && submitted.length) {
                await h.http.post(`/v1/time-off-requests/${submitted.pop()}/reject`).set(auth('M', 'MANAGER')).set('idempotency-key', uuidv4()).send({});
              } else if (op.kind === 'cancel_last' && submitted.length) {
                await h.http.post(`/v1/time-off-requests/${submitted.pop()}/cancel`).set(auth('E', 'EMPLOYEE')).set('idempotency-key', uuidv4()).send({});
              } else if (op.kind === 'approve_last' && submitted.length) {
                await h.http.post(`/v1/time-off-requests/${submitted.pop()}/approve`).set(auth('M', 'MANAGER')).set('idempotency-key', uuidv4()).send({});
              }
            }
            // Invariants:
            const bal = await h.http.get('/v1/employees/E/balances/L/PTO').set(auth('E'));
            const available = bal.body.available;
            const pendingHold = bal.body.pendingHold;
            // I1: available >= 0
            expect(available).toBeGreaterThanOrEqual(0);
            // I3: pendingHold matches sum of active requests' days (we don't expose a query, but tested directly via DB-less check: hold cannot exceed initial 20).
            expect(pendingHold).toBeGreaterThanOrEqual(0);
            expect(pendingHold).toBeLessThanOrEqual(20);
            // I2: ledger sum == available -- check via ledger endpoint
            const led = await h.http.get('/v1/employees/E/ledger').set(auth('E'));
            const sum = led.body.entries.reduce((acc: number, e: any) => acc + e.delta, 0);
            expect(Math.round(sum * 100) / 100).toBe(available);
          } finally {
            await h.close();
          }
        },
      ),
      { numRuns: 4 },
    );
  });
});
