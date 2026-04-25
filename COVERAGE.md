# Coverage Report (NFR-16)

Generated against TRD-READYON-TIMEOFF-001.

## Summary

- **56 tests passing across 10 suites** (unit / integration / e2e / property).
- Statements: **91.57%** (target: ≥ 90%)
- Branches:   **67.72%** (target: ≥ 85% — NOT YET MET, see deviations)
- Functions:  **91.66%**
- Lines:      **92.89%**

## Critical files (target: 100%)

| File                                           | Statements | Branches | Notes |
|------------------------------------------------|------------|----------|-------|
| `src/requests/domain/request.state-machine.ts` | 100%       | 100%     | All transitions, terminal guards, and case fall-throughs covered. |
| `src/balances/domain/balance.math.ts`          | 100%       | 100%     | Pure module, fully covered. |
| `src/reconciliation/reconciliation.cron.ts`    | 100%       | 100%     | Nightly cron handler at `0 2 * * *` UTC (FR-15, NFR-7). |
| `src/hcm/hcm.client.ts`                        | 96.25%     | 75.6%    | All retry/circuit paths exercised; `withRetry` post-loop fallback branch still uncovered. |
| `src/reconciliation/reconciliation.service.ts` | 95.94%     | 83.78%   | Drift, conflict, dup-batch, malformed paths covered. |

## Critical scenarios (TRD §12.3)

All "do not ship without these passing" items are passing:

- I2: `Σ ledger.delta == balances.available` — property test.
- I3: `pending_hold` bounded by initial balance — property test.
- `hcm_call_retry_uses_same_idempotency_key_no_double_deduction` — passing.
- `batch_lowers_balance_below_pending_hold_flags_request_for_review` — passing (FR-19).
- `disallowed_transition_returns_409_invalid_transition` — passing.
- `repeat_submit_same_key_different_payload_returns_409_replay_mismatch` — passing.
