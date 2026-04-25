# Coverage Report (NFR-16)

Generated against TRD-READYON-TIMEOFF-001.

## Summary

- **87 tests passing across 14 suites** (unit / integration / e2e / property).
- Statements: **97.36%** (target: ≥ 90%)
- Branches:   **85.35%** (target: ≥ 85%)
- Functions:  **95.57%** (target: ≥ 90%)
- Lines:      **98.68%** (target: ≥ 90%)

Jest threshold in `package.json` is set to `branches: 85, statements: 90, functions: 90, lines: 90`.

## Critical files (target: 100%)

| File                                           | Statements | Branches | Notes |
|------------------------------------------------|------------|----------|-------|
| `src/requests/domain/request.state-machine.ts` | 100%       | 100%     | All transitions, terminal guards, and case fall-throughs covered. |
| `src/balances/domain/balance.math.ts`          | 100%       | 100%     | Pure module, fully covered. |
| `src/reconciliation/reconciliation.cron.ts`    | 100%       | 100%     | Nightly cron handler at `0 2 * * *` UTC (FR-15, NFR-7). |
| `src/migrations/0001-initial-schema.ts`        | 100%       | 100%     | up()/down() exercised by `migrations.spec.ts` (NFR-15). |
| `src/hcm/hcm.client.ts`                        | 97.5%      | 80.5%    | All retry/circuit paths exercised; only the post-loop unreachable-after-retries fallback for OPEN-after-failure remains. |
| `src/reconciliation/reconciliation.service.ts` | 100%       | 91.9%    | Drift, conflict, dup-batch, malformed paths covered. |
| `src/requests/requests.service.ts`             | 97.05%     | 77.7%    | Submit/approve/reject/cancel/drain plus FR-23 POST_COMMIT_DRIFT branch covered; unreachable rethrow guards remain. |

## Critical scenarios (TRD §12.3)

All "do not ship without these passing" items are passing:

- I2: `Σ ledger.delta == balances.available` — property test.
- I3: `pending_hold` bounded by initial balance — property test.
- `hcm_call_retry_uses_same_idempotency_key_no_double_deduction` — passing.
- `batch_lowers_balance_below_pending_hold_flags_request_for_review` — passing (FR-19).
- `disallowed_transition_returns_409_invalid_transition` — passing.
- `repeat_submit_same_key_different_payload_returns_409_replay_mismatch` — passing.
- `FR-23 post-commit drift detection` — passing (`test/e2e/fr23-post-commit-drift.spec.ts`).
- `logging redacts PII and binds correlationId` — passing (`test/integration/logging.spec.ts`).
- `migrations create the full schema and round-trip` — passing (`test/integration/migrations.spec.ts`).
