# ReadyOn Time-Off Microservice

Backend microservice that manages the lifecycle of employee time-off requests
while keeping balances in sync with an external Human Capital Management (HCM)
system (Workday / SAP / BambooHR style). HCM is the source of truth; ReadyOn
provides instant employee/manager UX over a locally cached, audit-friendly
projection.

## Status

**Design phase complete.** Implementation is agentic and follows the TRD
strictly — no code is shipped without a corresponding requirement ID and test
case mapping.

## Deliverables

| Deliverable          | Location                                                  |
| -------------------- | --------------------------------------------------------- |
| Technical Requirements Document (TRD) | [`docs/TRD-READYON-TIMEOFF-001.md`](docs/TRD-READYON-TIMEOFF-001.md) |
| Source code (NestJS) | `src/` *(implementation phase)*                           |
| Mock HCM server      | `mock-hcm/` *(implementation phase)*                      |
| Test suite           | `test/` *(unit, integration, e2e, property)*              |
| Coverage report      | CI artifact, target ≥ 90% (100% on state machine)         |

## Architecture at a glance

- **NestJS + TypeScript + SQLite (TypeORM)** — schema written portable to Postgres.
- **Append-only ledger + materialised cache** for balances (full audit, fast reads).
- **Defensive realtime HCM read on submit** + **HCM commit on manager approve**.
- **Daily HCM batch ingest** for full-corpus reconciliation; drift events emitted, HCM wins.
- **Idempotency-Key required on all mutations** (24h window, retry-safe HCM client).
- **Circuit breaker + degraded mode** so submits succeed when HCM is down.
- **Mock HCM** is a separate NestJS app with admin endpoints for chaos
  injection (anniversary bonuses, force-rejects, stale-on-success, latency).

See the TRD for full detail (FRs, NFRs, sequence diagrams, alternatives,
test scenarios, requirement-to-test traceability matrix).

## Key challenges addressed

1. Drift between ReadyOn cache and HCM source-of-truth.
2. Two HCM channels (realtime + batch) that may disagree.
3. Defensive validation when HCM accepts what it shouldn't.
4. External mutations (anniversary bonus, year-start refresh).
5. Request lifecycle with HCM commit and manager approval.
6. Idempotency under retries — no double-deduction.
7. Extensible dimensions (`tenant × employee × location × leaveType`).

## How to read the TRD

The TRD is the contract. Every section in it is referenced by ID:

- `FR-NN` — functional requirements (§6)
- `NFR-NN` — non-functional requirements (§7)
- §11 — alternatives considered (judgment proof)
- §12 — test strategy + requirement-to-test traceability matrix

Implementation tickets reference these IDs directly so traceability is one-to-one.

## How to run

```bash
npm install
npm run build
npm start            # ReadyOn service on PORT (default 3000)
npm run start:mock   # Mock HCM service (separate terminal)
```

## How to test

```bash
npm test             # full suite (unit + integration + e2e + property)
npm run test:cov     # with coverage; output in coverage/lcov-report/index.html
npm run lint         # eslint (see deviations below)
```

See [`docs/TRD-READYON-TIMEOFF-001.md`](docs/TRD-READYON-TIMEOFF-001.md) for the contract and [`COVERAGE.md`](COVERAGE.md) for current coverage numbers.

## Deviations from TRD

The following items remain open relative to the TRD. They are tracked rather than hidden so that future agents can close them deterministically.

1. **Branch coverage (NFR-16).** Currently 67.72%; TRD target ≥ 85%. Statement coverage (91.57%) already exceeds the 90% target. Gaps concentrated in `requests.service.ts` (60% branches), `common/correlation.ts`, `common/errors.ts`, `common/idempotency.ts`, and the post-loop fallback branch of `hcm.client.withRetry`. The jest threshold in `package.json` is still `branches: 60`; raising it to 85 is gated on those tests landing.
2. **Migrations (NFR-15).** TypeORM is still configured with `synchronize: true` for dev/test. Production migrations have not yet been authored. `migration:generate` / `migration:run` npm scripts are not yet defined.
3. **Structured logging with PII redaction (NFR-11, NFR-13).** The service uses Nest's default `Logger`. `nestjs-pino` integration with correlationId/tenantId/employeeId/requestId propagation through AsyncLocalStorage and redaction of `name`/`email`/`note` is not yet wired.
4. **FR-23 dedicated e2e test.** Post-commit drift is exercised indirectly by the existing reconciliation e2e suite. A dedicated `test/e2e/fr23-post-commit-drift.spec.ts` using the mock HCM `/admin/return-stale-on-success` toggle is not yet present.
5. **ESLint + Prettier.** Config files (`.eslintrc.cjs`, `.prettierrc`) are not yet committed; `npm run lint` is a stub. The `domain-purity.spec.ts` unit test continues to enforce NFR-17 (no framework imports under `src/**/domain/**`).
6. **Per-feature module layout (TRD §8.2).** Controllers still live in `src/controllers.ts` and entities in `src/entities/index.ts`. Splitting into `src/{balances,requests,reconciliation,health}/*.controller.ts` and per-feature entity files is open.

Closed in the most recent pass:

- State machine 100% statements/branches (`src/requests/domain/request.state-machine.ts`).
- Nightly reconciler cron at 02:00 UTC (`src/reconciliation/reconciliation.cron.ts`, FR-15 / NFR-7) with unit test verifying registration and handler behaviour.
