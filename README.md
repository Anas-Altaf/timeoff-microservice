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

None outstanding. All previously deferred items have been closed.

Closed in the most recent pass:

- **NFR-15 Migrations.** Production data source uses `synchronize: false`; schema is created by `src/migrations/0001-initial-schema.ts`. `migration:generate` / `migration:run` / `migration:revert` npm scripts wired through `src/data-source.ts`. `test/integration/migrations.spec.ts` runs the migration against an in-memory SQLite and verifies every table.
- **NFR-16 Branch coverage ≥ 85%.** Currently 85.35% branches / 97.36% statements / 95.57% functions / 98.68% lines. Jest threshold raised to `branches: 85, statements: 90, functions: 90, lines: 90`.
- **NFR-11 / NFR-13 Logging.** `nestjs-pino` is wired through `LoggerModule.forRoot` with a `mixin` that pulls `correlationId`/`tenantId`/`employeeId`/`actorRole` from AsyncLocalStorage on every log line, and a `redact` config that strips `req.body.note`, `req.body.name`, `req.body.email`, and any `*.email` / `*.name` / `*.note` field. `test/integration/logging.spec.ts` captures one request's logs to a writable stream and asserts both correlation propagation and PII redaction.
- **FR-23 dedicated e2e.** `test/e2e/fr23-post-commit-drift.spec.ts` arms the mock HCM `/admin/return-stale-on-success` toggle, approves a 5-day request, and asserts (a) request CONFIRMED, (b) `DriftEvent.kind = POST_COMMIT_DRIFT` row, (c) local cached balance snapped to the HCM-reported value. The emission was added to `RequestsService.approve`.
- **NFR-17 ESLint + Prettier.** `.eslintrc.cjs` enforces `no-restricted-imports` for `src/**/domain/**` (no `typeorm`, `axios`, `@nestjs/common`, `@nestjs/core`). `.prettierrc` with project conventions. `npm run lint` / `lint:fix` / `format` scripts. CI runs lint between install and test.
- **TRD §8.2 module layout.** Controllers split into `src/{balances,requests,reconciliation,health}/*.controller.ts`; entities colocated with their feature module. `src/controllers.ts` and `src/entities/index.ts` retained as re-export barrels for backwards compatibility.
- State machine 100% statements/branches (`src/requests/domain/request.state-machine.ts`).
- Nightly reconciler cron at 02:00 UTC (`src/reconciliation/reconciliation.cron.ts`, FR-15 / NFR-7) with unit test verifying registration and handler behaviour.
