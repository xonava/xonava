import { afterEach, describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text, uniqueIndex, type AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { ConfigurationError, ConflictError, encodeExecutionScopeId, Predicate } from "core/domain"
import type { AuditRecord, OutboxRecord } from "core/events"
import { JobIdempotencyConflictError } from "core/execution"
import {
  createDrizzleD1Adapter, createDrizzleJobStore, createDrizzlePersistenceProvider, D1_IDEMPOTENCY_ASSERTION_CAPABILITY,
  DrizzleEntityRegistry, type DrizzleD1Command,
} from "adapters/drizzle-d1"
import type { AtomicBatchPlan, AtomicBatchResult, PersistenceProvider, TenantScopedAtomicBatchCommandEncoder } from "core/persistence"
import { openD1Fixture, type D1Fixture } from "./database.js"

const ts = (name: string) => integer(name, { mode: "timestamp_ms" })

const items = sqliteTable("dx_items", { id: text("id").primaryKey(), tenantId: text("tenant_id").notNull(), name: text("name").notNull(), version: integer("version").notNull() })
const audit = sqliteTable("dx_audit", { id: text("id").primaryKey(), action: text("action"), tenantId: text("tenant_id") })
const outbox = sqliteTable("dx_outbox", {
  id: text("id").primaryKey(), type: text("type"), payload: text("payload"), idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint"), provenance: text("provenance"),
}, (t) => [uniqueIndex("dx_outbox_identity").on(t.idempotencyScope, t.idempotencyKey)])
const idempotency = sqliteTable("dx_idempotency", {
  id: text("id").primaryKey(), scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"), status: text("status"),
  result: text("result"), resourceEntity: text("resource_entity"), resourceId: text("resource_id"), resourceVersion: text("resource_version"),
  pendingInvalidations: text("pending_invalidations"), completedAt: integer("completed_at"),
})
const assertions = Object.assign(sqliteTable("dx_assertions", {
  scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"),
  expectedAffectedRows: integer("expected_affected_rows"), actualAffectedRows: integer("actual_affected_rows"),
}), { idempotencyAssertionCapability: D1_IDEMPOTENCY_ASSERTION_CAPABILITY })

const jobs = sqliteTable("dx_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"),
  resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const execs = sqliteTable("dx_execs", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at") })

const FENCE = "CREATE TRIGGER dx_fence BEFORE INSERT ON dx_assertions WHEN NEW.expected_affected_rows IS NULL AND NOT EXISTS (SELECT 1 FROM dx_idempotency WHERE scope = NEW.scope AND key = NEW.key AND fingerprint = NEW.fingerprint AND token = NEW.token AND status = 'in-progress') BEGIN SELECT RAISE(ABORT, 'idempotency ownership lost'); END"
const SCHEMA = [
  "CREATE TABLE dx_items (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL UNIQUE, version INTEGER NOT NULL)",
  "CREATE TABLE dx_audit (id TEXT PRIMARY KEY, action TEXT, tenant_id TEXT)",
  "CREATE TABLE dx_outbox (id TEXT PRIMARY KEY, type TEXT, payload TEXT, idempotency_scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, event_fingerprint TEXT NOT NULL, provenance TEXT, UNIQUE (idempotency_scope, idempotency_key))",
  "CREATE TABLE dx_idempotency (id TEXT PRIMARY KEY, scope TEXT, key TEXT, fingerprint TEXT, token TEXT, status TEXT, result TEXT, resource_entity TEXT, resource_id TEXT, resource_version TEXT, pending_invalidations TEXT, completed_at INTEGER, UNIQUE (scope, key))",
  "CREATE TABLE dx_assertions (scope TEXT, key TEXT, fingerprint TEXT, token TEXT, expected_affected_rows INTEGER, actual_affected_rows INTEGER, CHECK (expected_affected_rows IS NULL OR expected_affected_rows = actual_affected_rows))",
  "CREATE TABLE dx_jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER, max_attempts INTEGER, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)",
  "CREATE UNIQUE INDEX dx_jobs_idem ON dx_jobs (idempotency_scope, idempotency_key)",
  "CREATE TABLE dx_execs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)",
]

const entity = { name: "DxItem", fields: { id: {}, tenantId: {}, name: {}, version: {} }, primaryKey: "id", versionField: "version", tenantField: "tenantId" } as never
const actor = { id: "actor", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } } as const
const auditRecord = (id: string): AuditRecord => ({ id, occurredAt: new Date(), action: "update", resourceType: "DxItem", resourceId: "a", actor, tenantId: "t1", oldValue: null, newValue: null } as AuditRecord)
const platformScope = { kind: "platform", platformKey: "test" } as const
const outboxRecord = (id: string, key: string): OutboxRecord => ({
  id, type: "dx.updated", version: 1, scope: platformScope, scopeId: encodeExecutionScopeId(platformScope), aggregateType: "DxItem", aggregateId: "a",
  payload: { n: 1 }, idempotencyKey: key, occurredAt: new Date(), provenance: { v: 1, marker: "prov" } as never,
})

type AtomicProvider = PersistenceProvider & {
  executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult>
  createTenantScopedCommandEncoder(tenantId: string): TenantScopedAtomicBatchCommandEncoder<DrizzleD1Command>
}

let fixture: D1Fixture | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })

async function setup(options: { mutationAssertions?: boolean; fence?: boolean } = {}) {
  fixture = await openD1Fixture()
  const d1 = fixture.db
  for (const statement of SCHEMA) await d1.exec(statement)
  if (options.fence !== false) await d1.exec(FENCE)
  const db = drizzle(d1 as never)
  const registry = new DrizzleEntityRegistry().register(entity, items, { id: items.id, tenantId: items.tenantId, name: items.name, version: items.version })
  const provider = createDrizzlePersistenceProvider({
    db, registry, auditTable: audit, outboxTable: outbox, idempotencyTable: idempotency, idempotencyAssertionTable: assertions,
    ...(options.mutationAssertions === false ? {} : { mutationAssertionTable: assertions }),
    mapAuditRecord: (record) => ({ id: record.id, action: record.action, tenantId: record.tenantId }),
    mapOutboxRecord: (record) => ({ type: record.type, payload: JSON.stringify(record.payload) }),
  }) as AtomicProvider
  await db.insert(items).values({ id: "a", tenantId: "t1", name: "A", version: 1 })
  const count = async (table: string) => (await d1.prepare(`SELECT count(*) AS c FROM ${table}`).first<{ c: number }>())!.c
  return { d1, db, provider, count }
}

const columnMap = (table: AnySQLiteTable) => Object.fromEntries(Object.entries(table).filter(([, column]) => typeof (column as { name?: unknown })?.name === "string")) as never
const requester = { scope: "system" } as never
const RUN_AT = new Date(Date.now() - 1000)
const newJob = (overrides: Record<string, unknown> = {}) => ({ jobType: "dx", jobVersion: 1, payload: { a: 1 }, executionScope: { kind: "system", systemKey: "sys" }, maxAttempts: 3, runAt: RUN_AT, ...overrides }) as never

function jobStore(db: ReturnType<typeof drizzle>, executionHistory: "best_effort" | "required" = "best_effort", executionsTable: AnySQLiteTable = execs) {
  const session = createDrizzleD1Adapter(db as never).repository
  return createDrizzleJobStore(session, { jobsTable: jobs, executionsTable, executionHistory, columnMap: { jobs: columnMap(jobs), executions: columnMap(executionsTable) } })
}

