# ReadyOn Time-Off Microservice

Backend microservice that manages employee time-off requests while keeping
balances in sync with an external HCM (Workday / SAP / BambooHR style).
**HCM is the source of truth**; ReadyOn keeps an instant, audit-friendly local
projection.

> Full design lives in [`docs/TRD-READYON-TIMEOFF-001.md`](docs/TRD-READYON-TIMEOFF-001.md). Every line of code traces to a requirement ID (FR-NN / NFR-NN) in that document.

---

## Quick numbers

| | |
|---|---|
| Tests | **87 / 87 passing** across 14 suites |
| Statements | 97.36% |
| Branches | 85.35% |
| Lint | clean |
| End-to-end smoke-tested | ✅ |

See [`COVERAGE.md`](COVERAGE.md) for the per-file breakdown.

---

## Prerequisites

- **Node 20.x** (Node 18 also works)
- **npm 10+**
- Windows / macOS / Linux. SQLite is bundled via `better-sqlite3` — no separate install.

```bash
node --version   # v20.x
npm --version    # 10.x
```

---

## Install & build

```bash
npm install
npm run build
```

Produces `dist/src/main.js` (the service) and `dist/mock-hcm/src/main.js` (the mock HCM).

---

## Run it (two terminals)

The service talks to an HCM. For local dev we run the included **Mock HCM** as that backend.

**Terminal 1 — Mock HCM:**
```bash
PORT=3001 npm run start:mock
```
You should see Nest map a few `/hcm/*` and `/admin/*` routes on port 3001.

**Terminal 2 — Time-Off service:**
```bash
HCM_BASE_URL=http://localhost:3001 PORT=3000 npm start
```
You should see Nest map `/v1/employees/*`, `/v1/time-off-requests/*`,
`/v1/internal/*`, `/healthz`, `/readyz`, `/metrics` on port 3000.

> **Windows PowerShell:** prefix env vars differently:
> `$env:PORT=3001; npm run start:mock`
> `$env:HCM_BASE_URL='http://localhost:3001'; $env:PORT=3000; npm start`

---

## Five-minute walkthrough (copy-paste)

The service trusts gateway-injected identity headers. On every request:

```
x-tenant-id:    T1
x-employee-id:  EMP-1
x-actor-role:   EMPLOYEE | MANAGER | ADMIN
```

Mutating endpoints additionally require `Idempotency-Key: <uuid>`.

### 1. Seed a balance in the mock HCM
```bash
curl -X POST http://localhost:3001/admin/seed \
  -H "content-type: application/json" \
  -d '{"rows":[{"tenantId":"T1","employeeId":"EMP-1","locationId":"US-NY","leaveType":"PTO","balance":12}]}'
```

### 2. Push the HCM corpus into ReadyOn
```bash
curl -X POST http://localhost:3000/v1/internal/hcm/batch-sync \
  -H "content-type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "x-tenant-id: T1" -H "x-employee-id: SYS" -H "x-actor-role: ADMIN" \
  -d '{"batchId":"B-1","asOf":"2026-04-25T00:00:00Z","rows":[
        {"tenantId":"T1","employeeId":"EMP-1","locationId":"US-NY","leaveType":"PTO","balance":12}
      ]}'
# → {"batchId":"B-1","received":1,"unchanged":0,"updated":1,"conflicts":0,...}
```

### 3. Read the employee's balance
```bash
curl http://localhost:3000/v1/employees/EMP-1/balances \
  -H "x-tenant-id: T1" -H "x-employee-id: EMP-1" -H "x-actor-role: EMPLOYEE"
# → available 12, pendingHold 0, effective 12
```

### 4. Submit a time-off request (employee)
```bash
curl -X POST http://localhost:3000/v1/time-off-requests \
  -H "content-type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "x-tenant-id: T1" -H "x-employee-id: EMP-1" -H "x-actor-role: EMPLOYEE" \
  -d '{"employeeId":"EMP-1","locationId":"US-NY","leaveType":"PTO",
       "startDate":"2026-05-04","endDate":"2026-05-08","days":5}'
# → {"id":"<REQ_ID>","state":"SUBMITTED","hold":5,"balanceAfterHold":7,...}
```
Save the `id`, e.g. `REQ=<paste-id>`.

### 5. Manager approves (posts deduction to HCM)
```bash
curl -X POST http://localhost:3000/v1/time-off-requests/$REQ/approve \
  -H "content-type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "x-tenant-id: T1" -H "x-employee-id: MGR-9" -H "x-actor-role: MANAGER" \
  -d '{"approverId":"MGR-9","comment":"ok"}'
# → state CONFIRMED, ledger -5, hold released, HCM balance now 7
```

### 6. Re-read the balance
```bash
curl http://localhost:3000/v1/employees/EMP-1/balances \
  -H "x-tenant-id: T1" -H "x-employee-id: EMP-1" -H "x-actor-role: EMPLOYEE"
# → available 7, pendingHold 0, effective 7
```

---

## Try the chaos buttons (Mock HCM admin)

The mock HCM exposes admin endpoints to simulate real-world badness:

| Endpoint | What it does |
|---|---|
| `POST /admin/anniversary-bonus` `{tenantId, employeeId, locationId, leaveType, days}` | Adds days to HCM (simulates work-anniversary bonus) |
| `POST /admin/force-reject-next` | Next adjust call returns `INSUFFICIENT_BALANCE` |
| `POST /admin/return-stale-on-success` | Next adjust succeeds but returns wrong post-balance (FR-23 case) |
| `POST /admin/inject-latency` `{ms}` | Slows every call |
| `POST /admin/inject-failure-rate` `{rate}` | % of calls fail |
| `POST /admin/break-circuit` | Always 503 — exercises circuit breaker / degraded mode |
| `POST /admin/reset` | Clear all overrides |

