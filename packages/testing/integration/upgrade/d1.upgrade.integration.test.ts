import { afterAll, beforeAll } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as currentD1 from "@xonava/adapters/drizzle-d1"
import * as previousD1 from "xonava-adapters-prev/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "../d1/database.js"
import { defineIdempotencyUpgrade, defineJobUpgrade, defineOutboxUpgrade, defineWorkflowUpgrade, type ReleaseStores, type UpgradeDriver } from "./durableStores.js"
import type { Release } from "./releases.js"

// Own tables (uc_*) in a private in-memory Miniflare database; the workflow tables are the fixture's.
const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const jobs = sqliteTable("uc_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"),
  resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const execs = sqliteTable("uc_execs", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at") })
const idempotency = sqliteTable("uc_idempotency", {
  id: text("id").primaryKey(), scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"), status: text("status"),
  result: text("result"), resourceEntity: text("resource_entity"), resourceId: text("resource_id"), resourceVersion: text("resource_version"),
  pendingInvalidations: text("pending_invalidations"), finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"),
  finalizerClaimExpiresAt: integer("finalizer_claim_expires_at"), createdAt: integer("created_at"), completedAt: integer("completed_at"),
})
const outbox = sqliteTable("uc_outbox", {
  id: text("id").primaryKey(), type: text("type"), aggregateId: text("aggregate_id"), payload: text("payload"), idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint"), provenance: text("provenance"),
}, (table) => [uniqueIndex("uc_outbox_identity").on(table.idempotencyScope, table.idempotencyKey)])

// The ownership-fence capability marker is per release (each release checks for its own).
const idempotencyAssertions = (module: typeof currentD1 | typeof previousD1) => Object.assign(sqliteTable("uc_idempotency_assertions", {
  scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"),
  expectedAffectedRows: integer("expected_affected_rows"), actualAffectedRows: integer("actual_affected_rows"),
}), { idempotencyAssertionCapability: module.D1_IDEMPOTENCY_ASSERTION_CAPABILITY })

const SCHEMA = [
  "CREATE TABLE uc_jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, scope_key TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)",
  "CREATE UNIQUE INDEX uc_jobs_idem ON uc_jobs (idempotency_scope, idempotency_key)",
  "CREATE TABLE uc_execs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)",
  "CREATE TABLE uc_idempotency (id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL, result TEXT, resource_entity TEXT, resource_id TEXT, resource_version TEXT, pending_invalidations TEXT, finalizer_claim_owner TEXT, finalizer_claim_token TEXT, finalizer_claim_expires_at INTEGER, created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)), completed_at INTEGER, UNIQUE (scope, key))",
  "CREATE TABLE uc_idempotency_assertions (scope TEXT, key TEXT, fingerprint TEXT, token TEXT, expected_affected_rows INTEGER, actual_affected_rows INTEGER, CHECK (expected_affected_rows IS NULL OR expected_affected_rows = actual_affected_rows))",
  "CREATE TRIGGER uc_idempotency_fence BEFORE INSERT ON uc_idempotency_assertions WHEN NEW.expected_affected_rows IS NULL AND NOT EXISTS (SELECT 1 FROM uc_idempotency WHERE scope = NEW.scope AND key = NEW.key AND fingerprint = NEW.fingerprint AND token = NEW.token AND status = 'in-progress') BEGIN SELECT RAISE(ABORT, 'idempotency ownership lost'); END",
  "CREATE TABLE uc_outbox (id TEXT PRIMARY KEY, type TEXT, aggregate_id TEXT, payload TEXT, idempotency_scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, event_fingerprint TEXT NOT NULL, provenance TEXT, UNIQUE (idempotency_scope, idempotency_key))",
]

let fixture: D1Fixture
const d1 = () => fixture.db
const rows = async (sql: string, ...params: unknown[]) => ((await d1().prepare(sql).bind(...params).all()).results ?? []) as Record<string, unknown>[]
const run = async (sql: string, ...params: unknown[]) => { await d1().prepare(sql).bind(...params).run() }
const mapRecord = (record: { type: string; aggregateId: string; payload: unknown }) => ({ type: record.type, aggregateId: record.aggregateId, payload: JSON.stringify(record.payload) })

// Stores are created lazily: the Miniflare database exists only after beforeAll.
function storesFor(module: typeof currentD1 | typeof previousD1): ReleaseStores {
  const db = drizzle(d1() as never)
  const idempotencyStore = module.createDrizzleD1IdempotencyStore(db as never, idempotency)
  const provider = module.createDrizzlePersistenceProvider({ db, registry: new module.DrizzleEntityRegistry(), idempotencyTable: idempotency, idempotencyAssertionTable: idempotencyAssertions(module) } as never) as unknown as { executeAtomicBatch(plan: unknown): Promise<unknown> }
  return {
    jobs: module.createDrizzleJobStore(module.createDrizzleD1Adapter(db as never).repository as never, { jobsTable: jobs, executionsTable: execs, executionHistory: "best_effort", columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } } as never) as never,
    workflows: new module.DrizzleD1WorkflowStore(d1() as never) as never,
    outbox: new module.DrizzleOutboxSink(db as never, outbox, mapRecord as never) as never,
    idempotency: idempotencyStore as never,
    commit: async (item) => { await provider.executeAtomicBatch({ items: [idempotencyStore.createCommitBatchItem(item as never)] }) },
  }
}

const driver: UpgradeDriver = {
  label: "d1",
  stores: (release: Release) => storesFor(release === "current" ? currentD1 : previousD1),
  reset: async () => {
    for (const table of ["uc_execs", "uc_jobs", "uc_idempotency", "uc_idempotency_assertions", "uc_outbox", "framework_workflow_signals", "framework_workflows"]) await run(`DELETE FROM ${table}`)
  },
  jobRow: async (jobId) => {
    const [row] = await rows("SELECT fingerprint, scope, tenant_id, scope_key FROM uc_jobs WHERE id = ?", jobId)
    return { fingerprint: (row!.fingerprint ?? null) as string | null, scope: row!.scope as string, tenantId: (row!.tenant_id ?? null) as string | null, scopeKey: (row!.scope_key ?? null) as string | null }
  },
  setJobFingerprint: (jobId, fingerprint) => run("UPDATE uc_jobs SET fingerprint = ? WHERE id = ?", fingerprint, jobId),
  outboxRows: async (scopeId, key) => (await rows("SELECT event_fingerprint FROM uc_outbox WHERE idempotency_scope = ? AND idempotency_key = ?", scopeId, key)).map((row) => ({ fingerprint: row.event_fingerprint as string })),
  setOutboxFingerprint: (scopeId, key, fingerprint) => run("UPDATE uc_outbox SET event_fingerprint = ? WHERE idempotency_scope = ? AND idempotency_key = ?", fingerprint, scopeId, key),
  resumeSignalId: async (instanceId) => ((await rows("SELECT resume_signal_id FROM framework_workflows WHERE id = ?", instanceId))[0]?.resume_signal_id ?? null) as string | null,
  setResumeSignalId: (instanceId, value) => run("UPDATE framework_workflows SET resume_signal_id = ? WHERE id = ?", value, instanceId),
}

beforeAll(async () => {
  fixture = await openD1Fixture()
  for (const statement of SCHEMA) await fixture.db.exec(statement)
})
afterAll(async () => { await fixture?.close() })

defineJobUpgrade(driver)
defineWorkflowUpgrade(driver)
defineOutboxUpgrade(driver)
defineIdempotencyUpgrade(driver)
