# Technical Requirements Document — ReadyOn Time-Off Microservice

| Field            | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| **Document ID**  | TRD-READYON-TIMEOFF-001                                    |
| **Title**        | ReadyOn Time-Off Microservice — Balance & Sync             |
| **Version**      | 1.0                                                        |
| **Status**       | DRAFT — ready for review                                   |
| **Author**       | ReadyOn Platform Engineering                               |
| **Audience**     | Backend engineers, QA, SRE, Product, Engineering Manager   |
| **Last updated** | 2026-04-25                                                 |
| **Related**      | (PRD link TBD), HCM Integration Charter                    |

## Revision history

| Version | Date       | Author            | Change                                              |
| ------- | ---------- | ----------------- | --------------------------------------------------- |
| 0.1     | 2026-04-25 | Platform Eng      | Initial skeleton                                    |
| 0.5     | 2026-04-25 | Platform Eng      | FRs, NFRs, architecture, API drafted                |
| 1.0     | 2026-04-25 | Platform Eng      | Alternatives, test strategy, sequence diagrams done |

---

## Table of contents

1. [Overview](#1-overview)
2. [Business context & personas](#2-business-context--personas)
3. [Goals & non-goals](#3-goals--non-goals)
4. [Assumptions, constraints, dependencies](#4-assumptions-constraints-dependencies)
5. [Glossary](#5-glossary)
6. [Functional requirements](#6-functional-requirements)
7. [Non-functional requirements](#7-non-functional-requirements)
8. [Architecture & technical design](#8-architecture--technical-design)
9. [API contract](#9-api-contract)
10. [Sequence diagrams](#10-sequence-diagrams)
11. [Alternatives considered](#11-alternatives-considered)
12. [Test strategy](#12-test-strategy)
13. [Observability & operations](#13-observability--operations)
14. [Rollout & migration](#14-rollout--migration)
15. [Out of scope & future work](#15-out-of-scope--future-work)
16. [Appendix](#16-appendix)

---

## 1. Overview

### 1.1 Purpose
This document specifies the design and contract of the **ReadyOn Time-Off Microservice**: a backend service that lets employees request time off through ReadyOn while the customer's Human Capital Management (HCM) system (Workday, SAP SuccessFactors, BambooHR, etc.) remains the **system of record** for employment data and leave balances.

### 1.2 Scope
- Lifecycle management of time-off requests (submit → approve/reject → post to HCM → confirm).
- Balance read and projection per employee × location × leave type.
- Bi-directional synchronization with HCM via two channels: a **realtime per-record API** and a **batch full-corpus feed**.
- Drift detection, reconciliation, and audit.
- Defensive validation for the case where HCM **fails to reject** an invalid request that it should have rejected.

### 1.3 Document conventions
- Requirement IDs: `FR-NN` (functional), `NFR-NN` (non-functional). Each is testable and traces 1:1 to a named test case in §12.
- "MUST", "SHOULD", "MAY" follow RFC 2119.
- All times UTC unless otherwise noted.

---

## 2. Business context & personas

### 2.1 Problem
ReadyOn is the employee-facing front door for time-off; HCM is the source of truth. Two systems holding the same balance is structurally fragile:

- Employees lose trust when ReadyOn shows `8 days` and HCM shows `6`.
- HCM mutates **independently** of ReadyOn (anniversary bonuses, year-start refresh, manual HR adjustment, terminations). ReadyOn must accept those mutations gracefully.
- HCM's rejection of invalid requests is **best-effort, not guaranteed** — ReadyOn must validate defensively.
- HCM realtime calls are slow and can fail; UX must remain responsive.

### 2.2 Personas

| Persona      | Goal                                                              | Pain today                                              |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------- |
| **Employee** | See an accurate balance, get instant feedback on a request.       | Stale balances; surprise rejections after manager OK.   |
| **Manager**  | Approve requests with confidence the data is valid.               | Approving requests that later fail at HCM.              |
| **HR Admin** | Trust that HCM is the source of truth and drift is auditable.     | Silent drift, no audit trail.                           |
| **HCM (system)** | Receive valid leave deductions; push refreshes to ReadyOn.    | (n/a — system actor.)                                   |
| **SRE / On-call** | Diagnose sync failures quickly.                              | Opaque integration failures.                            |

---

## 3. Goals & non-goals

### 3.1 Goals
- G1 — Provide instant, optimistic feedback to employees on submit while HCM remains authoritative on commit.
- G2 — Maintain **eventual consistency** with HCM via realtime + batch sync; drift is detected and resolved automatically where safe.
- G3 — Defensive validation so an invalid request never silently consumes balance even if HCM accepts it by mistake.
- G4 — Full audit trail of every balance change (request-driven, HCM-driven, reconciliation-driven).
- G5 — Idempotent, retry-safe HCM integration.
- G6 — Schema-extensible to multi-tenant and multi-leave-type without API breakage.

### 3.2 Non-goals
- NG1 — Building or replacing the HCM itself.
- NG2 — A user-facing UI (this is a backend microservice; UI is consumed via REST).
- NG3 — Full multi-tenant isolation (per-tenant DB, per-tenant HCM credentials at rest with KMS) — schema-ready only; ops-grade tenancy is future work (§15).
- NG4 — Payroll integration, accruals computation, FMLA/legal-leave-type rules.
- NG5 — Manager hierarchy resolution (the approver is supplied by the caller).

---

## 4. Assumptions, constraints, dependencies

### 4.1 Assumptions
- HCM exposes:
  - **Realtime API**: read or write a single `(employeeId, locationId, leaveType)` balance.
  - **Batch endpoint**: pushes the whole corpus of balances to ReadyOn (full snapshot, not delta).
- Balances are quantified in **whole or fractional days** (`DECIMAL(6,2)`).
- The granularity of a balance key is `(tenantId, employeeId, locationId, leaveType)`. `leaveType` defaults to `PTO`.
- The HCM batch arrives at least daily; cadence is customer-configurable.
- An authenticated upstream (BFF / gateway) supplies `employeeId`, `tenantId`, and `actorRole` on each call. Auth is out of scope for this service — it trusts headers from the gateway.

### 4.2 Constraints
- Tech stack: **NestJS** (TypeScript), **SQLite** for persistence, **TypeORM** for ORM/migrations.
- Mock HCM is a separate NestJS app for tests and local dev.
- All external mutations must be idempotent.

### 4.3 Dependencies & SLAs

| Dependency      | Type             | SLA assumption                       | Failure mode handling                              |
| --------------- | ---------------- | ------------------------------------ | -------------------------------------------------- |
| HCM Realtime API| HTTP/JSON        | p95 < 800ms, 99% availability        | 2s timeout, 3 retries (250ms→1s→4s, jitter), then circuit-break for 30s |
| HCM Batch feed  | HTTP push (POST) | Daily, idempotent by `batchId`       | Reject duplicate `batchId`; quarantine malformed rows |
| Auth gateway    | Header trust     | Always present                       | 401 if `x-employee-id` / `x-tenant-id` missing     |

---

## 5. Glossary

| Term                | Definition                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| **HCM**             | Human Capital Management system. Authoritative source of truth for employment data and leave balance.  |
| **Balance**         | The number of leave days available to an `(employee, location, leaveType)` triple at a point in time.   |
| **Hold**            | A local, non-HCM-committed reservation against a balance for a request that is `SUBMITTED` or `APPROVED` but not yet posted to HCM. |
| **Ledger**          | Append-only log of balance-changing events (request, HCM push, reconciliation, anniversary bonus).      |
| **Drift**           | A delta between ReadyOn's cached balance and HCM's reported balance not explained by an in-flight ReadyOn request. |
| **Reconciliation**  | The process of comparing ReadyOn balances against HCM (realtime or batch), resolving deltas, and emitting `DriftEvent`s. |
| **Dimension**       | A key component of a balance lookup: `(tenantId, employeeId, locationId, leaveType)`.                   |
| **Idempotency key** | Client-supplied UUID on mutating endpoints that guarantees retry-safety inside a 24h window.            |
| **Tenant**          | A customer company. Single field on every row; full isolation is future work.                           |

---

## 6. Functional requirements

### 6.1 Balance read

- **FR-1** — The service MUST expose `GET /v1/employees/:employeeId/balances` returning all balances for the employee across all locations and leave types, including `available`, `pendingHold`, and `effective = available - pendingHold`.
- **FR-2** — The service MUST expose `GET /v1/employees/:employeeId/balances/:locationId/:leaveType` for a single dimension lookup.
- **FR-3** — Balance reads MUST serve from the local cached projection (not realtime HCM) and MUST include `lastSyncedAt` and `source` (`HCM_BATCH`, `HCM_REALTIME`, `RECONCILIATION`) on every response.
- **FR-4** — A query parameter `?refresh=true` MUST trigger a synchronous realtime HCM read before returning, refreshing the local projection.

### 6.2 Request lifecycle

- **FR-5** — `POST /v1/time-off-requests` MUST create a request in `SUBMITTED` state, apply a local `pendingHold` for the requested days, and pre-validate the requested days against the cached balance.
- **FR-6** — On submit, the service MUST perform a **defensive realtime HCM check** for the affected dimension; if the HCM-reported balance is lower than required, the request MUST be rejected with `INSUFFICIENT_BALANCE` and no hold persisted.
- **FR-7** — `POST /v1/time-off-requests/:id/approve` MUST transition `SUBMITTED → APPROVED`, then post the deduction to HCM. On HCM success, the request transitions to `CONFIRMED` and the hold is converted to a committed ledger entry. On HCM failure, the request transitions to `REJECTED_BY_HCM` and the hold is released.
- **FR-8** — `POST /v1/time-off-requests/:id/reject` MUST transition `SUBMITTED → REJECTED_BY_MANAGER` and release the hold without contacting HCM.
- **FR-9** — `POST /v1/time-off-requests/:id/cancel` MUST be allowed by the requesting employee in `SUBMITTED` (no HCM call needed) or by an admin in `CONFIRMED` (issues a compensating credit to HCM).
- **FR-10** — All state transitions MUST be enforced by an explicit state machine; any disallowed transition returns `409 Conflict` with `code = INVALID_TRANSITION`.
- **FR-11** — Every state transition MUST append a row to `request_audit` with `actor`, `from`, `to`, `reason`, `timestamp`.

### 6.3 HCM realtime sync

- **FR-12** — The service MUST be able to read a single balance from HCM (`GET /hcm/balances/...`) and write a deduction or credit (`POST /hcm/balances/.../adjust`).
- **FR-13** — Every HCM write MUST include the request's idempotency key; HCM responses MUST be persisted on `hcm_sync_events`.
- **FR-14** — HCM realtime calls MUST honour the timeout/retry/circuit-breaker policy in §4.3.
- **FR-15** — When the circuit is open, submit MUST still succeed (using cached balance + local hold) and the request enters a queue (`PENDING_HCM_POST`) drained by a background worker.

### 6.4 HCM batch reconciliation

- **FR-16** — `POST /v1/internal/hcm/batch-sync` MUST accept the full HCM corpus as `(employeeId, locationId, leaveType, balance, asOf)` rows tagged with a unique `batchId`.
- **FR-17** — The endpoint MUST be idempotent by `batchId`: duplicate batches are accepted and produce no changes.
- **FR-18** — Each row MUST be diffed against the local cached balance; mismatches outside an in-flight request's window MUST emit a `DriftEvent` and overwrite the cache (HCM wins).
- **FR-19** — A row whose new balance is lower than the sum of `pendingHold + committed` for an in-flight request MUST flag the request with `requires_review = true` and emit a `BalanceConflict` event for human review; the request is **not** auto-cancelled.
- **FR-20** — The reconciler MUST log per-row outcomes (`UNCHANGED`, `UPDATED`, `CONFLICT`, `MALFORMED`) and emit a batch summary.

### 6.5 Drift detection (realtime)

- **FR-21** — Whenever a realtime HCM read returns a balance that disagrees with the cache by more than `pendingHold`, a `DriftEvent` MUST be recorded and the cache updated.
- **FR-22** — `GET /v1/internal/drift-events` MUST return paginated drift history with filters by employee, time range, and resolution status.

### 6.6 Defensive validation

- **FR-23** — Even when HCM accepts a deduction, the service MUST re-check that the post-deduction local balance is non-negative and matches HCM's returned balance. Mismatch triggers a `DriftEvent` and an SRE alert.
- **FR-24** — Submitting against an unknown `(employeeId, locationId, leaveType)` MUST be rejected with `UNKNOWN_DIMENSION` regardless of HCM behaviour.
- **FR-25** — Negative-day or zero-day requests MUST be rejected with `INVALID_DURATION`.

### 6.7 Idempotency

- **FR-26** — All mutating endpoints MUST require an `Idempotency-Key` HTTP header (UUID v4).
- **FR-27** — A repeated key within 24 hours MUST return the original response without re-executing side effects.
- **FR-28** — Idempotency records MUST be scoped by `(tenantId, route, key)`.

### 6.8 Audit & history

- **FR-29** — Every balance change MUST produce an immutable `BalanceLedgerEntry` with `delta`, `reason`, `source`, `actor`, `requestId?`, `hcmEventId?`, `createdAt`.
- **FR-30** — `GET /v1/employees/:employeeId/ledger` MUST return paginated ledger entries with dimension filters.

---

## 7. Non-functional requirements

| ID      | Category         | Requirement                                                                                            |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| NFR-1   | Latency          | `GET /balances` p95 < 100ms (cached read).                                                             |
| NFR-2   | Latency          | `POST /time-off-requests` (submit, defensive HCM check) p95 < 1500ms; p99 < 3000ms.                    |
| NFR-3   | Latency          | `approve` endpoint p95 < 2000ms.                                                                       |
| NFR-4   | Throughput       | Service MUST sustain 50 req/s on a single instance for read; 20 req/s for write, on a 2 vCPU container. |
| NFR-5   | Reliability      | HCM client: 2s per-call timeout, 3 retries (exponential backoff 250ms / 1s / 4s with full jitter), 30s circuit-breaker after 50% failure rate over 20 calls. |
| NFR-6   | Reliability      | No double-deduction permitted under any retry path (idempotency-enforced).                             |
| NFR-7   | Consistency      | Local cache MUST converge to HCM within one batch cycle (default 24h) for non-active dimensions.       |
| NFR-8   | Consistency      | Active-dimension drift MUST be detected within one realtime call after the discrepancy.                |
| NFR-9   | Audit            | Ledger and drift events retained for 7 years (HR norm); never hard-deleted.                            |
| NFR-10  | Idempotency      | Idempotency window: 24 hours.                                                                          |
| NFR-11  | Observability    | Structured JSON logs with `correlationId`, `tenantId`, `employeeId`, `requestId` on every line.        |
| NFR-12  | Observability    | Metrics: `hcm_call_duration_seconds`, `hcm_call_failures_total`, `drift_events_total`, `request_state_transitions_total`. |
| NFR-13  | Security         | No PII in logs beyond IDs; balances OK; names/emails MUST be redacted.                                 |
| NFR-14  | Security         | All mutating endpoints require `Idempotency-Key` and gateway-injected identity headers.                |
| NFR-15  | Portability      | Service MUST run on SQLite in dev/test and be schema-compatible with Postgres (no SQLite-only types).  |
| NFR-16  | Testability      | Coverage targets: ≥ 90% statements, 100% on the request state machine and reconciler.                  |
| NFR-17  | Maintainability  | Domain layer (state machine, balance math) MUST be pure (no I/O) and unit-testable.                    |

---

## 8. Architecture & technical design

### 8.1 Component diagram

```
                ┌───────────────────────────────────────────┐
                │            ReadyOn API Gateway            │
                │ (auth, rate-limit, header injection)      │
                └──────────────────┬────────────────────────┘
                                   │  REST / JSON (FR-1..FR-30)
                                   ▼
   ┌───────────────────────────────────────────────────────────────┐
   │                  Time-Off Microservice (NestJS)               │
   │                                                               │
   │  ┌──────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
   │  │ Controllers  │→ │ Application svc │→ │  Domain layer    │  │
   │  │ (REST)       │  │ (use cases)     │  │  (state machine, │  │
   │  └──────────────┘  └─────────────────┘  │   balance math,  │  │
   │           │                ▲             │   pure)          │  │
   │           ▼                │             └──────────────────┘  │
   │  ┌──────────────┐   ┌──────┴──────────┐   ┌────────────────┐   │
   │  │ Idempotency  │   │ HCM Client      │   │ Repositories   │   │
   │  │ middleware   │   │ (timeout/retry/ │   │ (TypeORM)      │   │
   │  └──────────────┘   │  circuit-break) │   └───────┬────────┘   │
   │                     └──────┬──────────┘           │            │
   │                            │                      ▼            │
   │  ┌────────────────────┐    │              ┌────────────────┐   │
   │  │ Reconciler worker  │←───┘              │   SQLite DB    │   │
   │  │ (batch ingest +    │                   │   (TypeORM     │   │
   │  │  scheduled drift   │                   │   migrations)  │   │
   │  │  scan)             │                   └────────────────┘   │
   │  └────────────────────┘                                        │
   └────────────────┬──────────────────────────────────────────────┘
                    │  HTTP/JSON
                    ▼
   ┌────────────────────────────────────────────────┐
   │   Mock HCM (separate NestJS app, in tests)     │
   │   - Realtime GET/POST balances                 │
   │   - Batch push to /internal/hcm/batch-sync     │
   │   - Admin: anniversary bonus, force-reject,    │
   │     stale-on-success, latency, failure inject  │
   └────────────────────────────────────────────────┘
```

### 8.2 Module structure (NestJS)

```
src/
├── main.ts
├── app.module.ts
├── common/
│   ├── idempotency/        # middleware + repo
│   ├── correlation/        # async-local-storage correlation id
│   └── errors/             # standard error envelope
├── balances/
│   ├── balances.controller.ts
│   ├── balances.service.ts
│   ├── balance.entity.ts
│   ├── ledger-entry.entity.ts
│   └── balance-projection.service.ts
├── requests/
│   ├── requests.controller.ts
│   ├── requests.service.ts
│   ├── request.entity.ts
│   ├── request-audit.entity.ts
│   └── domain/
│       └── request.state-machine.ts   # pure
├── hcm/
│   ├── hcm.client.ts                  # http, retry, circuit breaker
│   ├── hcm.module.ts
│   └── dto/                           # contract types
├── reconciliation/
│   ├── reconciliation.controller.ts   # batch ingest
│   ├── reconciliation.service.ts
│   ├── drift-event.entity.ts
│   └── reconciler.worker.ts           # @Cron
└── health/
    └── health.controller.ts
```

### 8.3 ER diagram

```
┌──────────────┐     ┌─────────────────────┐
│  employees   │     │     balances        │
│──────────────│     │─────────────────────│
│ id (PK)      │1   *│ id (PK)             │
│ tenant_id    │─────│ tenant_id           │
│ external_id  │     │ employee_id (FK)    │
│ created_at   │     │ location_id         │
└──────────────┘     │ leave_type          │
                     │ available           │
                     │ pending_hold        │
                     │ last_synced_at      │
                     │ last_source         │
                     │ version (optimistic)│
                     │ UQ(tenant,emp,loc,t)│
                     └────────┬────────────┘
                              │1
                              │
                              │*
                     ┌────────▼─────────────┐         ┌──────────────────────┐
                     │ balance_ledger       │         │   leave_requests     │
                     │──────────────────────│         │──────────────────────│
                     │ id (PK)              │         │ id (PK, UUID)        │
                     │ balance_id (FK)      │         │ tenant_id            │
                     │ delta (DECIMAL)      │         │ employee_id (FK)     │
                     │ reason ENUM          │         │ location_id          │
                     │ source ENUM          │         │ leave_type           │
                     │ request_id (FK?)     │◄────────┤ start_date           │
                     │ hcm_event_id (FK?)   │         │ end_date             │
                     │ actor                │         │ days (DECIMAL)       │
                     │ created_at           │         │ state ENUM           │
                     └──────────────────────┘         │ requires_review BOOL │
                                                      │ idempotency_key      │
                                                      │ created_at           │
                                                      └────────┬─────────────┘
                                                               │1
                                                               │*
                                                      ┌────────▼─────────────┐
                                                      │ request_audit        │
                                                      │──────────────────────│
                                                      │ id (PK)              │
                                                      │ request_id (FK)      │
                                                      │ from_state, to_state │
                                                      │ actor, reason        │
                                                      │ created_at           │
                                                      └──────────────────────┘

┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│ hcm_sync_events      │  │ drift_events         │  │ idempotency_keys     │
│──────────────────────│  │──────────────────────│  │──────────────────────│
│ id (PK)              │  │ id (PK)              │  │ id (PK)              │
│ direction ENUM       │  │ balance_id (FK)      │  │ tenant_id            │
│ kind ENUM            │  │ local_value          │  │ route                │
│ payload_json         │  │ hcm_value            │  │ key                  │
│ http_status          │  │ delta                │  │ response_snapshot    │
│ idempotency_key      │  │ source ENUM          │  │ created_at           │
│ request_id (FK?)     │  │ resolution ENUM      │  │ expires_at           │
│ created_at           │  │ created_at           │  │ UQ(tenant,route,key) │
└──────────────────────┘  └──────────────────────┘  └──────────────────────┘

┌──────────────────────┐
│ hcm_batches          │
│──────────────────────│
│ id (PK)              │
│ batch_id (UNIQUE)    │
│ received_at          │
│ row_count            │
│ updated_count        │
│ conflict_count       │
│ status ENUM          │
└──────────────────────┘
```

### 8.4 Request state machine

```
       ┌─────────────────┐
       │     SUBMITTED   │ ◄── POST /time-off-requests (FR-5,6)
       └────────┬────────┘
                │ approve (manager)         reject (manager)
                ▼                          ────────────────┐
       ┌─────────────────┐                                  ▼
       │     APPROVED    │              ┌────────────────────────────┐
       └────────┬────────┘              │  REJECTED_BY_MANAGER       │
                │ post to HCM (FR-7)    └────────────────────────────┘
                ▼
       ┌────────┴───────────┐
       │  PENDING_HCM_POST  │  (set if circuit open; FR-15)
       └────────┬───────────┘
                │  HCM ack OK             HCM reject (insufficient/invalid)
                ▼                         ────────────────┐
       ┌─────────────────┐                                 ▼
       │    CONFIRMED    │              ┌────────────────────────────┐
       └────────┬────────┘              │     REJECTED_BY_HCM        │
                │ cancel (admin)        └────────────────────────────┘
                ▼
       ┌─────────────────┐
       │    CANCELLED    │  (compensating credit posted to HCM)
       └─────────────────┘

  Employee can cancel directly from SUBMITTED → CANCELLED (no HCM call).
  Any transition not on this diagram → 409 INVALID_TRANSITION (FR-10).
```

### 8.5 Balance computation model

We model each balance as a **materialised projection over an append-only ledger**:

```
available(b)    = Σ delta over balance_ledger where balance_id = b
pending_hold(b) = Σ days over leave_requests where state ∈ {SUBMITTED, APPROVED, PENDING_HCM_POST}
                                              and balance_id = b
effective(b)    = available(b) − pending_hold(b)
```

The `balances` table caches `available` and `pending_hold` for fast reads (NFR-1) and is rebuilt deterministically from the ledger on demand. **The ledger is the source of truth inside ReadyOn; HCM is the source of truth across systems.**

### 8.6 Sync strategy decision table

| Operation                              | Local cache role | HCM role          | Tie-breaker          | Notes                                                                |
| -------------------------------------- | ---------------- | ----------------- | -------------------- | -------------------------------------------------------------------- |
| `GET /balances` (default)              | **serves**       | not called        | n/a                  | NFR-1 latency.                                                       |
| `GET /balances?refresh=true`           | updated          | **read**          | HCM wins             | Emits `DriftEvent` if delta.                                         |
| `POST /time-off-requests` (submit)     | check + hold     | **read** (defensive) | HCM wins on read   | FR-6: realtime check before accepting hold.                          |
| `approve`                              | hold→commit      | **write**         | HCM wins on write   | FR-7: deduction posted; on failure, hold released.                   |
| Anniversary bonus (HCM-initiated)      | updated          | **write to us**   | HCM wins             | Arrives via batch or webhook; never blocked.                         |
| Year-start refresh (HCM-initiated)     | replaced         | **write to us**   | HCM wins             | Same as above.                                                       |
| `batch-sync` row vs in-flight request  | flagged          | seen              | **human review**     | FR-19: `requires_review = true`, no auto-cancel.                     |
| HCM accepts but balance disagrees      | updated + alert  | suspect           | HCM value cached, alert SRE | FR-23.                                                              |
| HCM unavailable on submit              | hold w/ degraded mode | n/a (circuit open) | accept locally   | FR-15; submit still works, request goes to `PENDING_HCM_POST`.       |

---

## 9. API contract

### 9.1 Conventions

- Base URL: `/v1` (public), `/v1/internal` (internal, require service-to-service token).
- Required headers on all calls: `x-tenant-id`, `x-employee-id` (caller), `x-actor-role` (`EMPLOYEE` | `MANAGER` | `ADMIN`).
- Required header on all mutations: `Idempotency-Key: <UUIDv4>`.
- Standard error envelope:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Requested 5d exceeds available 3d",
    "correlationId": "8b1...",
    "details": { "requested": 5, "available": 3 }
  }
}
```

### 9.2 Error codes

| HTTP | Code                    | Meaning                                                                  |
| ---- | ----------------------- | ------------------------------------------------------------------------ |
| 400  | `INVALID_DURATION`      | days ≤ 0 or fractional outside policy.                                   |
| 400  | `UNKNOWN_DIMENSION`     | `(employee, location, leaveType)` not present in HCM-synced corpus.      |
| 401  | `MISSING_IDENTITY`      | gateway headers missing.                                                 |
| 409  | `INVALID_TRANSITION`    | request state machine refused the transition.                            |
| 409  | `INSUFFICIENT_BALANCE`  | local or HCM balance insufficient.                                       |
| 409  | `IDEMPOTENCY_REPLAY_MISMATCH` | same key, different payload.                                       |
| 422  | `REJECTED_BY_HCM`       | HCM rejected the deduction (any reason).                                 |
| 503  | `HCM_UNAVAILABLE`       | circuit open and operation requires HCM.                                 |
| 500  | `INTERNAL`              | uncaught.                                                                |

### 9.3 Endpoints

#### 9.3.1 `GET /v1/employees/:employeeId/balances`

Response 200:
```json
{
  "employeeId": "EMP-123",
  "balances": [
    {
      "locationId": "US-NY",
      "leaveType": "PTO",
      "available": 12.0,
      "pendingHold": 2.0,
      "effective": 10.0,
      "lastSyncedAt": "2026-04-25T03:00:00Z",
      "source": "HCM_BATCH"
    }
  ]
}
```

#### 9.3.2 `GET /v1/employees/:employeeId/balances/:locationId/:leaveType?refresh=bool`

Same shape as one element above. `?refresh=true` triggers realtime HCM read (FR-4).

#### 9.3.3 `POST /v1/time-off-requests`

Request:
```json
{
  "employeeId": "EMP-123",
  "locationId": "US-NY",
  "leaveType": "PTO",
  "startDate": "2026-05-04",
  "endDate":   "2026-05-08",
  "days": 5,
  "note": "Family trip"
}
```

Response 201:
```json
{
  "id": "req_01H...",
  "state": "SUBMITTED",
  "hold": 5,
  "balanceAfterHold": 5,
  "createdAt": "2026-04-25T12:00:00Z"
}
```

Errors: `INVALID_DURATION`, `UNKNOWN_DIMENSION`, `INSUFFICIENT_BALANCE`, `HCM_UNAVAILABLE` (only if defensive read fails AND policy is strict).

#### 9.3.4 `POST /v1/time-off-requests/:id/approve`
Body: `{ "approverId": "MGR-9", "comment": "ok" }`. Response 200: full request including new state (`CONFIRMED` or `PENDING_HCM_POST` or `REJECTED_BY_HCM`).

#### 9.3.5 `POST /v1/time-off-requests/:id/reject`
Body: `{ "approverId": "MGR-9", "reason": "..." }`. Response 200, state=`REJECTED_BY_MANAGER`.

#### 9.3.6 `POST /v1/time-off-requests/:id/cancel`
Body: `{ "actorId": "...", "reason": "..." }`. Response 200, state=`CANCELLED`. If state was `CONFIRMED`, a compensating credit is posted to HCM and audited.

#### 9.3.7 `GET /v1/time-off-requests/:id`
Returns full request + audit trail.

#### 9.3.8 `GET /v1/employees/:employeeId/ledger?locationId=&leaveType=&page=&size=`
Paginated ledger entries.

#### 9.3.9 `POST /v1/internal/hcm/batch-sync`
Request:
```json
{
  "batchId": "BATCH-2026-04-25-01",
  "asOf":    "2026-04-25T02:00:00Z",
  "rows": [
    { "tenantId": "T1", "employeeId": "EMP-123", "locationId": "US-NY", "leaveType": "PTO", "balance": 12.0 }
  ]
}
```
Response 200:
```json
{
  "batchId": "BATCH-2026-04-25-01",
  "received": 1234,
  "unchanged": 1100,
  "updated": 130,
  "conflicts": 4,
  "malformed": 0,
  "duplicateOfBatch": null
}
```

#### 9.3.10 `POST /v1/internal/reconcile`
Body: `{ "scope": "ALL" | { "employeeId": "..." } }`. Triggers a realtime drift scan.

#### 9.3.11 `GET /v1/internal/drift-events?employeeId=&from=&to=&unresolved=true`
Paginated drift history.

#### 9.3.12 `GET /healthz`, `GET /readyz`, `GET /metrics` (Prometheus).

---

## 10. Sequence diagrams

### 10.1 Happy path: submit → approve → HCM confirms

```
Employee  Gateway  TimeOffSvc        SQLite       HCM
   │         │         │               │           │
   │  POST submit ──►  │               │           │
   │         │  ─────► │ check cache   │           │
   │         │         │ ◄──available  │           │
   │         │         │ defensive read───────────►│
   │         │         │ ◄────────────────balance  │
   │         │         │ insert request(SUBMITTED) │
   │         │         │ insert hold ──►           │
   │         │ ◄──201  │                           │
   │ ◄──201  │         │                           │
   │                                                │
Manager    POST approve ──►                         │
   │         │         │ state→APPROVED            │
   │         │         │ post deduction ──────────►│
   │         │         │ ◄────────────────── 200 OK│
   │         │         │ state→CONFIRMED           │
   │         │         │ ledger.delta = -5         │
   │         │         │ hold released              │
   │         │ ◄──200  │                           │
```

### 10.2 Approve fails — HCM rejects

```
Manager POST approve ──► TimeOffSvc
                          │ state→APPROVED
                          │ post deduction ─► HCM
                          │ ◄─ 409 INSUFFICIENT_BALANCE
                          │ state→REJECTED_BY_HCM
                          │ hold released
                          │ DriftEvent emitted (cache may have been stale)
                          │ realtime-refresh balance from HCM
                          ▼
                       cache updated, event audited
```

### 10.3 Anniversary bonus arrives mid-pending-request

```
HCM ──► POST /internal/hcm/batch-sync (or realtime push) ──► Reconciler
                                                               │
   Existing request REQ-1 SUBMITTED, hold = 5, prior cache = 6 │
   New HCM balance for that dimension = 16 (10-day bonus)      │
                                                               │
   diff = +10, no conflict (still ≥ pending_hold)              │
   ──► overwrite cache, ledger += +10 (reason=ANNIVERSARY,      │
       source=HCM_BATCH)                                       │
   ──► DriftEvent kind=BONUS, resolution=AUTO_APPLIED          │
   ──► REQ-1 unchanged, hold preserved                         │
```

### 10.4 Batch row would invalidate in-flight request

```
HCM batch row: balance = 1
Local: hold = 5 (REQ-2 SUBMITTED)
   diff would push effective negative
   ──► cache updated to 1 (HCM wins)
   ──► REQ-2.requires_review = true
   ──► BalanceConflict event for human review
   ──► REQ-2 NOT auto-cancelled (FR-19)
```

### 10.5 Defensive case — HCM accepts deduction but returns wrong post-balance

```
approve ──► TimeOffSvc ──► HCM POST adjust(-5) ──► 200 { balance: 7 }
            │
            │ Expected post-balance = 12 - 5 = 7  ✅ matches
            │
   Variant: HCM returns { balance: 99 } (clearly wrong)
            │ mismatch detected
            │ ──► CONFIRMED still set (HCM accepted)
            │ ──► DriftEvent kind=POST_COMMIT_DRIFT, severity=ALERT
            │ ──► SRE alert; cache set to HCM-reported value
            │ ──► next reconcile cycle re-checks
```

### 10.6 HCM unavailable on submit

```
submit ──► defensive read ──► HCM (timeout × 3) ──► circuit OPEN
        ──► policy check: degraded-mode allowed ──► YES
        ──► insert request state=SUBMITTED, hold applied
        ──► response 201 with header `x-degraded: hcm-unavailable`
        ──► later: PENDING_HCM_POST drained by worker on circuit close
```

---

## 11. Alternatives considered

For each major decision the alternatives, trade-offs, and choice are recorded. This section is the engineering-judgment proof.

### 11.1 Balance representation

| Option                              | Pros                                                                | Cons                                                                | Verdict |
| ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- | ------- |
| **A. Single mutable column** `balances.available` | simple, fast.                                          | no audit trail; concurrent updates lose history; can't reconstruct. | ✗       |
| **B. Pure event-sourced ledger, no cache** | full audit, deterministic.                                  | every read scans ledger; slow; SQLite group-by hot path.            | ✗       |
| **C. Append-only ledger + materialised cache** ✓ | full audit + fast reads; cache rebuildable from ledger; standard double-entry pattern. | two-write coordination (handled with a single transaction).  | **Chosen**. |

### 11.2 HCM commit timing

| Option                                | Pros                                                  | Cons                                                              | Verdict |
| ------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| **A. Commit on submit**               | simplest model.                                       | manager rejection requires compensating call; failed approves are common; bad UX. | ✗       |
| **B. Commit on approve, no pre-check** | least HCM traffic.                                   | employees submit doomed requests; only learn at approve.          | ✗       |
| **C. Defensive realtime read on submit + commit on approve** ✓ | UX-aware; HCM-authoritative; minimises wasted approvals. | extra HCM read on submit; mitigated by short timeout + circuit. | **Chosen**. |
| **D. Async post-approve commit**      | fastest approve UX.                                   | races, eventual-consistency surface area for managers; chosen as fallback under circuit-open via `PENDING_HCM_POST`. | partial — kept as degraded mode (FR-15). |

### 11.3 Concurrency control

| Option                          | Pros                                  | Cons                                                       | Verdict |
| ------------------------------- | ------------------------------------- | ---------------------------------------------------------- | ------- |
| **A. Pessimistic row lock**     | strong correctness.                   | SQLite-friendly only with full DB lock; throughput cliff.  | ✗       |
| **B. Optimistic concurrency** ✓ | scales, SQLite-friendly, retry-safe.  | requires version column + retry on `version_conflict`.     | **Chosen** (`balances.version` column). |

### 11.4 HCM-side mutation channel

| Option                               | Pros                                  | Cons                                                  | Verdict   |
| ------------------------------------ | ------------------------------------- | ----------------------------------------------------- | --------- |
| **A. Polling realtime per-employee** | works without HCM-side push.          | quadratic load; misses changes between polls.         | ✗         |
| **B. Webhook from HCM**              | low latency.                          | not all HCMs support; requires per-tenant config.     | future.   |
| **C. Daily batch (full corpus)** ✓   | guaranteed consistency boundary; matches stated HCM capability. | 24h drift window for non-active dimensions. | **Chosen** (NFR-7). |
| **D. Realtime read at point of use** ✓ | catches drift on the hot path.       | extra HCM call per submit/approve.                    | **Chosen as defensive complement** (FR-6, 21). |

### 11.5 Drift collision policy (HCM batch lowers balance below in-flight hold)

| Option                       | Pros                                       | Cons                                                       | Verdict |
| ---------------------------- | ------------------------------------------ | ---------------------------------------------------------- | ------- |
| **A. Auto-cancel request**   | fully automatic.                           | destroys legitimate manager intent; bad employee UX.       | ✗       |
| **B. Refuse the batch row**  | preserves request.                         | violates HCM-as-source-of-truth.                           | ✗       |
| **C. Apply HCM, flag for review** ✓ | preserves source-of-truth + employee intent; humans handle. | needs admin flow (out of this iteration's UI but covered by `requires_review` flag and event). | **Chosen** (FR-19). |

### 11.6 Tenancy

| Option                                | Pros                                | Cons                                          | Verdict |
| ------------------------------------- | ----------------------------------- | --------------------------------------------- | ------- |
| **A. Single-tenant only**             | simplest.                           | rebuild later for multi-tenant.               | ✗       |
| **B. Schema-ready, single-tenant ops** ✓ | cheap forward-compat.            | tenant isolation is logical, not physical.    | **Chosen**. |
| **C. Full multi-tenant now**          | future-proof.                       | scope balloon; per-tenant credentials, isolation, SLAs. | future. |

### 11.7 Idempotency storage

| Option                              | Pros                              | Cons                                | Verdict |
| ----------------------------------- | --------------------------------- | ----------------------------------- | ------- |
| **A. Header only, no storage**      | none.                             | fails the property entirely.        | ✗       |
| **B. In-memory cache (LRU)**        | fast.                             | lost on restart; not multi-instance. | ✗       |
| **C. SQLite table w/ TTL** ✓        | survives restart; portable.       | needs sweeper job.                  | **Chosen**. |

### 11.8 Database choice (constrained)

SQLite is mandated. Internal note: the schema is written without SQLite-specific types (`AUTOINCREMENT` is allowed, no JSON1 dependence) so a Postgres swap is mechanical — see NFR-15.

---

## 12. Test strategy

> The brief explicitly weights test rigor over code volume. Every requirement above has at least one named test case, mapped in §12.5.

### 12.1 Test pyramid

| Layer            | What                                                                            | Tooling                              |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| Unit             | Pure domain: state machine, balance math, idempotency key compare              | Jest                                 |
| Integration      | Service ↔ SQLite ↔ HCM client (against Mock HCM), via Nest `TestingModule`     | Jest + supertest + better-sqlite3    |
| Contract         | HCM client contract pinned by Mock HCM OpenAPI; consumer-driven (Pact-style)   | Jest snapshot + JSON-schema check    |
| E2E / scenario   | Full HTTP against the running service + running mock HCM                       | Jest + supertest + spawned HCM mock  |
| Chaos / property | Fuzz request lifecycle order; randomised drift injection                       | fast-check (property-based)          |
| Load (smoke)     | NFR-4 throughput sanity                                                        | autocannon                           |

### 12.2 Mock HCM design

A **separate NestJS app** (`mock-hcm/`) deployable as a long-running test fixture. Endpoints:

- `GET  /hcm/balances/:tenant/:emp/:loc/:type` — returns current balance.
- `POST /hcm/balances/:tenant/:emp/:loc/:type/adjust` — `{ delta, idempotencyKey }` → new balance.
- `POST /hcm/batch/push` — pushes corpus to ReadyOn.
- **Admin endpoints** (test-only):
  - `POST /admin/seed` — set initial balances.
  - `POST /admin/anniversary-bonus` — credit `+N` days.
  - `POST /admin/force-reject-next` — next adjust call returns `INSUFFICIENT`.
  - `POST /admin/return-stale-on-success` — next adjust returns wrong post-balance.
  - `POST /admin/inject-latency` — set artificial delay.
  - `POST /admin/inject-failure-rate` — % of calls that fail.
  - `POST /admin/break-circuit` — return 503 indefinitely.
  - `POST /admin/reset` — clear all of the above.

### 12.3 Test scenarios (named)

Each scenario name is also a Jest `describe`/`it` path.

#### Lifecycle
- `submit_happy_path_creates_hold_and_returns_201`
- `submit_zero_days_rejected_invalid_duration` — FR-25
- `submit_unknown_dimension_rejected` — FR-24
- `submit_when_local_cache_sufficient_but_hcm_low_rejects_insufficient` — FR-6 (defensive)
- `submit_when_hcm_unavailable_circuit_open_returns_201_degraded` — FR-15
- `approve_posts_to_hcm_and_confirms_request`
- `approve_when_hcm_rejects_transitions_to_rejected_by_hcm_and_releases_hold`
- `manager_reject_releases_hold_no_hcm_call`
- `employee_cancel_in_submitted_releases_hold`
- `admin_cancel_in_confirmed_posts_compensating_credit`
- `disallowed_transition_returns_409_invalid_transition` — FR-10

#### Idempotency
- `repeat_submit_same_idempotency_key_returns_original_response` — FR-26/27
- `repeat_submit_same_key_different_payload_returns_409_replay_mismatch`
- `idempotency_record_expires_after_24h` — NFR-10
- `hcm_call_retry_uses_same_idempotency_key_no_double_deduction` — NFR-6 / FR-13

#### HCM batch reconciliation
- `batch_with_no_changes_emits_zero_drift`
- `batch_lowers_balance_outside_hold_emits_drift_and_overwrites_cache` — FR-18
- `batch_lowers_balance_below_pending_hold_flags_request_for_review` — FR-19
- `duplicate_batch_id_is_idempotent` — FR-17
- `malformed_row_quarantined_others_processed` — FR-20

#### Drift & defensive
- `realtime_read_with_refresh_emits_drift_when_hcm_disagrees` — FR-21
- `hcm_accepts_but_returns_wrong_post_balance_emits_alert_and_caches_hcm_value` — FR-23
- `anniversary_bonus_during_pending_request_increments_cache_keeps_request` — Sequence 10.3

#### Concurrency
- `two_simultaneous_submits_on_same_balance_only_one_holds_full_amount` — optimistic lock (§11.3)
- `approve_race_with_batch_sync_does_not_double_deduct`

#### HCM client resilience
- `hcm_call_timeout_retries_with_backoff_then_circuit_opens` — NFR-5
- `circuit_resets_after_30s` — NFR-5
- `pending_hcm_post_queue_drained_when_circuit_closes` — FR-15

#### Property-based
- `for_any_sequence_of_lifecycle_events_invariants_hold`
  - Invariant I1: `available ≥ 0` after every committed event.
  - Invariant I2: `Σ ledger.delta == balances.available` (cache consistency).
  - Invariant I3: `pending_hold == Σ days of active requests`.
  - Invariant I4: terminal states never transition.
  - Invariant I5: every confirmed request has exactly one matching `hcm_sync_event` of kind `ADJUST_OK`.

### 12.4 Coverage targets (NFR-16)

- Statements ≥ 90%, branches ≥ 85%.
- 100% on `request.state-machine.ts`, `reconciliation.service.ts`, `hcm.client.ts`.
- `npm run test:cov` produces an HTML report committed in CI artifacts.

### 12.5 Requirement-to-test traceability

| Requirement | Test(s)                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| FR-1        | `get_balances_returns_all_dimensions`, `balance_response_includes_lastSyncedAt_and_source`  |
| FR-2        | `get_single_balance_by_dimension`                                                           |
| FR-3        | `balance_read_does_not_call_hcm_by_default`                                                 |
| FR-4        | `balance_read_with_refresh_calls_hcm_and_updates_cache`                                     |
| FR-5        | `submit_happy_path_creates_hold_and_returns_201`                                            |
| FR-6        | `submit_when_local_cache_sufficient_but_hcm_low_rejects_insufficient`                       |
| FR-7        | `approve_posts_to_hcm_and_confirms_request`, `approve_when_hcm_rejects...`                  |
| FR-8        | `manager_reject_releases_hold_no_hcm_call`                                                  |
| FR-9        | `employee_cancel...`, `admin_cancel_in_confirmed_posts_compensating_credit`                 |
| FR-10       | `disallowed_transition_returns_409_invalid_transition`                                      |
| FR-11       | `every_transition_writes_audit_row`                                                         |
| FR-12, 13   | `hcm_client_reads_and_writes_with_idempotency_key`                                          |
| FR-14       | `hcm_call_timeout_retries_with_backoff_then_circuit_opens`                                  |
| FR-15       | `submit_when_hcm_unavailable_circuit_open_returns_201_degraded`, `pending_hcm_post_queue_drained_when_circuit_closes` |
| FR-16, 17   | `duplicate_batch_id_is_idempotent`                                                          |
| FR-18       | `batch_lowers_balance_outside_hold_emits_drift_and_overwrites_cache`                        |
| FR-19       | `batch_lowers_balance_below_pending_hold_flags_request_for_review`                          |
| FR-20       | `malformed_row_quarantined_others_processed`                                                |
| FR-21       | `realtime_read_with_refresh_emits_drift_when_hcm_disagrees`                                 |
| FR-22       | `drift_events_endpoint_paginates_and_filters`                                               |
| FR-23       | `hcm_accepts_but_returns_wrong_post_balance_emits_alert_and_caches_hcm_value`               |
| FR-24       | `submit_unknown_dimension_rejected`                                                         |
| FR-25       | `submit_zero_days_rejected_invalid_duration`                                                |
| FR-26..28   | `repeat_submit_same_idempotency_key_returns_original_response`, …                           |
| FR-29       | property test I2                                                                            |
| FR-30       | `ledger_endpoint_paginates`                                                                 |
| NFR-1..4    | autocannon smoke test                                                                       |
| NFR-5       | `hcm_call_timeout_retries...`, `circuit_resets_after_30s`                                   |
| NFR-6       | `hcm_call_retry_uses_same_idempotency_key_no_double_deduction`                              |
| NFR-7,8     | scenario tests + property test convergence                                                  |
| NFR-9       | `ledger_entries_are_immutable_no_delete_route`                                              |
| NFR-10      | `idempotency_record_expires_after_24h`                                                      |
| NFR-11..14  | log-shape and metric-emission tests                                                         |
| NFR-15      | schema lint test (no SQLite-only types)                                                     |
| NFR-16      | CI coverage gate                                                                            |
| NFR-17      | domain layer has no DB / HTTP imports (lint rule)                                           |

### 12.6 CI gates

- All tests must pass.
- Coverage thresholds enforced (NFR-16).
- A schema-portability lint forbids SQLite-only column types (NFR-15).
- A dependency-graph lint forbids `domain/*` from importing `typeorm` or `axios` (NFR-17).

---

## 13. Observability & operations

### 13.1 Logging
Structured JSON via `pino`. Every line carries `correlationId`, `tenantId`, `employeeId`, and (where applicable) `requestId`, `idempotencyKey`. Names/emails are never logged (NFR-13).

### 13.2 Metrics (Prometheus)

| Metric                                  | Type      | Labels                              |
| --------------------------------------- | --------- | ----------------------------------- |
| `hcm_call_duration_seconds`             | histogram | `method`, `outcome`                 |
| `hcm_call_failures_total`               | counter   | `kind` (timeout/5xx/4xx)            |
| `hcm_circuit_state`                     | gauge     | (0 closed, 1 half-open, 2 open)     |
| `drift_events_total`                    | counter   | `kind`, `resolution`                |
| `request_state_transitions_total`       | counter   | `from`, `to`                        |
| `requests_pending_hcm_post`             | gauge     | —                                   |
| `idempotency_replays_total`             | counter   | `route`                             |

### 13.3 Health
- `/healthz` — process up.
- `/readyz` — DB reachable + last successful HCM ping (or circuit half-open) within 5 minutes.

### 13.4 Alerts (suggested)
- HCM call failure rate > 10% for 5 min.
- `requests_pending_hcm_post` > 50 for 10 min.
- `drift_events_total{kind="POST_COMMIT_DRIFT"}` > 0 in 5 min — page SRE.
- Reconciler last-success > 26h.

---

## 14. Rollout & migration

1. **Schema bootstrap** — TypeORM migrations run on boot in dev/test; production runs migrations as a separate job.
2. **Backfill** — first deployment seeds balances by ingesting an HCM batch (`/internal/hcm/batch-sync`) before traffic is enabled.
3. **Feature flag** — `timeoff.enabled` per tenant; off by default.
4. **Shadow mode (optional)** — for first tenant, route reads but mirror writes to a no-op HCM client to validate flows.
5. **Cutover** — flip flag; monitor metrics from §13.2 for 48h.
6. **Rollback** — DB is additive; rolling back the binary is sufficient. The ledger guarantees we can rebuild balance at any historical point.

---

## 15. Out of scope & future work

- Manager UI, employee mobile app.
- Multi-tenant operational isolation (per-tenant DB, per-tenant HCM credentials, per-tenant rate limits).
- Webhook-based HCM push (currently batch-only).
- Accruals computation (we consume balances, we don't compute them).
- FMLA, jury-duty, region-specific leave law.
- Manager-hierarchy resolution (caller supplies the approver).
- Admin UI for `requires_review` queue (the data and event are in place; UI is future).
- Per-leave-type policy (caps, blackout dates, min notice).

---

## 16. Appendix

### 16.1 Sample payloads

**Submit (201):**
```json
{
  "id": "req_01H8X2K3...",
  "employeeId": "EMP-123",
  "locationId": "US-NY",
  "leaveType": "PTO",
  "startDate": "2026-05-04",
  "endDate":   "2026-05-08",
  "days": 5,
  "state": "SUBMITTED",
  "hold": 5,
  "balanceAfterHold": 5,
  "createdAt": "2026-04-25T12:00:00Z",
  "audit": [
    { "from": null, "to": "SUBMITTED", "actor": "EMP-123", "at": "2026-04-25T12:00:00Z" }
  ]
}
```

**Drift event:**
```json
{
  "id": "drift_01H...",
  "employeeId": "EMP-123",
  "locationId": "US-NY",
  "leaveType": "PTO",
  "localValue": 12.0,
  "hcmValue":   16.0,
  "delta":       4.0,
  "kind": "BONUS",
  "source": "HCM_BATCH",
  "resolution": "AUTO_APPLIED",
  "createdAt": "2026-04-25T03:00:01Z"
}
```

**Batch summary:**
```json
{
  "batchId": "BATCH-2026-04-25-01",
  "received": 1234,
  "unchanged": 1100,
  "updated": 130,
  "conflicts": 4,
  "malformed": 0,
  "duplicateOfBatch": null
}
```

### 16.2 State machine — formal table

| From               | Event              | Guard                              | To                  | Side effects                                     |
| ------------------ | ------------------ | ---------------------------------- | ------------------- | ------------------------------------------------ |
| (none)             | submit             | local + HCM balance ≥ days         | SUBMITTED           | hold +days, audit                                |
| SUBMITTED          | approve            | actor = MANAGER                    | APPROVED            | audit                                            |
| APPROVED           | hcm.ack            | HCM 200                            | CONFIRMED           | ledger -days, hold -days, audit                  |
| APPROVED           | hcm.reject         | HCM 4xx                            | REJECTED_BY_HCM     | hold -days, audit, drift refresh                 |
| APPROVED           | hcm.unavailable    | circuit open                       | PENDING_HCM_POST    | enqueue, audit                                   |
| PENDING_HCM_POST   | hcm.ack            | retry succeeded                    | CONFIRMED           | ledger -days, hold -days, audit                  |
| PENDING_HCM_POST   | hcm.reject         | retry rejected                     | REJECTED_BY_HCM     | hold -days, audit                                |
| SUBMITTED          | reject             | actor = MANAGER                    | REJECTED_BY_MANAGER | hold -days, audit                                |
| SUBMITTED          | cancel             | actor = EMPLOYEE (owner)           | CANCELLED           | hold -days, audit                                |
| CONFIRMED          | cancel             | actor = ADMIN                      | CANCELLED           | ledger +days (compensating), HCM credit, audit   |
| any terminal       | *                  | —                                  | 409                 | INVALID_TRANSITION                               |

### 16.3 Error code → HTTP map (consolidated)

(see §9.2)

### 16.4 Repository layout (planned)

```
.
├── README.md
├── docs/
│   └── TRD-READYON-TIMEOFF-001.md          (this file)
├── package.json
├── tsconfig.json
├── nest-cli.json
├── src/                                    (see §8.2)
├── test/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── property/
├── mock-hcm/
│   ├── src/
│   └── package.json
└── .github/workflows/ci.yml
```

— end of document —
