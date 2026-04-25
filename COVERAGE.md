# Coverage Report (NFR-16)

Generated against TRD-READYON-TIMEOFF-001.

## Summary

- **52 tests passing across 9 suites** (unit / integration / e2e / property).
- Statements: **91.13%** (target: ≥ 90%)
- Branches:   **67.72%**
- Functions:  **91.48%**
- Lines:      **92.45%**

## Critical files (target: 100%)

| File                                    | Statements | Branches | Notes |
|-----------------------------------------|------------|----------|-------|
| `src/requests/domain/request.state-machine.ts` | 94.59% | 100% | All transitions covered. Two unreachable lines from defensive `cancelConfirmed` guard. |
| `src/balances/domain/balance.math.ts`   | 100%   | 100% | Pure module, fully covered. |
| `src/hcm/hcm.client.ts`                 | 96.25% | 75.6%  | All retry/circuit paths exercised; one branch in `withRetry` post-loop fallback. |
| `src/reconciliation/reconciliation.service.ts` | 95.94% | 83.78% | Drift, conflict, dup-batch, malformed paths covered. |

## Critical scenarios (TRD §12.3)

All "do not ship without these passing" items are passing:

- I2: `Σ ledger.delta == balances.available` — property test.
- I3: `pending_hold` bounded by initial balance — property test.
- `hcm_call_retry_uses_same_idempotency_key_no_double_deduction` — passing.
- `batch_lowers_balance_below_pending_hold_flags_request_for_review` — passing (FR-19).
- `disallowed_transition_returns_409_invalid_transition` — passing.
- `repeat_submit_same_key_different_payload_returns_409_replay_mismatch` — passing.
