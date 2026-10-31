import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text, uniqueIndex, type AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { encodeExecutionScopeId } from "@xonava/core/domain"
import type { AuditRecord, OutboxRecord } from "@xonava/core/events"
import {
  createDrizzleD1Adapter, createDrizzleJobStore, createDrizzlePersistenceProvider, D1_IDEMPOTENCY_ASSERTION_CAPABILITY,
  DrizzleEntityRegistry, type DrizzleD1Command,
} from "@xonava/adapters/drizzle-d1"
import type { AtomicBatchPlan, AtomicBatchResult, PersistenceProvider, TenantScopedAtomicBatchCommandEncoder } from "@xonava/core/persistence"
import { createFakeD1, type FakeD1 } from "../../__tests__/support/fakeD1"

/** Real-SQLite fixture (node:sqlite behind a D1-shaped binding) shared by the D1 adapter unit suites. */
const ts = (name: string) => integer(name, { mode: "timestamp_ms" })

export const items = sqliteTable("dx_items", { id: text("id").primaryKey(), tenantId: text("tenant_id").notNull(), name: text("name").notNull(), version: integer("version").notNull() })
export const globalItems = sqliteTable("dx_global_items", { id: text("id").primaryKey(), name: text("name").notNull(), version: integer("version").notNull() })
export const plainItems = sqliteTable("dx_plain_items", { id: text("id").primaryKey(), label: text("label").notNull() })
export const audit = sqliteTable("dx_audit", { id: text("id").primaryKey(), action: text("action"), tenantId: text("tenant_id") })
export const outbox = sqliteTable("dx_outbox", {
  id: text("id").primaryKey(), type: text("type"), payload: text("payload"), idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint"), provenance: text("provenance"),
}, (t) => [uniqueIndex("dx_outbox_identity").on(t.idempotencyScope, t.idempotencyKey)])
export const idempotency = sqliteTable("dx_idempotency", {
  id: text("id").primaryKey(), scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"), status: text("status"),
  result: text("result"), resourceEntity: text("resource_entity"), resourceId: text("resource_id"), resourceVersion: text("resource_version"),
  pendingInvalidations: text("pending_invalidations"), completedAt: integer("completed_at"),
})
export const assertions = Object.assign(sqliteTable("dx_assertions", {
  scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"),
  expectedAffectedRows: integer("expected_affected_rows"), actualAffectedRows: integer("actual_affected_rows"),
}), { idempotencyAssertionCapability: D1_IDEMPOTENCY_ASSERTION_CAPABILITY })
export const tagGenerations = sqliteTable("dx_tag_generations", { tag: text("tag").primaryKey(), generation: integer("generation").notNull() })

export const jobs = sqliteTable("dx_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"),
  resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
export const execs = sqliteTable("dx_execs", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at") })

export const FENCE = "CREATE TRIGGER dx_fence BEFORE INSERT ON dx_assertions WHEN NEW.expected_affected_rows IS NULL AND NOT EXISTS (SELECT 1 FROM dx_idempotency WHERE scope = NEW.scope AND key = NEW.key AND fingerprint = NEW.fingerprint AND token = NEW.token AND status = 'in-progress') BEGIN SELECT RAISE(ABORT, 'idempotency ownership lost'); END"
export const SCHEMA = [
  "CREATE TABLE dx_items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE, version INTEGER NOT NULL)",
  "CREATE TABLE dx_global_items (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, version INTEGER NOT NULL)",
  "CREATE TABLE dx_plain_items (id TEXT PRIMARY KEY, label TEXT NOT NULL)",
  "CREATE TABLE dx_audit (id TEXT PRIMARY KEY, action TEXT, tenant_id TEXT)",
  "CREATE TABLE dx_outbox (id TEXT PRIMARY KEY, type TEXT, payload TEXT, idempotency_scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, event_fingerprint TEXT NOT NULL, provenance TEXT, UNIQUE (idempotency_scope, idempotency_key))",
  "CREATE TABLE dx_idempotency (id TEXT PRIMARY KEY, scope TEXT, key TEXT, fingerprint TEXT, token TEXT, status TEXT, result TEXT, resource_entity TEXT, resource_id TEXT, resource_version TEXT, pending_invalidations TEXT, completed_at INTEGER, UNIQUE (scope, key))",
  "CREATE TABLE dx_assertions (scope TEXT, key TEXT, fingerprint TEXT, token TEXT, expected_affected_rows INTEGER, actual_affected_rows INTEGER, CHECK (expected_affected_rows IS NULL OR expected_affected_rows = actual_affected_rows))",
  "CREATE TABLE dx_tag_generations (tag TEXT PRIMARY KEY, generation INTEGER NOT NULL)",
  "CREATE TABLE dx_jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, scope_key TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER, max_attempts INTEGER, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)",
  "CREATE UNIQUE INDEX dx_jobs_idem ON dx_jobs (idempotency_scope, idempotency_key)",
  "CREATE TABLE dx_execs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)",
]

export const tenantEntity = { name: "DxItem", fields: { id: {}, tenantId: {}, name: {}, version: {} }, primaryKey: "id", versionField: "version", tenantField: "tenantId" } as never
export const globalEntity = { name: "DxGlobal", fields: { id: {}, name: {}, version: {} }, primaryKey: "id", versionField: "version" } as never
export const plainEntity = { name: "DxPlain", fields: { id: {}, label: {} }, primaryKey: "id" } as never
export const actor = { id: "actor", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } } as const
export const auditRecord = (id: string): AuditRecord => ({ id, occurredAt: new Date(), action: "update", resourceType: "DxItem", resourceId: "a", actor, tenantId: "t1", oldValue: null, newValue: null } as AuditRecord)
export const platformScope = { kind: "platform", platformKey: "test" } as const
export const outboxRecord = (id: string, key: string, payload: unknown = { n: 1 }): OutboxRecord => ({
  id, type: "dx.updated", version: 1, scope: platformScope, scopeId: encodeExecutionScopeId(platformScope), aggregateType: "DxItem", aggregateId: "a",
  payload, idempotencyKey: key, occurredAt: new Date(), provenance: { v: 1, marker: "prov" } as never,
} as OutboxRecord)