describe("D1 adapter defect regressions", () => {
  it("D1-1: maps a duplicate repository insert to ConflictError without leaking SQL", async () => {
    const { provider } = await setup()
    const error = await provider.repository(entity).insert({ id: "b", tenantId: "t1", name: "A", version: 1 } as never).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(String((error as Error).message)).not.toMatch(/dx_items|D1_ERROR|insert into/i)
  })

  it("D1-1: idempotent enqueue replay returns the existing job; a different fingerprint conflicts", async () => {
    const { db, count } = await setup()
    const store = jobStore(db)
    const first = await store.enqueue({ job: newJob({ idempotencyKey: "k1" }), requester })
    const second = await store.enqueue({ job: newJob({ idempotencyKey: "k1" }), requester })
    expect(second.id).toBe(first.id)
    expect(await count("dx_jobs")).toBe(1)
    await expect(store.enqueue({ job: newJob({ idempotencyKey: "k1", payload: { a: 2 } }), requester })).rejects.toBeInstanceOf(JobIdempotencyConflictError)
  })

  it("D1-2: atomic batch duplicate insert is a sanitized ConflictError and rolls back", async () => {
    const { provider, count } = await setup()
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    const error = await provider.executeAtomicBatch({ items: [
      { kind: "audit", record: auditRecord("aud-dup") },
      { kind: "command", command: encoder.encode({ kind: "insert", entity: "DxItem", values: { id: "z", name: "A" } } as never) },
    ] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(String((error as Error).message)).not.toMatch(/dx_items|D1_ERROR|UNIQUE/)
    expect(JSON.stringify((error as { details?: unknown }).details ?? {})).not.toMatch(/dx_items|D1_ERROR/)
    expect(await count("dx_audit")).toBe(0)
  })

  it("D1-2: a lost idempotency fence aborts the batch with ConflictError", async () => {
    const { d1, provider, count } = await setup()
    await d1.prepare("INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','fp','tok','completed')").run()
    const error = await provider.executeAtomicBatch({ items: [
      { kind: "audit", record: auditRecord("aud-fence") },
      { kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } },
    ] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(String((error as Error).message)).not.toMatch(/D1_ERROR|SQLITE/)
    expect(await count("dx_audit")).toBe(0)
  })

  it("D1-2: an explicit mutation-assertion failure is a ConflictError (stale write)", async () => {
    const { provider, count } = await setup()
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    const error = await provider.executeAtomicBatch({ items: [
      { kind: "command", command: encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "A2" }, expectedVersion: 99, expectedAffectedRows: 1 } as never) },
      { kind: "audit", record: auditRecord("aud-assert") },
    ] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(String((error as Error).message)).not.toMatch(/expected_affected_rows|D1_ERROR|CHECK/)
    expect(await count("dx_audit")).toBe(0)
  })

  it("D1-3: a stale expectedVersion alone aborts every item in the batch", async () => {
    const { d1, provider, count } = await setup()
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    await expect(provider.executeAtomicBatch({ items: [
      { kind: "command", command: encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "A2" }, expectedVersion: 99 } as never) },
      { kind: "audit", record: auditRecord("aud-stale") },
    ] })).rejects.toBeInstanceOf(ConflictError)
    expect(await count("dx_audit")).toBe(0)
    const deletion = encoder.encode({ kind: "delete", entity: "DxItem", filter: Predicate.eq("id", "a"), expectedVersion: 42 } as never)
    await expect(provider.executeAtomicBatch({ items: [{ kind: "command", command: deletion }, { kind: "audit", record: auditRecord("aud-stale-del") }] })).rejects.toBeInstanceOf(ConflictError)
    expect(await count("dx_audit")).toBe(0)
    // The matching version still commits.
    await provider.executeAtomicBatch({ items: [
      { kind: "command", command: encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "A2" }, expectedVersion: 1 } as never) },
      { kind: "audit", record: auditRecord("aud-ok") },
    ] })
    expect(await d1.prepare("SELECT name, version FROM dx_items WHERE id = 'a'").first()).toMatchObject({ name: "A2", version: 2 })
    expect(await count("dx_audit")).toBe(1)
  })

  it("D1-3: a versioned command without a mutationAssertionTable fails closed with ConfigurationError", async () => {
    const { provider, count } = await setup({ mutationAssertions: false })
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    await expect(provider.executeAtomicBatch({ items: [
      { kind: "command", command: encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "A2" }, expectedVersion: 99 } as never) },
      { kind: "audit", record: auditRecord("aud-cfg") },
    ] })).rejects.toBeInstanceOf(ConfigurationError)
    expect(await count("dx_audit")).toBe(0)
  })

  it("D1-4: required execution history applies transitions and writes complete history rows", async () => {
    const { d1, db } = await setup()
    const store = jobStore(db, "required")
    await store.enqueue({ job: newJob(), requester })
    const [claimed] = await store.claimDue({ workerId: "w1", leaseDurationMs: 60_000, limit: 10, requester })
    const result = await store.markSucceeded({ jobId: claimed!.id, workerId: "w1", claimToken: claimed!.claimToken!, attempt: claimed!.currentAttempt, result: { ok: 1 } })
    expect(result, JSON.stringify(result)).toMatchObject({ applied: true })
    expect(await d1.prepare("SELECT status, claim_token FROM dx_jobs").first()).toMatchObject({ status: "succeeded", claim_token: null })
    const history = await d1.prepare("SELECT * FROM dx_execs").first<Record<string, unknown>>()
    expect(history).toMatchObject({ job_id: claimed!.id, status: "succeeded", worker_id: "w1", attempt: 1 })
    expect(typeof history!.started_at).toBe("number")
    const second = await store.enqueue({ job: newJob({ idempotencyKey: "cancel-me" }), requester })
    expect(await store.cancel({ jobId: second.id, requester, reason: "stop" } as never)).toMatchObject({ applied: true })
    expect(await d1.prepare("SELECT job_id, status, typeof(finished_at) AS t FROM dx_execs WHERE job_id = ?").bind(second.id).first()).toMatchObject({ job_id: second.id, status: "cancelled", t: "integer" })
  })

  it("D1-4: best-effort execution history writes mapped columns", async () => {
    const { d1, db } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob(), requester })
    const [claimed] = await store.claimDue({ workerId: "w1", leaseDurationMs: 60_000, limit: 10, requester })
    expect(await store.markSucceeded({ jobId: claimed!.id, workerId: "w1", claimToken: claimed!.claimToken!, attempt: claimed!.currentAttempt })).toMatchObject({ applied: true })
    expect(await d1.prepare("SELECT job_id, worker_id, status, typeof(started_at) AS t FROM dx_execs").first()).toMatchObject({ job_id: claimed!.id, worker_id: "w1", status: "succeeded", t: "integer" })
  })

  it("D1-4: historyError never carries raw provider messages", async () => {
    const { d1, db } = await setup()
    await d1.exec("CREATE TRIGGER dx_execs_secret BEFORE INSERT ON dx_execs BEGIN SELECT RAISE(ABORT, 'secret internal detail dx_execs'); END")
    const store = jobStore(db, "required")
    await store.enqueue({ job: newJob(), requester })
    const [claimed] = await store.claimDue({ workerId: "w1", leaseDurationMs: 60_000, limit: 10, requester })
    const result = await store.markSucceeded({ jobId: claimed!.id, workerId: "w1", claimToken: claimed!.claimToken!, attempt: claimed!.currentAttempt })
    expect(result).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
    expect(JSON.stringify(result)).not.toMatch(/secret|dx_execs|D1_ERROR/)
  })

  it("D1-5: an expired final-attempt running job is dead-lettered by claimDue", async () => {
    const { d1, db } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob({ maxAttempts: 1 }), requester })
    const claimed = await store.claimDue({ workerId: "w1", leaseDurationMs: 60_000, limit: 10, requester })
    expect(claimed).toHaveLength(1)
    await d1.prepare("UPDATE dx_jobs SET lease_expires_at = 1").run()
    expect(await store.claimDue({ workerId: "w2", leaseDurationMs: 60_000, limit: 10, requester })).toHaveLength(0)
    const row = await d1.prepare("SELECT status, lease_owner, lease_expires_at, claim_token, last_error FROM dx_jobs").first<Record<string, unknown>>()
    expect(row).toMatchObject({ status: "dead_letter", lease_owner: null, lease_expires_at: null, claim_token: null })
    expect(typeof row!.last_error).toBe("string")
  })

  it("D1-5: a claimed job is returned even when its short lease has already elapsed", async () => {
    const { db } = await setup()
    const store = jobStore(db)
    await store.enqueue({ job: newJob(), requester })
    const claimed = await store.claimDue({ workerId: "w1", leaseDurationMs: 1, limit: 10, requester })
    expect(claimed).toHaveLength(1)
    expect(claimed[0]!.currentAttempt).toBe(1)
  })

  it("D1-6: atomic outbox rows carry provenance and enforce scope identity", async () => {
    const { d1, provider } = await setup()
    await provider.executeAtomicBatch({ items: [{ kind: "outbox", record: outboxRecord("o1", "key-1") }] })
    const row = await d1.prepare("SELECT provenance FROM dx_outbox WHERE id = 'o1'").first<{ provenance: string | null }>()
    expect(JSON.parse(row!.provenance!)).toMatchObject({ marker: "prov" })
    const mismatched = { ...outboxRecord("o2", "key-2"), scopeId: encodeExecutionScopeId({ kind: "platform", platformKey: "other" }) }
    await expect(provider.executeAtomicBatch({ items: [{ kind: "outbox", record: mismatched }] })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("D1-7: a failed idempotency-fence verification is not cached forever", async () => {
    const { d1, provider } = await setup({ fence: false })
    await d1.prepare("INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','fp','tok','in-progress')").run()
    const plan = { items: [{ kind: "idempotency" as const, commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } }] }
    await expect(provider.executeAtomicBatch(plan)).rejects.toBeInstanceOf(ConfigurationError)
    await d1.exec(FENCE)
    await expect(provider.executeAtomicBatch(plan)).resolves.toHaveLength(1)
    expect(await d1.prepare("SELECT status FROM dx_idempotency WHERE id = 'i1'").first()).toMatchObject({ status: "business-committed" })
  })
})
