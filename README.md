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