Example — make HCM reject the next deduction:
```bash
curl -X POST http://localhost:3001/admin/force-reject-next
# now the next /approve will transition the request to REJECTED_BY_HCM
```

---

## API surface (cheat sheet)

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/employees/:id/balances` | All balances for an employee |
| GET | `/v1/employees/:id/balances/:loc/:type?refresh=true` | Single balance, optional realtime HCM refresh |
| POST | `/v1/time-off-requests` | Submit |
| POST | `/v1/time-off-requests/:id/approve` | Manager approve |
| POST | `/v1/time-off-requests/:id/reject` | Manager reject |
| POST | `/v1/time-off-requests/:id/cancel` | Employee or admin cancel |
| GET | `/v1/time-off-requests/:id` | Full request + audit |
| GET | `/v1/employees/:id/ledger` | Append-only ledger |
| POST | `/v1/internal/hcm/batch-sync` | HCM pushes full corpus |
| GET | `/v1/internal/drift-events` | Drift history |
| POST | `/v1/internal/drain-pending` | Drain `PENDING_HCM_POST` queue |
| GET | `/healthz` `/readyz` `/metrics` | Ops |

Full request/response shapes and error codes: TRD §9.

---

## Test it

```bash
npm test            # 87 tests across unit / integration / e2e / property
npm run test:cov    # writes coverage/lcov-report/index.html
npm run lint        # eslint, clean
```

Layers:
- `test/unit/` — pure domain (state machine, balance math, circuit breaker, domain purity)
- `test/integration/` — service ↔ SQLite ↔ in-process Mock HCM (logging, migrations, balances)
- `test/e2e/` — full HTTP via supertest (lifecycle, reconciliation, hcm-resilience, FR-23)
- `test/property/` — `fast-check` invariants I1–I5

---

## Database

- **SQLite** via `better-sqlite3`. Default DB file: `./data/timeoff.sqlite` (created on first run).
- Schema is created by an explicit migration: `src/migrations/0001-initial-schema.ts`.
- Production data source has `synchronize: false`.

```bash
npm run migration:run       # apply migrations
npm run migration:revert    # roll back last migration
npm run migration:generate  # diff entities → new migration
```

Schema is portable — no SQLite-only types — so a Postgres swap is mechanical.

---

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Service port |
| `HCM_BASE_URL` | `http://localhost:3001` | Mock or real HCM base URL |
| `DB_PATH` | `./data/timeoff.sqlite` | SQLite file |
| `LOG_LEVEL` | `info` | pino level |

---

## Repository layout

```
.
├── docs/TRD-READYON-TIMEOFF-001.md   # the contract
├── src/                              # Time-Off service (NestJS)
│   ├── balances/                     # controller, service, entities, balance.math
│   ├── requests/                     # controller, service, entities, state-machine (pure)
│   ├── reconciliation/               # batch ingest + nightly cron + drift events
│   ├── hcm/                          # HTTP client w/ retry + circuit breaker
│   ├── common/                       # idempotency, correlation, error envelope
│   ├── health/                       # /healthz /readyz /metrics
│   ├── migrations/                   # explicit TypeORM migrations
│   └── data-source.ts                # CLI data source for migrations
├── mock-hcm/src/                     # standalone Mock HCM (NestJS)
├── test/{unit,integration,e2e,property}/
├── COVERAGE.md
└── .github/workflows/ci.yml          # install → lint → test → coverage gate
```

---

## Key design decisions (TL;DR — full rationale in TRD §11)

- **Append-only ledger + materialised cache.** Audit + speed.
- **Defensive realtime HCM read on submit; HCM commit on manager approve.** Instant UX, HCM stays authoritative on commit.
- **Optimistic concurrency** on `balances.version`.
- **Daily batch reconciliation; HCM wins outside in-flight holds.** Conflicts inside a hold flag `requires_review = true` rather than auto-cancel.
- **Idempotency-Key required on every mutation, 24h SQLite-backed window.**
- **Circuit breaker + `PENDING_HCM_POST` queue + nightly drain cron.** Submits work when HCM is down.
- **Schema-ready multi-tenancy + multi-leave-type.**

---

## Deviations from TRD

**None outstanding.** All targets met:
- Coverage ≥ 90% statements / ≥ 85% branches.
- 100% on state machine, balance math, reconciliation cron, migration.
- Real migrations (no `synchronize` in prod).
- nestjs-pino logging with ALS correlation + PII redaction.
- ESLint + Prettier with domain import boundaries.
- Per-feature module layout matches TRD §8.2.
- FR-23 dedicated e2e test.

---

## Where to look first

1. [`docs/TRD-READYON-TIMEOFF-001.md`](docs/TRD-READYON-TIMEOFF-001.md) — the design contract.
2. [`COVERAGE.md`](COVERAGE.md) — proof of test coverage.
3. `src/requests/domain/request.state-machine.ts` — pure state machine (100% covered).
4. `src/hcm/hcm.client.ts` — retry + circuit breaker.
5. `src/reconciliation/reconciliation.service.ts` — drift + conflict detection.
6. `test/property/invariants.spec.ts` — the invariants that must always hold (I1–I5).
