import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import * as currentPg from "@xonava/adapters/drizzle-pg"
import * as previousPg from "xonava-adapters-prev/drizzle-pg"
import { readPostgresMigration } from "../../fixtures/postgres/bootstrap.js"
import { POSTGRES_FIXTURE_MIGRATIONS } from "../../fixtures/postgres/schema.js"
import { pgCertificationUrl } from "../pg/database.js"
import { defineIdempotencyUpgrade, defineJobUpgrade, defineOutboxUpgrade, defineWorkflowUpgrade, type ReleaseStores, type UpgradeDriver } from "./durableStores.js"
import type { Release } from "./releases.js"

// Own schema: other suites use the same server concurrently. The workflow tables come from the fixture migrations re-targeted at it.
const SCHEMA = "upgrade_compat"
const s = pgSchema(SCHEMA)
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })
const jobs = s.table("jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"),
  payload: text("payload"), status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"),
  runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"), leaseOwner: text("lease_owner"), leaseExpiresAt: ts("lease_expires_at"), claimToken: text("claim_token"),
  idempotencyKey: text("idempotency_key"), idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"),
  lastError: text("last_error"), resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"),
  completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const execs = s.table("job_executions", {
  id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"),
  errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at"),
})
const idempotency = s.table("idempotency", {
  id: text("id").notNull(), scope: text("scope").notNull(), key: text("key").notNull(), fingerprint: text("fingerprint").notNull(),
  token: text("token").notNull(), status: text("status").notNull(), result: text("result"), resourceEntity: text("resource_entity"),
  resourceId: text("resource_id"), resourceVersion: text("resource_version"), pendingInvalidations: text("pending_invalidations"),
  finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"),
  finalizerClaimExpiresAt: ts("finalizer_claim_expires_at"), createdAt: ts("created_at").notNull(), completedAt: ts("completed_at"),
})
const outbox = s.table("outbox_events", {
  id: text("id").primaryKey(), tenantId: text("tenant_id"), idempotencyScope: text("idempotency_scope").notNull(), idempotencyKey: text("idempotency_key").notNull(),
  eventFingerprint: text("event_fingerprint").notNull(), eventType: text("event_type").notNull(), eventVersion: integer("event_version").notNull(),
  aggregateType: text("aggregate_type").notNull(), aggregateId: text("aggregate_id").notNull(), payload: jsonb("payload").notNull(), occurredAt: ts("occurred_at").notNull(),
})

const DDL = `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.jobs(id text primary key, job_type text, job_version int, tenant_id text, scope text, scope_key text, payload text, status text, priority int, attempts int NOT NULL, max_attempts int NOT NULL, run_at timestamptz, next_attempt_at timestamptz, lease_owner text, lease_expires_at timestamptz, claim_token text, idempotency_key text, idempotency_scope text, fingerprint text, correlation_id text, last_error text, result_payload text, metadata text, created_at timestamptz, started_at timestamptz, completed_at timestamptz, partition_key text, UNIQUE(idempotency_scope, idempotency_key));
CREATE TABLE ${SCHEMA}.job_executions(id text primary key, job_id text not null, attempt int not null, worker_id text not null, status text not null, error_message text, started_at timestamptz not null, finished_at timestamptz not null);
CREATE TABLE ${SCHEMA}.idempotency (id text NOT NULL, scope text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, token text NOT NULL, status text NOT NULL, result text, resource_entity text, resource_id text, resource_version text, pending_invalidations text, finalizer_claim_owner text, finalizer_claim_token text, finalizer_claim_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE (scope, key));
CREATE TABLE ${SCHEMA}.outbox_events (id text PRIMARY KEY, tenant_id text, idempotency_scope text NOT NULL, idempotency_key text NOT NULL, event_fingerprint text NOT NULL, event_type text NOT NULL, event_version integer NOT NULL, aggregate_type text NOT NULL, aggregate_id text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL, UNIQUE (idempotency_scope, idempotency_key));`

