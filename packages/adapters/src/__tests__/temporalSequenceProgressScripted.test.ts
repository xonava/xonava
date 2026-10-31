import { describe, expect, it } from "vitest"
import { ConfigurationError, ConflictError, StaleClaimError } from "@xonava/core/domain"
import { DrizzlePgTemporalHistoryStore, postgresTemporalSchemaSql, POSTGRES_TEMPORAL_SCHEMA_SQL } from "../drizzle-pg/drizzleTemporalHistoryStore"
import { DrizzlePgSequenceStore, postgresSequenceSchemaSql, POSTGRES_SEQUENCE_SCHEMA_SQL } from "../drizzle-pg/drizzleSequenceStore"
import { DrizzlePgJobProgressStore } from "../drizzle-pg/drizzleJobProgressStore"
import { DrizzleMySqlTemporalHistoryStore, mysqlTemporalSchemaSql, MYSQL_TEMPORAL_STORE_TABLES } from "../drizzle-mysql/drizzleTemporalHistoryStore"
import { DrizzleMySqlSequenceStore, mysqlSequenceSchemaSql } from "../drizzle-mysql/drizzleSequenceStore"
import { DrizzleMySqlJobProgressStore, MYSQL_JOB_PROGRESS_TABLES } from "../drizzle-mysql/drizzleJobProgressStore"
import { createScriptedMySqlPool, createScriptedPgPool, type PoolCall } from "./support/scriptedPool"

const resource = { scopeId: "fscope:v1:t" as never, entityType: "invoice", entityId: "i1" }
const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms)
const pgRevisionRow = (overrides: Record<string, unknown> = {}) => ({ scope_id: resource.scopeId, entity_type: "invoice", entity_id: "i1", revision: "2", occurred_at: at(10), kind: "updated", state: { n: 2 }, entity_version: "4", event_id: "e1", audit_id: "a1", ...overrides })