export type AtomicProvider = PersistenceProvider & {
  executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
  createTenantScopedCommandEncoder(tenantId: string): TenantScopedAtomicBatchCommandEncoder<DrizzleD1Command>
}

export interface SetupOptions {
  mutationAssertions?: boolean
  fence?: boolean
  tagGenerations?: boolean
  limits?: { maxBindParams?: number; maxStatementBytes?: number; maxBatchItems?: number; maxPageSize?: number }
  extraSchema?: readonly string[]
}

export async function setup(options: SetupOptions = {}) {
  const d1: FakeD1 = createFakeD1([...SCHEMA, ...(options.extraSchema ?? [])])
  if (options.fence !== false) d1.sqlite.exec(FENCE)
  const db = drizzle(d1 as never)
  const registry = new DrizzleEntityRegistry()
    .register(tenantEntity, items, { id: items.id, tenantId: items.tenantId, name: items.name, version: items.version })
    .register(globalEntity, globalItems, { id: globalItems.id, name: globalItems.name, version: globalItems.version })
    .register(plainEntity, plainItems, { id: plainItems.id, label: plainItems.label })
  const provider = createDrizzlePersistenceProvider({
    db, registry, auditTable: audit, outboxTable: outbox, idempotencyTable: idempotency, idempotencyAssertionTable: assertions,
    ...(options.mutationAssertions === false ? {} : { mutationAssertionTable: assertions }),
    ...(options.tagGenerations ? { tagGenerationTable: tagGenerations } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    mapAuditRecord: (record: AuditRecord) => ({ id: record.id, action: record.action, tenantId: record.tenantId }),
    mapOutboxRecord: (record: OutboxRecord) => ({ type: record.type, payload: JSON.stringify(record.payload) }),
  }) as AtomicProvider
  d1.sqlite.exec("INSERT INTO dx_items (id, tenant_id, name, version) VALUES ('a', 't1', 'A', 1)")
  const count = (table: string): number => (d1.sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c
  const row = (query: string): Record<string, unknown> | undefined => d1.sqlite.prepare(query).get() as Record<string, unknown> | undefined
  const rows = (query: string): Record<string, unknown>[] => d1.sqlite.prepare(query).all() as Record<string, unknown>[]
  return { d1, db, provider, count, row, rows }
}

export const columnMap = (table: AnySQLiteTable) => Object.fromEntries(Object.entries(table).filter(([, column]) => typeof (column as { name?: unknown })?.name === "string")) as never
export const requester = { scope: "system" } as never
export const RUN_AT = new Date(Date.now() - 1000)
export const newJob = (overrides: Record<string, unknown> = {}) => ({ jobType: "dx", jobVersion: 1, payload: { a: 1 }, executionScope: { kind: "system", systemKey: "sys" }, maxAttempts: 3, runAt: RUN_AT, ...overrides }) as never

export function jobStore(db: ReturnType<typeof drizzle>, executionHistory: "best_effort" | "required" = "best_effort", executionsTable: AnySQLiteTable = execs) {
  const session = createDrizzleD1Adapter(db as never).repository
  return createDrizzleJobStore(session, { jobsTable: jobs, executionsTable, executionHistory, columnMap: { jobs: columnMap(jobs), executions: columnMap(executionsTable) } })
}

const MIGRATIONS_DIRECTORY = new URL("../../../../testing/fixtures/d1/migrations/", import.meta.url)

/**
 * Applies the certified framework D1 migrations (workflow, temporal, sequence, lease and progress tables) the same way the
 * D1 conformance fixture does: one statement per line, comments dropped. Migrations 0003 and 0005 target deployment-owned
 * tables that this fixture defines itself, so only the framework-owned ones are applied.
 */
export function applyFrameworkMigrations(d1: FakeD1): void {
  for (const name of ["0001_framework.sql", "0002_workflow_signal_buffering.sql", "0004_lease_records.sql"]) {
    const source = readFileSync(fileURLToPath(new URL(name, MIGRATIONS_DIRECTORY)), "utf8")
    for (const line of source.split("\n")) {
      const statement = line.trim()
      if (statement !== "" && !statement.startsWith("--")) d1.sqlite.exec(statement)
    }
  }
}
