import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema (NFR-15).
 *
 * Mirrors what TypeORM's synchronize would emit for the entities defined in
 * src/entities/index.ts. SQLite dialect; portable to Postgres with minimal
 * dialect-specific tweaks (decimal precision, datetime types).
 */
export class InitialSchema1700000000001 implements MigrationInterface {
  name = 'InitialSchema1700000000001';

  public async up(qr: QueryRunner): Promise<void> {
    await qr.query(`
      CREATE TABLE "balances" (
        "id" varchar PRIMARY KEY NOT NULL,
        "tenantId" varchar NOT NULL,
        "employeeId" varchar NOT NULL,
        "locationId" varchar NOT NULL,
        "leaveType" varchar NOT NULL,
        "available" decimal(10,2) NOT NULL DEFAULT (0),
        "pendingHold" decimal(10,2) NOT NULL DEFAULT (0),
        "lastSyncedAt" datetime,
        "lastSource" varchar NOT NULL DEFAULT ('LOCAL'),
        "version" integer NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        CONSTRAINT "UQ_balances_dim" UNIQUE ("tenantId", "employeeId", "locationId", "leaveType")
      )
    `);
    await qr.query(`CREATE INDEX "IDX_balances_tenantId" ON "balances" ("tenantId")`);
    await qr.query(`CREATE INDEX "IDX_balances_employeeId" ON "balances" ("employeeId")`);

    await qr.query(`
      CREATE TABLE "balance_ledger" (
        "id" varchar PRIMARY KEY NOT NULL,
        "balanceId" varchar NOT NULL,
        "delta" decimal(10,2) NOT NULL,
        "reason" varchar NOT NULL,
        "source" varchar NOT NULL,
        "requestId" varchar,
        "hcmEventId" varchar,
        "actor" varchar NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await qr.query(`CREATE INDEX "IDX_ledger_balanceId" ON "balance_ledger" ("balanceId")`);
    await qr.query(`CREATE INDEX "IDX_ledger_createdAt" ON "balance_ledger" ("createdAt")`);

    await qr.query(`
      CREATE TABLE "leave_requests" (
        "id" varchar PRIMARY KEY NOT NULL,
        "tenantId" varchar NOT NULL,
        "employeeId" varchar NOT NULL,
        "locationId" varchar NOT NULL,
        "leaveType" varchar NOT NULL,
        "startDate" varchar NOT NULL,
        "endDate" varchar NOT NULL,
        "days" decimal(6,2) NOT NULL,
        "state" varchar NOT NULL,
        "requiresReview" boolean NOT NULL DEFAULT (0),
        "idempotencyKey" varchar NOT NULL,
        "note" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await qr.query(`CREATE INDEX "IDX_req_tenantId" ON "leave_requests" ("tenantId")`);
    await qr.query(`CREATE INDEX "IDX_req_employeeId" ON "leave_requests" ("employeeId")`);
    await qr.query(`CREATE INDEX "IDX_req_state" ON "leave_requests" ("state")`);

    await qr.query(`
      CREATE TABLE "request_audit" (
        "id" varchar PRIMARY KEY NOT NULL,
        "requestId" varchar NOT NULL,
        "fromState" varchar,
        "toState" varchar NOT NULL,
        "actor" varchar NOT NULL,
        "reason" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await qr.query(`CREATE INDEX "IDX_audit_requestId" ON "request_audit" ("requestId")`);

    await qr.query(`
      CREATE TABLE "hcm_sync_events" (
        "id" varchar PRIMARY KEY NOT NULL,
        "direction" varchar NOT NULL,
        "kind" varchar NOT NULL,
        "payloadJson" text NOT NULL,
        "httpStatus" integer,
        "idempotencyKey" varchar,
        "requestId" varchar,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await qr.query(`
      CREATE TABLE "drift_events" (
        "id" varchar PRIMARY KEY NOT NULL,
        "balanceId" varchar,
        "employeeId" varchar NOT NULL,
        "locationId" varchar NOT NULL,
        "leaveType" varchar NOT NULL,
        "localValue" decimal(10,2) NOT NULL,
        "hcmValue" decimal(10,2) NOT NULL,
        "delta" decimal(10,2) NOT NULL,
        "kind" varchar NOT NULL,
        "source" varchar NOT NULL,
        "resolution" varchar NOT NULL,
        "resolved" boolean NOT NULL DEFAULT (0),
        "createdAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);
    await qr.query(`CREATE INDEX "IDX_drift_createdAt" ON "drift_events" ("createdAt")`);

    await qr.query(`
      CREATE TABLE "idempotency_keys" (
        "id" varchar PRIMARY KEY NOT NULL,
        "tenantId" varchar NOT NULL,
        "route" varchar NOT NULL,
        "key" varchar NOT NULL,
        "payloadHash" text NOT NULL,
        "responseSnapshot" text NOT NULL,
        "statusCode" integer NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
        "expiresAt" datetime NOT NULL,
        CONSTRAINT "UQ_idem" UNIQUE ("tenantId", "route", "key")
      )
    `);

    await qr.query(`
      CREATE TABLE "hcm_batches" (
        "id" varchar PRIMARY KEY NOT NULL,
        "batchId" varchar NOT NULL,
        "receivedAt" datetime NOT NULL DEFAULT (datetime('now')),
        "rowCount" integer NOT NULL,
        "updatedCount" integer NOT NULL,
        "conflictCount" integer NOT NULL,
        "unchangedCount" integer NOT NULL,
        "malformedCount" integer NOT NULL,
        "status" varchar NOT NULL,
        "summaryJson" text NOT NULL,
        CONSTRAINT "UQ_hcm_batches_batchId" UNIQUE ("batchId")
      )
    `);
  }

  public async down(qr: QueryRunner): Promise<void> {
    await qr.query(`DROP TABLE "hcm_batches"`);
    await qr.query(`DROP TABLE "idempotency_keys"`);
    await qr.query(`DROP TABLE "drift_events"`);
    await qr.query(`DROP TABLE "hcm_sync_events"`);
    await qr.query(`DROP TABLE "request_audit"`);
    await qr.query(`DROP TABLE "leave_requests"`);
    await qr.query(`DROP TABLE "balance_ledger"`);
    await qr.query(`DROP TABLE "balances"`);
  }
}