type TransactionRunner = { runInTransaction(work: (transaction: never) => Promise<void>): Promise<void> }

const mapRecord = (record: { type: string; version: number; aggregateType: string; aggregateId: string; payload: unknown; occurredAt: Date }) => ({
  eventType: record.type, eventVersion: record.version, aggregateType: record.aggregateType, aggregateId: record.aggregateId, payload: record.payload, occurredAt: record.occurredAt,
})



describe("PostgreSQL N-1 upgrade compatibility", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 8 })
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Record<string, unknown>[]

  function storesFor(module: typeof currentPg | typeof previousPg): ReleaseStores {
    const db = drizzle(pool)
    const idempotencyStore = module.createDrizzlePgIdempotencyStore<unknown>(db as never, idempotency as never)
    const provider = module.createDrizzlePersistenceProvider({ db, registry: { get: () => undefined } as never } as never) as unknown as TransactionRunner
    return {
      jobs: module.createDrizzleJobStore(module.createPgSession(db as never) as never, { jobsTable: jobs, executionsTable: execs, executionHistory: "best_effort", columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } } as never) as never,
      workflows: new module.DrizzlePgWorkflowStore(pool as never, { schema: SCHEMA }) as never,
      outbox: new module.DrizzleOutboxSink(db as never, outbox as never, mapRecord as never) as never,
      idempotency: idempotencyStore as never,
      commit: async (item) => { await provider.runInTransaction((transaction) => idempotencyStore.markCommittedInTransaction(item as never, transaction)) },
    }
  }

  const driver: UpgradeDriver = {
    label: "postgres",
    stores: (release: Release) => storesFor(release === "current" ? currentPg : previousPg),
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.job_executions, ${SCHEMA}.jobs, ${SCHEMA}.idempotency, ${SCHEMA}.outbox_events, ${SCHEMA}.workflow_signals, ${SCHEMA}.workflows CASCADE`) },
    jobRow: async (jobId) => {
      const [row] = await q(`SELECT fingerprint, scope, tenant_id, scope_key FROM ${SCHEMA}.jobs WHERE id = $1`, [jobId])
      return { fingerprint: (row!.fingerprint ?? null) as string | null, scope: row!.scope as string, tenantId: (row!.tenant_id ?? null) as string | null, scopeKey: (row!.scope_key ?? null) as string | null }
    },
    setJobFingerprint: async (jobId, fingerprint) => { await pool.query(`UPDATE ${SCHEMA}.jobs SET fingerprint = $1 WHERE id = $2`, [fingerprint, jobId]) },
    outboxRows: async (scopeId, key) => (await q(`SELECT event_fingerprint FROM ${SCHEMA}.outbox_events WHERE idempotency_scope = $1 AND idempotency_key = $2`, [scopeId, key])).map((row) => ({ fingerprint: row.event_fingerprint as string })),
    setOutboxFingerprint: async (scopeId, key, fingerprint) => { await pool.query(`UPDATE ${SCHEMA}.outbox_events SET event_fingerprint = $1 WHERE idempotency_scope = $2 AND idempotency_key = $3`, [fingerprint, scopeId, key]) },
    resumeSignalId: async (instanceId) => ((await q(`SELECT resume_signal_id FROM ${SCHEMA}.workflows WHERE id = $1`, [instanceId]))[0]?.resume_signal_id ?? null) as string | null,
    setResumeSignalId: async (instanceId, value) => { await pool.query(`UPDATE ${SCHEMA}.workflows SET resume_signal_id = $1 WHERE id = $2`, [value, instanceId]) },
  }

  beforeAll(async () => {
    await pool.query(DDL)
    for (const name of POSTGRES_FIXTURE_MIGRATIONS) await pool.query(await readPostgresMigration(name, SCHEMA))
  })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineJobUpgrade(driver)
  defineWorkflowUpgrade(driver)
  defineOutboxUpgrade(driver)
  defineIdempotencyUpgrade(driver)
})