describe("PostgreSQL temporal history store", () => {
  it("appends through one guarded statement and decodes the returned revision", async () => {
    const { pool, calls } = createScriptedPgPool(() => [pgRevisionRow({ state: '{"n":2}' })])
    const store = new DrizzlePgTemporalHistoryStore(pool)
    const revision = await store.append({ ...resource, occurredAt: at(10), kind: "updated", state: { n: 2 }, entityVersion: 4, eventId: "e1", auditId: "a1" })
    expect(revision).toMatchObject({ revision: 2, kind: "updated", state: { n: 2 }, entityVersion: 4, eventId: "e1", auditId: "a1" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sql).toContain("public.temporal_heads")
    expect(calls[0]!.params).toEqual([resource.scopeId, "invoice", "i1", at(10), "updated", '{"n":2}', 4, "e1", "a1"])
    const minimal = createScriptedPgPool(() => [pgRevisionRow({ entity_version: null, event_id: null, audit_id: null, state: { n: 2 } })])
    expect(await new DrizzlePgTemporalHistoryStore(minimal.pool, "tenant_a").append({ ...resource, occurredAt: at(10), kind: "updated", state: { n: 2 } })).toEqual(expect.objectContaining({ revision: 2 }))
    expect(minimal.calls[0]!.sql).toContain("tenant_a.temporal_heads")
    expect(minimal.calls[0]!.params.slice(6)).toEqual([null, null, null])
  })

  it("rejects chronology or lifecycle violations when no row comes back, and invalid input before any SQL", async () => {
    const { pool, calls } = createScriptedPgPool(() => [])
    const store = new DrizzlePgTemporalHistoryStore(pool)
    await expect(store.append({ ...resource, occurredAt: at(0), kind: "created", state: { n: 1 } })).rejects.toBeInstanceOf(ConflictError)
    await expect(store.append({ ...resource, occurredAt: at(0), kind: "deleted", state: { n: 1 } as never })).rejects.toBeInstanceOf(ConfigurationError)
    expect(calls).toHaveLength(1)
    const deleted = createScriptedPgPool(() => [pgRevisionRow({ kind: "deleted", state: null })])
    expect((await new DrizzlePgTemporalHistoryStore(deleted.pool).append({ ...resource, occurredAt: at(0), kind: "deleted", state: null })).state).toBeNull()
    expect(deleted.calls[0]!.params[5]).toBeNull()
  })

  it("saves and reads snapshots and pages revisions", async () => {
    const saved = createScriptedPgPool(() => [])
    const store = new DrizzlePgTemporalHistoryStore(saved.pool)
    await store.saveSnapshot({ ...resource, revision: 3, occurredAt: at(5), state: { n: 3 } })
    await store.saveSnapshot({ ...resource, revision: 4, occurredAt: at(6), state: null })
    expect(saved.calls[0]!.params).toEqual([resource.scopeId, "invoice", "i1", 3, at(5), '{"n":3}'])
    expect(saved.calls[1]!.params[5]).toBeNull()
    await expect(store.saveSnapshot({ ...resource, revision: 0, occurredAt: at(5), state: { n: 1 } })).rejects.toBeInstanceOf(ConfigurationError)
    const snapshot = createScriptedPgPool(() => [{ revision: "3", occurred_at: at(5).toISOString(), state: '{"n":3}' }])
    expect(await new DrizzlePgTemporalHistoryStore(snapshot.pool).latestSnapshot(resource, at(100))).toMatchObject({ revision: 3, state: { n: 3 }, occurredAt: at(5) })
    const nullState = createScriptedPgPool(() => [{ revision: 4, occurred_at: at(6), state: null }])
    expect((await new DrizzlePgTemporalHistoryStore(nullState.pool).latestSnapshot(resource, at(100)))?.state).toBeNull()
    expect(await new DrizzlePgTemporalHistoryStore(createScriptedPgPool(() => []).pool).latestSnapshot(resource, at(100))).toBeNull()
    const pages = createScriptedPgPool(() => [pgRevisionRow({ revision: 1, kind: "created" }), pgRevisionRow({ revision: 2 }), pgRevisionRow({ revision: 3 })])
    const page = await new DrizzlePgTemporalHistoryStore(pages.pool).revisions(resource, { afterRevision: 0, asOf: at(100), limit: 2 })
    expect(page.items.map((item) => item.revision)).toEqual([1, 2])
    expect(page.hasMore).toBe(true)
    expect(pages.calls[0]!.params.at(-1)).toBe(3)
    const last = await new DrizzlePgTemporalHistoryStore(createScriptedPgPool(() => [pgRevisionRow()]).pool).revisions(resource, { afterRevision: 0, asOf: at(100), limit: 2 })
    expect(last.hasMore).toBe(false)
  })

  it("validates schema names and renders its DDL", () => {
    expect(() => new DrizzlePgTemporalHistoryStore(createScriptedPgPool(() => []).pool, "bad;schema")).toThrow(ConfigurationError)
    expect(postgresTemporalSchemaSql("tenant_a")).toContain("tenant_a.temporal_heads")
    expect(POSTGRES_TEMPORAL_SCHEMA_SQL).toContain("framework_test.temporal_revisions")
    expect(() => postgresTemporalSchemaSql("x y")).toThrow(ConfigurationError)
    expect(postgresSequenceSchemaSql()).toContain("public.sequences")
    expect(POSTGRES_SEQUENCE_SCHEMA_SQL).toContain("framework_test.sequences")
  })
})

describe("PostgreSQL sequence store", () => {
  it("allocates the returned value and rejects unusable results", async () => {
    const ok = createScriptedPgPool(() => [{ value: "7" }])
    expect(await new DrizzlePgSequenceStore(ok.pool, "tenant_a").next("fscope:v1:s" as never, "invoice", "2026")).toBe(7)
    expect(ok.calls[0]!.sql).toContain("tenant_a.sequences")
    expect(ok.calls[0]!.params).toEqual(["fscope:v1:s", "invoice", "2026"])
    for (const rows of [[], [{ value: 0 }], [{ value: "x" }], [{ value: 1.5 }]]) {
      await expect(new DrizzlePgSequenceStore(createScriptedPgPool(() => rows).pool).next("s" as never, "n", "p")).rejects.toThrow("PostgreSQL sequence allocation failed")
    }
    expect(() => new DrizzlePgSequenceStore(ok.pool, "no good")).toThrow(ConfigurationError)
  })
})

describe("PostgreSQL job progress store", () => {
  const fence = { jobId: "j1", workerId: "w1", claimToken: "tok", attempt: 2 }
  const progressRow = (overrides: Record<string, unknown> = {}) => ({ job_id: "j1", attempt: 2, sequence: "1", percent: "10", checkpoint: { step: 1 }, updated_at: at(5), ...overrides })

  it("reads stored progress, omitting null percent and checkpoint", async () => {
    const full = createScriptedPgPool(() => [progressRow({ checkpoint: '{"step":1}' })])
    expect(await new DrizzlePgJobProgressStore(full.pool).read("j1")).toMatchObject({ jobId: "j1", attempt: 2, sequence: 1, percent: 10, checkpoint: { step: 1 }, updatedAt: at(5).toISOString() })
    const sparse = await new DrizzlePgJobProgressStore(createScriptedPgPool(() => [progressRow({ percent: null, checkpoint: null })]).pool).read("j1")
    expect(sparse).not.toHaveProperty("percent")
    expect(sparse).not.toHaveProperty("checkpoint")
    expect(await new DrizzlePgJobProgressStore(createScriptedPgPool(() => []).pool).read("j1")).toBeNull()
  })

  it("writes under the claim fence and returns the stored row", async () => {
    const { pool, calls } = createScriptedPgPool(() => [progressRow({ sequence: 3, percent: null, checkpoint: null })])
    const written = await new DrizzlePgJobProgressStore(pool).write(fence, 2, { percent: 55, checkpoint: { a: 1 } })
    expect(written).toMatchObject({ jobId: "j1", sequence: 3 })
    expect(written).not.toHaveProperty("percent")
    expect(calls[0]!.params).toEqual(["j1", "w1", "tok", 2, 3, 55, '{"a":1}', 2])
    await new DrizzlePgJobProgressStore(createScriptedPgPool(() => [progressRow({ checkpoint: { raw: true } })]).pool).write(fence, 0, { percent: 1 })
    const noCheckpoint = createScriptedPgPool(() => [progressRow()])
    await new DrizzlePgJobProgressStore(noCheckpoint.pool).write(fence, 0, {})
    expect(noCheckpoint.calls[0]!.params.slice(5, 7)).toEqual([null, null])
  })

  it("distinguishes lost ownership from a sequence conflict and validates progress", async () => {
    const owned = createScriptedPgPool((call: PoolCall) => (call.sql.startsWith("INSERT") ? { rows: [], rowCount: 0 } : { rows: [{}], rowCount: 1 }))
    await expect(new DrizzlePgJobProgressStore(owned.pool).write(fence, 1, { percent: 5 })).rejects.toBeInstanceOf(ConflictError)
    const lost = createScriptedPgPool(() => ({ rows: [], rowCount: 0 }))
    await expect(new DrizzlePgJobProgressStore(lost.pool).write(fence, 1, { percent: 5 })).rejects.toBeInstanceOf(StaleClaimError)
    await expect(new DrizzlePgJobProgressStore(lost.pool).write(fence, 1, { percent: 500 })).rejects.toThrow()
  })

  it("derives fence columns from the job store column map or explicit overrides, and rejects unsafe names", async () => {
    const jobColumns = { id: { name: "job_id" }, leaseOwner: { name: "owner" }, claimToken: { name: "token" }, attempts: { name: "tries" }, leaseExpiresAt: { name: "lease_until" } } as never
    const mapped = createScriptedPgPool(() => [progressRow()])
    await new DrizzlePgJobProgressStore(mapped.pool, { schema: "app", jobsTable: "platform_jobs", jobColumns }).write(fence, 0, { percent: 1 })
    expect(mapped.calls[0]!.sql).toContain('"job_id"=$1 AND "owner"=$2 AND "token"=$3 AND "tries"=$4 AND "lease_until" > clock_timestamp()')
    expect(mapped.calls[0]!.sql).toContain("app.platform_jobs")
    const overridden = createScriptedPgPool(() => [progressRow()])
    await new DrizzlePgJobProgressStore(overridden.pool, { jobColumns, fenceColumns: { workerId: "custom_owner" } }).write(fence, 0, { percent: 1 })
    expect(overridden.calls[0]!.sql).toContain('"custom_owner"=$2')
    const defaults = createScriptedPgPool(() => [progressRow()])
    await new DrizzlePgJobProgressStore(defaults.pool).write(fence, 0, { percent: 1 })
    expect(defaults.calls[0]!.sql).toContain('"worker_id"=$2')
    const unnamed = { ...(jobColumns as object), leaseOwner: {} } as never
    expect(() => new DrizzlePgJobProgressStore(createScriptedPgPool(() => []).pool, { jobColumns: unnamed })).toThrow("job progress 'workerId'")
    expect(() => new DrizzlePgJobProgressStore(createScriptedPgPool(() => []).pool, { fenceColumns: { id: 'bad"name' } })).toThrow("Unsafe or missing PostgreSQL column name")
    expect(() => new DrizzlePgJobProgressStore(createScriptedPgPool(() => []).pool, { jobColumns: { ...(jobColumns as object), id: {} } as never })).toThrow("job progress 'id'")
  })
})

const mysqlRevisionRow = (overrides: Record<string, unknown> = {}) => ({ scope_id: resource.scopeId, entity_type: "invoice", entity_id: "i1", revision: 2, occurred_at: at(10), kind: "updated", state: '{"n":2}', entity_version: 4, event_id: "e1", audit_id: "a1", ...overrides })

describe("MySQL temporal history store", () => {
  const afterHeads = (headsAffected: number, created = 0) => (call: PoolCall) => {
    if (call.sql.startsWith("UPDATE")) return { affectedRows: headsAffected }
    if (call.sql.startsWith("SELECT LAST_INSERT_ID")) return [{ revision: 5 }]
    if (call.sql.startsWith("INSERT IGNORE")) return { affectedRows: created }
    return { affectedRows: 1 }
  }

  it("advances an existing head and records the revision in one transaction", async () => {
    const scripted = createScriptedMySqlPool(afterHeads(1))
    const store = new DrizzleMySqlTemporalHistoryStore(scripted.pool as never)
    const revision = await store.append({ ...resource, occurredAt: at(10), kind: "updated", state: { n: 2 }, entityVersion: 4, eventId: "e1", auditId: "a1" })
    expect(revision).toMatchObject({ revision: 5, kind: "updated", entityVersion: 4 })
    expect(scripted.events).toEqual(["begin", "commit", "release"])
    expect(scripted.calls.at(-1)!.sql).toContain("INSERT INTO `temporal_revisions`")
    expect(scripted.calls.at(-1)!.params.slice(0, 4)).toEqual([resource.scopeId, "invoice", "i1", 5])
  })

  it("creates a new head only for created revisions and rejects everything else", async () => {
    const created = createScriptedMySqlPool(afterHeads(0, 1))
    expect((await new DrizzleMySqlTemporalHistoryStore(created.pool as never).append({ ...resource, occurredAt: at(0), kind: "created", state: { n: 1 } })).revision).toBe(1)
    const raced = createScriptedMySqlPool(afterHeads(0, 0))
    await expect(new DrizzleMySqlTemporalHistoryStore(raced.pool as never).append({ ...resource, occurredAt: at(0), kind: "created", state: { n: 1 } })).rejects.toBeInstanceOf(ConflictError)
    expect(raced.events).toEqual(["begin", "rollback", "release"])
    const invalidTransition = createScriptedMySqlPool(afterHeads(0))
    await expect(new DrizzleMySqlTemporalHistoryStore(invalidTransition.pool as never).append({ ...resource, occurredAt: at(0), kind: "updated", state: { n: 1 } })).rejects.toBeInstanceOf(ConflictError)
    expect(invalidTransition.calls.some((call) => call.sql.startsWith("INSERT IGNORE"))).toBe(false)
    const unusable = createScriptedMySqlPool((call) => (call.sql.startsWith("SELECT LAST_INSERT_ID") ? [{ revision: 0 }] : { affectedRows: 1 }))
    await expect(new DrizzleMySqlTemporalHistoryStore(unusable.pool as never).append({ ...resource, occurredAt: at(0), kind: "updated", state: { n: 1 } })).rejects.toBeInstanceOf(ConflictError)
  })

  it("works against a bare connection without opening a transaction", async () => {
    const scripted = createScriptedMySqlPool(afterHeads(1))
    const connection = (await scripted.pool.getConnection()) as never
    const revision = await new DrizzleMySqlTemporalHistoryStore(connection).append({ ...resource, occurredAt: at(10), kind: "deleted", state: null })
    expect(revision.state).toBeNull()
    expect(scripted.events).toEqual([])
  })

  it("saves and reads snapshots and revision pages", async () => {
    const saved = createScriptedMySqlPool(() => ({ affectedRows: 1 }))
    const store = new DrizzleMySqlTemporalHistoryStore(saved.pool as never, { database: "app", tables: { temporalSnapshots: "snaps" } })
    await store.saveSnapshot({ ...resource, revision: 1, occurredAt: at(1), state: { n: 1 } })
    await store.saveSnapshot({ ...resource, revision: 2, occurredAt: at(2), state: null })
    expect(saved.calls[0]!.sql).toContain("`app`.`snaps`")
    expect(saved.calls[1]!.params[5]).toBeNull()
    expect(await new DrizzleMySqlTemporalHistoryStore(createScriptedMySqlPool(() => [{ revision: "2", occurred_at: at(2), state: { n: 2 } }]).pool as never).latestSnapshot(resource, at(100))).toMatchObject({ revision: 2, state: { n: 2 } })
    expect((await new DrizzleMySqlTemporalHistoryStore(createScriptedMySqlPool(() => [{ revision: 2, occurred_at: at(2), state: null }]).pool as never).latestSnapshot(resource, at(100)))?.state).toBeNull()
    expect(await new DrizzleMySqlTemporalHistoryStore(createScriptedMySqlPool(() => []).pool as never).latestSnapshot(resource, at(100))).toBeNull()
    const pages = createScriptedMySqlPool(() => [mysqlRevisionRow({ revision: 1, kind: "created" }), mysqlRevisionRow({ revision: 2 }), mysqlRevisionRow({ revision: 3, entity_version: null, event_id: null, audit_id: null })])
    const page = await new DrizzleMySqlTemporalHistoryStore(pages.pool as never).revisions(resource, { afterRevision: 0, asOf: at(100), limit: 2 })
    expect(page.items.map((item) => item.revision)).toEqual([1, 2])
    expect(page.hasMore).toBe(true)
    expect((await new DrizzleMySqlTemporalHistoryStore(createScriptedMySqlPool(() => [mysqlRevisionRow()]).pool as never).revisions(resource, { afterRevision: 0, asOf: at(100), limit: 2 })).hasMore).toBe(false)
  })

  it("renders DDL with overridden table names and rejects unknown overrides", () => {
    expect(mysqlTemporalSchemaSql({ tables: { temporalHeads: "h", temporalRevisions: "r", temporalSnapshots: "s" } })).toContain("EXISTS `h`(")
    expect(mysqlTemporalSchemaSql()).toContain("EXISTS `temporal_heads`(")
    expect(MYSQL_TEMPORAL_STORE_TABLES.temporalRevisions).toBe("temporal_revisions")
    expect(() => new DrizzleMySqlTemporalHistoryStore(createScriptedMySqlPool(() => []).pool as never, { tables: { nope: "x" } as never })).toThrow("Unknown MySQL table override")
    expect(mysqlSequenceSchemaSql({ tables: { sequences: "seq" } })).toContain("EXISTS `seq`(")
  })
})

describe("MySQL sequence store", () => {
  it("allocates from the insert id and rejects unusable results", async () => {
    const ok = createScriptedMySqlPool(() => ({ insertId: 9 }))
    expect(await new DrizzleMySqlSequenceStore(ok.pool as never, { tables: { sequences: "seq" } }).next("fscope:v1:s" as never, "invoice", "2026")).toBe(9)
    expect(ok.calls[0]!.sql).toContain("INSERT INTO `seq`")
    for (const header of [{ insertId: 0 }, { insertId: 1.5 }, {}]) {
      await expect(new DrizzleMySqlSequenceStore(createScriptedMySqlPool(() => header).pool as never).next("s" as never, "n", "p")).rejects.toThrow("MySQL sequence allocation failed")
    }
  })
})

describe("MySQL job progress store", () => {
  const fence = { jobId: "j1", workerId: "w1", claimToken: "tok", attempt: 2 }
  const stored = (overrides: Record<string, unknown> = {}) => ({ job_id: "j1", attempt: "2", sequence: "1", percent: "10", checkpoint: { step: 1 }, updated_at: at(5), ...overrides })

  it("reads progress, omitting null percent and checkpoint", async () => {
    expect(await new DrizzleMySqlJobProgressStore(createScriptedMySqlPool(() => [stored()]).pool as never).read("j1")).toMatchObject({ jobId: "j1", attempt: 2, sequence: 1, percent: 10, checkpoint: { step: 1 } })
    const sparse = await new DrizzleMySqlJobProgressStore(createScriptedMySqlPool(() => [stored({ percent: null, checkpoint: null })]).pool as never).read("j1")
    expect(sparse).not.toHaveProperty("percent")
    expect(sparse).not.toHaveProperty("checkpoint")
    expect(await new DrizzleMySqlJobProgressStore(createScriptedMySqlPool(() => []).pool as never).read("j1")).toBeNull()
  })

  const writeResponder = (options: { owner?: boolean; current?: number | null } = {}) => (call: PoolCall) => {
    if (call.sql.includes("FOR UPDATE") && call.sql.includes("FROM `jobs`")) return options.owner === false ? [] : [{ 1: 1 }]
    if (call.sql.includes("FOR UPDATE")) return options.current === null || options.current === undefined ? [] : [{ sequence: options.current }]
    if (call.sql.startsWith("INSERT")) return { affectedRows: 1 }
    return [stored({ sequence: "3" })]
  }

  it("inserts the first write and updates an existing row at the expected sequence", async () => {
    const first = createScriptedMySqlPool(writeResponder({ current: null }))
    const written = await new DrizzleMySqlJobProgressStore(first.pool as never).write(fence, 0, { percent: 10, checkpoint: { a: 1 } })
    expect(written.sequence).toBe(3)
    expect(first.events).toEqual(["begin", "commit", "release"])
    expect(first.calls.find((call) => call.sql.startsWith("INSERT"))!.params).toEqual(["j1", 2, 1, 10, '{"a":1}'])
    const next = createScriptedMySqlPool(writeResponder({ current: 4 }))
    await new DrizzleMySqlJobProgressStore(next.pool as never).write(fence, 4, {})
    expect(next.calls.find((call) => call.sql.startsWith("INSERT"))!.params).toEqual(["j1", 2, 5, null, null])
  })

  it("rolls back for lost ownership and sequence conflicts", async () => {
    const lost = createScriptedMySqlPool(writeResponder({ owner: false }))
    await expect(new DrizzleMySqlJobProgressStore(lost.pool as never).write(fence, 0, { percent: 1 })).rejects.toBeInstanceOf(StaleClaimError)
    expect(lost.events).toEqual(["begin", "rollback", "release"])
    await expect(new DrizzleMySqlJobProgressStore(createScriptedMySqlPool(writeResponder({ current: 7 })).pool as never).write(fence, 3, { percent: 1 })).rejects.toBeInstanceOf(ConflictError)
    await expect(new DrizzleMySqlJobProgressStore(createScriptedMySqlPool(writeResponder({ current: null })).pool as never).write(fence, 2, { percent: 1 })).rejects.toBeInstanceOf(ConflictError)
    const scripted = createScriptedMySqlPool(writeResponder())
    await expect(new DrizzleMySqlJobProgressStore(scripted.pool as never).write(fence, 0, { percent: 500 })).rejects.toThrow()
    expect(scripted.calls).toEqual([])
    expect(MYSQL_JOB_PROGRESS_TABLES).toEqual({ jobProgress: "job_progress", jobs: "jobs" })
  })
})
