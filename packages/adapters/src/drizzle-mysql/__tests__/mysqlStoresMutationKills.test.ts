import { describe, expect, it } from "vitest"
import { mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { CacheAdapterError } from "@xonava/core/cache"
import { ConfigurationError, ConflictError, StaleClaimError } from "@xonava/core/domain"
import type { InboxKey, OutboxDeliveryKey, OutboxRecord } from "@xonava/core/events"
import { DrizzleMySqlJobProgressStore } from "../drizzleJobProgressStore"
import { DrizzleMySqlSequenceStore } from "../drizzleSequenceStore"
import { DrizzleMySqlTemporalHistoryStore, mysqlTemporalSchemaSql, MYSQL_TEMPORAL_SCHEMA_SQL } from "../drizzleTemporalHistoryStore"
import { DrizzleMySqlOutboxSink } from "../drizzleOutboxSink"
import { MySqlTagGenerationStore } from "../mysqlTagGenerationStore"
import { createMySqlInboxStore, createMySqlLeaseStore, createMySqlOutboxStore, MySqlAtomicLeaseBackend, MySqlAtomicRecordBackend } from "../mysqlAtomicBackends"
import { assertMySqlBinaryCollation, assertMySqlUtcSession } from "../mysqlPredicate"
import { mysqlIdentifier, mysqlQualifiedTable, resolveMySqlTableNames, resolveMySqlTables } from "../mysqlIdentifiers"
import { getMySqlAffectedRows, validateMySqlConstraintMap, validateMySqlTransactionTimeout } from "../mysqlUtils"
import { createScriptedDb } from "../../__tests__/support/scriptedDb"
import { createScriptedMySqlPool, type PoolCall } from "../../__tests__/support/scriptedPool"

const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms)
const resource = { scopeId: "fscope:v1:t" as never, entityType: "invoice", entityId: "i1" }
const SCOPE = "fscope:v1:s" as never

describe("MySQL temporal history store: statements", () => {
  const revisionRow = (overrides: Record<string, unknown> = {}) => ({ scope_id: resource.scopeId, entity_type: "invoice", entity_id: "i1", revision: 2, occurred_at: at(10), kind: "updated", state: '{"n":2}', entity_version: 4, event_id: "e1", audit_id: "a1", ...overrides })
  const afterHeads = (headsAffected: number, created = 0) => (call: PoolCall) => {
    if (call.sql.startsWith("UPDATE")) return { affectedRows: headsAffected }
    if (call.sql.startsWith("SELECT LAST_INSERT_ID")) return [{ revision: 5 }]
    if (call.sql.startsWith("INSERT IGNORE")) return { affectedRows: created }
    return { affectedRows: 1 }
  }

  it("advances a head with one fenced UPDATE and then records the revision", async () => {
    const scripted = createScriptedMySqlPool(afterHeads(1))
    await new DrizzleMySqlTemporalHistoryStore(scripted.pool as never).append({ ...resource, occurredAt: at(10), kind: "updated", state: { n: 2 }, entityVersion: 4, eventId: "e1", auditId: "a1" })
    expect(scripted.calls.map((call) => [call.sql, call.params])).toEqual([
      ["UPDATE `temporal_heads` SET revision=LAST_INSERT_ID(revision+1),occurred_at=?,kind=? WHERE scope_hash=UNHEX(SHA2(?,256)) AND entity_type=? AND entity_id=? AND occurred_at<=? AND ((kind='deleted' AND ?='restored') OR (kind<>'deleted' AND ? IN ('updated','deleted')))",
        [at(10), "updated", resource.scopeId, "invoice", "i1", at(10), "updated", "updated"]],
      ["SELECT LAST_INSERT_ID() AS revision", []],
      ["INSERT INTO `temporal_revisions`(scope_id,entity_type,entity_id,revision,occurred_at,kind,state,entity_version,event_id,audit_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [resource.scopeId, "invoice", "i1", 5, at(10), "updated", '{"n":2}', 4, "e1", "a1"]],
    ])
  })

  it("inserts a head only for a created revision, with exact parameters", async () => {
    const scripted = createScriptedMySqlPool(afterHeads(0, 1))
    const revision = await new DrizzleMySqlTemporalHistoryStore(scripted.pool as never).append({ ...resource, occurredAt: at(0), kind: "created", state: { n: 1 } })
    expect(revision.revision).toBe(1)
    expect(scripted.calls[1]).toMatchObject({ sql: "INSERT IGNORE INTO `temporal_heads`(scope_id,entity_type,entity_id,revision,occurred_at,kind) VALUES(?,?,?,1,?,'created')", params: [resource.scopeId, "invoice", "i1", at(0)] })
    expect(scripted.calls[2]!.params).toEqual([resource.scopeId, "invoice", "i1", 1, at(0), "created", '{"n":1}', null, null, null])
  })

  it("stores a deleted revision with a null state and no optional ids", async () => {
    const scripted = createScriptedMySqlPool(afterHeads(1))
    await new DrizzleMySqlTemporalHistoryStore(scripted.pool as never).append({ ...resource, occurredAt: at(10), kind: "deleted", state: null })
    expect(scripted.calls.at(-1)!.params).toEqual([resource.scopeId, "invoice", "i1", 5, at(10), "deleted", null, null, null, null])
  })

  it("rejects with the exact conflict message, and treats an unreadable assigned revision as a conflict", async () => {
    const message = "Temporal revision rejected: not chronological, not a valid lifecycle transition, or the entity already exists"
    await expect(new DrizzleMySqlTemporalHistoryStore(createScriptedMySqlPool(afterHeads(0)).pool as never).append({ ...resource, occurredAt: at(0), kind: "updated", state: { n: 1 } })).rejects.toThrow(new ConflictError(message))
    const empty = createScriptedMySqlPool((call) => (call.sql.startsWith("SELECT LAST_INSERT_ID") ? [] : { affectedRows: 1 }))
    const failure = await new DrizzleMySqlTemporalHistoryStore(empty.pool as never).append({ ...resource, occurredAt: at(0), kind: "updated", state: { n: 1 } }).then(() => null, (error: unknown) => error)
    expect(failure).toEqual(new ConflictError(message))
    expect(empty.events).toEqual(["begin", "rollback", "release"])
  })

  it("works with a connection that has no release method and with a bare connection", async () => {
    const calls: string[] = []
    const events: string[] = []
    const connection = {
      query: async (sql: string) => { calls.push(sql); return [afterHeads(1)({ sql, params: [], via: "connection" }), undefined] as [unknown, unknown] },
      beginTransaction: async () => { events.push("begin") },
      commit: async () => { events.push("commit") },
      rollback: async () => { events.push("rollback") },
    }
    const pool = { ...connection, getConnection: async () => connection }
    await new DrizzleMySqlTemporalHistoryStore(pool as never).append({ ...resource, occurredAt: at(10), kind: "updated", state: { n: 2 } })
    expect(events).toEqual(["begin", "commit"])
    const bare = createScriptedMySqlPool(afterHeads(1))
    await new DrizzleMySqlTemporalHistoryStore({ query: bare.pool.query } as never).append({ ...resource, occurredAt: at(10), kind: "updated", state: { n: 2 } })
    expect(bare.events).toEqual([])
  })

  it("saves a snapshot with an idempotent insert and a null state when there is none", async () => {
    const saved = createScriptedMySqlPool(() => ({ affectedRows: 1 }))
    const store = new DrizzleMySqlTemporalHistoryStore(saved.pool as never)
    await store.saveSnapshot({ ...resource, revision: 3, occurredAt: at(5), state: { n: 3 } })
    await store.saveSnapshot({ ...resource, revision: 4, occurredAt: at(6), state: null })
    const sql = "INSERT IGNORE INTO `temporal_snapshots`(scope_id,entity_type,entity_id,revision,occurred_at,state) VALUES(?,?,?,?,?,?)"
    expect(saved.calls.map((call) => [call.sql, call.params])).toEqual([
      [sql, [resource.scopeId, "invoice", "i1", 3, at(5), '{"n":3}']],
      [sql, [resource.scopeId, "invoice", "i1", 4, at(6), null]],
    ])
  })

  it("reads the latest snapshot at or before a time", async () => {
    const found = createScriptedMySqlPool(() => [{ revision: "3", occurred_at: at(5), state: '{"n":3}' }])
    expect(await new DrizzleMySqlTemporalHistoryStore(found.pool as never).latestSnapshot(resource, at(9))).toEqual({ ...resource, revision: 3, occurredAt: at(5), state: { n: 3 } })
    expect(found.calls).toEqual([{ via: "pool", sql: "SELECT * FROM `temporal_snapshots` WHERE scope_hash=UNHEX(SHA2(?,256)) AND entity_type=? AND entity_id=? AND occurred_at<=? ORDER BY revision DESC LIMIT 1", params: [resource.scopeId, "invoice", "i1", at(9)] }])
    for (const state of [null, undefined]) {
      const none = createScriptedMySqlPool(() => [{ revision: 0, occurred_at: at(5), state }])
      expect((await new DrizzleMySqlTemporalHistoryStore(none.pool as never).latestSnapshot(resource, at(9)))?.state).toBeNull()
    }
    const object = createScriptedMySqlPool(() => [{ revision: 1, occurred_at: at(5), state: { n: 9 } }])
    expect((await new DrizzleMySqlTemporalHistoryStore(object.pool as never).latestSnapshot(resource, at(9)))?.state).toEqual({ n: 9 })
    expect(await new DrizzleMySqlTemporalHistoryStore(createScriptedMySqlPool(() => []).pool as never).latestSnapshot(resource, at(9))).toBeNull()
  })

  it("pages revisions after a revision and reports more only when a further row exists", async () => {
    const rows = [revisionRow({ revision: 1, kind: "created" }), revisionRow({ revision: 2 })]
    const exact = createScriptedMySqlPool(() => rows)
    const page = await new DrizzleMySqlTemporalHistoryStore(exact.pool as never).revisions(resource, { afterRevision: 1, asOf: at(100), limit: 2 })
    expect(page.items.map((item) => item.revision)).toEqual([1, 2])
    expect(page.hasMore).toBe(false)
    expect(exact.calls).toEqual([{ via: "pool", sql: "SELECT * FROM `temporal_revisions` WHERE scope_hash=UNHEX(SHA2(?,256)) AND entity_type=? AND entity_id=? AND revision>? AND occurred_at<=? ORDER BY revision LIMIT ?", params: [resource.scopeId, "invoice", "i1", 1, at(100), 3] }])
    const more = createScriptedMySqlPool(() => [...rows, revisionRow({ revision: 3 })])
    const morePage = await new DrizzleMySqlTemporalHistoryStore(more.pool as never).revisions(resource, { afterRevision: 0, asOf: at(100), limit: 2 })
    expect(morePage.hasMore).toBe(true)
    expect(morePage.items).toHaveLength(2)
  })

  it("decodes optional revision fields, keeping zero versions and dropping nulls", async () => {
    const full = createScriptedMySqlPool(() => [revisionRow({ entity_version: 0, state: { n: 2 } })])
    const [item] = (await new DrizzleMySqlTemporalHistoryStore(full.pool as never).revisions(resource, { afterRevision: 0, asOf: at(100), limit: 5 })).items
    expect(item).toMatchObject({ entityVersion: 0, eventId: "e1", auditId: "a1", state: { n: 2 } })
    for (const missing of [null, undefined]) {
      const sparse = createScriptedMySqlPool(() => [revisionRow({ kind: "deleted", state: missing, entity_version: missing, event_id: missing, audit_id: missing })])
      const [gone] = (await new DrizzleMySqlTemporalHistoryStore(sparse.pool as never).revisions(resource, { afterRevision: 0, asOf: at(100), limit: 5 })).items
      expect(gone!.state).toBeNull()
      expect(gone).not.toHaveProperty("entityVersion")
      expect(gone).not.toHaveProperty("eventId")
      expect(gone).not.toHaveProperty("auditId")
    }
    const onlyEvent = createScriptedMySqlPool(() => [revisionRow({ entity_version: null, audit_id: null })])
    const [partial] = (await new DrizzleMySqlTemporalHistoryStore(onlyEvent.pool as never).revisions(resource, { afterRevision: 0, asOf: at(100), limit: 5 })).items
    expect(partial).toMatchObject({ eventId: "e1" })
    expect(partial).not.toHaveProperty("entityVersion")
    expect(partial).not.toHaveProperty("auditId")
  })

  it("rewrites every table name in the schema DDL", () => {
    const custom = mysqlTemporalSchemaSql({ database: "app", tables: { temporalHeads: "h", temporalRevisions: "r", temporalSnapshots: "s" } })
    expect(custom).toContain("EXISTS `app`.`h`(")
    expect(custom).toContain("EXISTS `app`.`r`(")
    expect(custom).toContain("EXISTS `app`.`s`(")
    expect(custom).not.toContain("EXISTS temporal_")
    const defaults = mysqlTemporalSchemaSql()
    expect(defaults).toContain("EXISTS `temporal_heads`(")
    expect(defaults).toContain("EXISTS `temporal_revisions`(")
    expect(defaults).toContain("EXISTS `temporal_snapshots`(")
    expect(MYSQL_TEMPORAL_SCHEMA_SQL).toContain("EXISTS temporal_heads(")
  })
})

describe("MySQL sequence and job progress statements", () => {
  it("allocates a sequence value with exact SQL and parameters", async () => {
    const scripted = createScriptedMySqlPool(() => ({ insertId: 1 }))
    expect(await new DrizzleMySqlSequenceStore(scripted.pool as never).next("s" as never, "invoice", "2026")).toBe(1)
    expect(scripted.calls).toEqual([{ via: "pool", sql: "INSERT INTO `sequences`(scope_id,name,period,value) VALUES(?,?,?,LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE value=LAST_INSERT_ID(value+1)", params: ["s", "invoice", "2026"] }])
  })

  const fence = { jobId: "j1", workerId: "w1", claimToken: "tok", attempt: 2 }
  const stored = (overrides: Record<string, unknown> = {}) => ({ job_id: "j1", attempt: 2, sequence: "3", percent: "10", checkpoint: '{"step":1}', updated_at: at(5).toISOString(), ...overrides })

  it("reads progress by job id", async () => {
    const scripted = createScriptedMySqlPool(() => [stored()])
    const progress = await new DrizzleMySqlJobProgressStore(scripted.pool as never, { database: "app" }).read("j1")
    expect(scripted.calls).toEqual([{ via: "pool", sql: "SELECT job_id,attempt,sequence,CAST(percent AS CHAR) AS percent,checkpoint,updated_at FROM `app`.`job_progress` WHERE job_id=?", params: ["j1"] }])
    expect(progress).toEqual({ jobId: "j1", attempt: 2, sequence: 3, percent: 10, checkpoint: { step: 1 }, updatedAt: at(5).toISOString() })
  })

  it("writes through a fenced transaction with exact statements", async () => {
    const scripted = createScriptedMySqlPool((call) => {
      if (call.sql.includes("FOR UPDATE") && call.sql.includes("FROM `jobs`")) return [{ 1: 1 }]
      if (call.sql.includes("FOR UPDATE")) return [{ sequence: 2 }]
      if (call.sql.startsWith("INSERT")) return { affectedRows: 1 }
      return [stored()]
    })
    await new DrizzleMySqlJobProgressStore(scripted.pool as never).write(fence, 2, { percent: 55, checkpoint: { a: 1 } })
    expect(scripted.calls.map((call) => [call.sql, call.params])).toEqual([
      ["SELECT 1 FROM `jobs` WHERE id=? AND worker_id=? AND claim_token=? AND attempt=? AND lease_expires_at>CURRENT_TIMESTAMP(3) FOR UPDATE", ["j1", "w1", "tok", 2]],
      ["SELECT sequence FROM `job_progress` WHERE job_id=? FOR UPDATE", ["j1"]],
      ["INSERT INTO `job_progress`(job_id,attempt,sequence,percent,checkpoint,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE attempt=VALUES(attempt),sequence=VALUES(sequence),percent=VALUES(percent),checkpoint=VALUES(checkpoint),updated_at=VALUES(updated_at)", ["j1", 2, 3, 55, '{"a":1}']],
      ["SELECT job_id,attempt,sequence,CAST(percent AS CHAR) AS percent,checkpoint,updated_at FROM `job_progress` WHERE job_id=?", ["j1"]],
    ])
    expect(scripted.calls.map((call) => call.via)).toEqual(["connection", "connection", "connection", "connection"])
    expect(scripted.events).toEqual(["begin", "commit", "release"])
  })

  it("reports the exact lost-ownership and conflict messages", async () => {
    const lost = createScriptedMySqlPool((call) => (call.sql.includes("FROM `jobs`") ? [] : [stored()]))
    await expect(new DrizzleMySqlJobProgressStore(lost.pool as never).write(fence, 0, { percent: 1 })).rejects.toThrow(new StaleClaimError("Job progress ownership was lost"))
    const conflict = (current: number | null, expected: number) => createScriptedMySqlPool((call) => {
      if (call.sql.includes("FROM `jobs`")) return [{ 1: 1 }]
      if (call.sql.includes("FOR UPDATE")) return current === null ? [] : [{ sequence: current }]
      return [stored()]
    })
    await expect(new DrizzleMySqlJobProgressStore(conflict(7, 3).pool as never).write(fence, 3, { percent: 1 })).rejects.toThrow(new ConflictError("Job progress sequence conflict"))
    await expect(new DrizzleMySqlJobProgressStore(conflict(null, 2).pool as never).write(fence, 2, { percent: 1 })).rejects.toThrow(new ConflictError("Job progress sequence conflict"))
    const first = conflict(null, 0)
    await new DrizzleMySqlJobProgressStore(first.pool as never).write(fence, 0, { percent: 1 })
    expect(first.events).toEqual(["begin", "commit", "release"])
  })
})

describe("MySQL tag generation store", () => {
  it("reads a generation, defaulting to zero", async () => {
    const found = createScriptedMySqlPool(() => [{ generation: 7 }])
    expect(await new MySqlTagGenerationStore(found.pool as never).getTagGeneration("t1")).toBe("7")
    expect(found.calls).toEqual([{ via: "pool", sql: "SELECT generation FROM `cache_generations` WHERE scope=?", params: ["t1"] }])
    expect(await new MySqlTagGenerationStore(createScriptedMySqlPool(() => []).pool as never).getTagGeneration("t1")).toBe("0")
    expect(await new MySqlTagGenerationStore(createScriptedMySqlPool(() => [{ generation: "12" }]).pool as never).getTagGeneration("t1")).toBe("12")
  })

  it("advances a generation in one transaction", async () => {
    const scripted = createScriptedMySqlPool((call) => (call.sql.startsWith("SELECT LAST_INSERT_ID") ? [{ generation: 4 }] : { affectedRows: 1 }))
    expect(await new MySqlTagGenerationStore(scripted.pool as never).advanceTagGeneration("t1")).toBe("4")
    expect(scripted.calls).toEqual([
      { via: "connection", sql: "INSERT INTO `cache_generations`(scope,generation) VALUES(?,LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE generation=LAST_INSERT_ID(generation+1)", params: ["t1"] },
      { via: "connection", sql: "SELECT LAST_INSERT_ID() generation", params: [] },
    ])
    expect(scripted.events).toEqual(["begin", "commit", "release"])
  })

  it("rolls back, releases and wraps a failure", async () => {
    const cause = new Error("db down")
    const scripted = createScriptedMySqlPool(() => { throw cause })
    const failure = await new MySqlTagGenerationStore(scripted.pool as never).advanceTagGeneration("t1").then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(CacheAdapterError)
    expect((failure as CacheAdapterError).operation).toBe("advanceTagGeneration")
    expect((failure as CacheAdapterError).cause).toBe(cause)
    expect(scripted.events).toEqual(["begin", "rollback", "release"])
  })

  it("accepts a table name or store options", async () => {
    const named = createScriptedMySqlPool(() => [])
    await new MySqlTagGenerationStore(named.pool as never, "gens").getTagGeneration("t")
    expect(named.calls[0]!.sql).toBe("SELECT generation FROM `gens` WHERE scope=?")
    const qualified = createScriptedMySqlPool(() => [])
    await new MySqlTagGenerationStore(qualified.pool as never, { database: "app", tables: { cacheGenerations: "gens" } }).getTagGeneration("t")
    expect(qualified.calls[0]!.sql).toBe("SELECT generation FROM `app`.`gens` WHERE scope=?")
  })
})

describe("MySQL atomic record backend", () => {
  const key: InboxKey = { consumerKey: "c", messageId: "m", scopeId: SCOPE }
  const outboxKey: OutboxDeliveryKey = { messageId: "m", scopeId: SCOPE }
  const responder = (record: unknown) => (call: PoolCall) => {
    if (call.sql.startsWith("SELECT record")) return record === undefined ? [] : [{ record }]
    if (call.sql.startsWith("SELECT CURRENT_TIMESTAMP")) return [{ now: "2026-01-01 00:00:00.000" }]
    return { affectedRows: 1 }
  }

  it("is transactional and reads a record with exact SQL, releasing its connection", async () => {
    const scripted = createScriptedMySqlPool(responder('{"n":1}'))
    const backend = new MySqlAtomicRecordBackend<InboxKey, { n: number }>(scripted.pool as never, "atomic_records", () => "the-key")
    expect(backend.transactional).toBe(true)
    expect(await backend.read(key)).toEqual({ n: 1 })
    expect(scripted.calls).toEqual([{ via: "connection", sql: "SELECT record FROM `atomic_records` WHERE record_key=?", params: ["the-key"] }])
    expect(scripted.events).toEqual(["release"])
    expect(await new MySqlAtomicRecordBackend(createScriptedMySqlPool(responder({ n: 2 })).pool as never, "atomic_records", () => "k").read(key)).toEqual({ n: 2 })
  })

  it("reads nothing as null and releases the connection even when the query fails", async () => {
    expect(await new MySqlAtomicRecordBackend(createScriptedMySqlPool(responder(undefined)).pool as never, "atomic_records", () => "k").read(key)).toBeNull()
    expect(await new MySqlAtomicRecordBackend(createScriptedMySqlPool(responder(null)).pool as never, "atomic_records", () => "k").read(key)).toBeNull()
    const broken = createScriptedMySqlPool(() => { throw new Error("boom") })
    await expect(new MySqlAtomicRecordBackend(broken.pool as never, "atomic_records", () => "k").read(key)).rejects.toThrow("boom")
    expect(broken.events).toEqual(["release"])
  })

  it("transacts with exact statements and hands the transition its inputs", async () => {
    const scripted = createScriptedMySqlPool(responder('{"n":1}'))
    const backend = new MySqlAtomicRecordBackend<InboxKey, { n: number }>(scripted.pool as never, "atomic_records", () => "the-key", { database: "app" })
    let seen: unknown[] = []
    const result = await backend.transact<string>(key, ((...args: unknown[]) => { seen = args; return { record: { n: 2 }, result: "done" } }) as never)
    expect(result).toBe("done")
    expect(scripted.calls.map((call) => [call.sql, call.params])).toEqual([
      ["INSERT IGNORE INTO `app`.`atomic_records`(record_key,record,revision) VALUES(?,NULL,0)", ["the-key"]],
      ["SELECT record FROM `app`.`atomic_records` WHERE record_key=? FOR UPDATE", ["the-key"]],
      ["SELECT CURRENT_TIMESTAMP(3) now", []],
      ["UPDATE `app`.`atomic_records` SET record=?,revision=revision+1 WHERE record_key=?", ['{"n":2}', "the-key"]],
    ])
    expect(seen[0]).toEqual({ n: 1 })
    expect(seen[1]).toBeInstanceOf(Date)
    expect(typeof seen[2]).toBe("function")
    expect(seen[3]).toBeDefined()
    expect(scripted.events).toEqual(["begin", "commit", "release"])
  })

  it("passes a null record to the transition when none is stored", async () => {
    let current: unknown = "unset"
    await new MySqlAtomicRecordBackend(createScriptedMySqlPool(responder(undefined)).pool as never, "atomic_records", () => "k").transact(key, ((value: unknown) => { current = value; return { record: {}, result: 1 } }) as never)
    expect(current).toBeNull()
  })

  it.each([
    ["errno 1213", { errno: 1213 }],
    ["errno 1205", { errno: 1205 }],
    ["code ER_LOCK_DEADLOCK", { code: "ER_LOCK_DEADLOCK" }],
    ["code ER_LOCK_WAIT_TIMEOUT", { code: "ER_LOCK_WAIT_TIMEOUT" }],
  ])("retries on %s", async (_name, signal) => {
    let failures = 1
    const scripted = createScriptedMySqlPool((call) => {
      if (call.sql.startsWith("SELECT record") && failures-- > 0) throw Object.assign(new Error("retry me"), signal)
      return responder(undefined)(call)
    })
    const backend = new MySqlAtomicRecordBackend(scripted.pool as never, "atomic_records", () => "k")
    expect(await backend.transact(key, () => ({ record: {}, result: 5 }))).toBe(5)
    expect(scripted.events).toEqual(["begin", "rollback", "release", "begin", "commit", "release"])
  })

  it("does not retry other errors", async () => {
    for (const signal of [{ errno: 1062 }, { code: "ER_DUP_ENTRY" }, {}]) {
      const scripted = createScriptedMySqlPool((call) => { if (call.sql.startsWith("SELECT record")) throw Object.assign(new Error("fatal"), signal); return [] })
      await expect(new MySqlAtomicRecordBackend(scripted.pool as never, "atomic_records", () => "k").transact(key, () => ({ record: {}, result: 1 }))).rejects.toThrow("fatal")
      expect(scripted.events).toEqual(["begin", "rollback", "release"])
    }
  })

  it("keys inbox and outbox records and qualifies tables only when a database is given", async () => {
    const inboxPool = createScriptedMySqlPool(responder(undefined))
    await createMySqlInboxStore(inboxPool.pool as never).get(key)
    expect(inboxPool.calls[0]).toMatchObject({ sql: "SELECT record FROM `atomic_records` WHERE record_key=?", params: [`${SCOPE}:c:m`] })
    const outboxPool = createScriptedMySqlPool(responder(undefined))
    await createMySqlOutboxStore(outboxPool.pool as never, { database: "app", tables: { atomicRecords: "box" } }).get(outboxKey)
    expect(outboxPool.calls[0]).toMatchObject({ sql: "SELECT record FROM `app`.`box` WHERE record_key=?", params: [`${SCOPE}:m`] })
    const legacy = createScriptedMySqlPool(responder(undefined))
    await createMySqlOutboxStore(legacy.pool as never, "legacy_box").get(outboxKey)
    expect(legacy.calls[0]!.sql).toBe("SELECT record FROM `legacy_box` WHERE record_key=?")
  })
})

describe("MySQL atomic lease backend", () => {
  const lease = { owner: "a", fencingToken: 1 }
  const resourceKey = { scopeId: SCOPE, namespace: "ns", resourceId: "r1" }
  const responder = (current: unknown) => (call: PoolCall) => {
    if (call.sql.startsWith("SELECT lease FROM")) return [{ lease: current }]
    if (call.sql.startsWith("SELECT CURRENT_TIMESTAMP")) return [{ now: "2026-01-01 00:00:00.000" }]
    if (call.sql.startsWith("SELECT (SELECT lease")) return [{ lease: current, now: "2026-01-01 00:00:00.000" }]
    return { affectedRows: 1 }
  }

  it("transitions with exact statements and persists the new lease", async () => {
    const scripted = createScriptedMySqlPool(responder(JSON.stringify(lease)))
    const backend = new MySqlAtomicLeaseBackend(scripted.pool as never, "app_leases", { database: "app" })
    let seen: unknown[] = []
    const result = await backend.transition<string>(resourceKey as never, ((...args: unknown[]) => { seen = args; return { lease: { owner: "b" }, result: "changed" } }) as never)
    expect(result).toBe("changed")
    const key = `${SCOPE}:ns:r1`
    expect(scripted.calls.map((call) => [call.sql, call.params])).toEqual([
      ["INSERT IGNORE INTO `app`.`app_leases`(resource_key,lease,revision) VALUES(?,NULL,0)", [key]],
      ["SELECT lease FROM `app`.`app_leases` WHERE resource_key=? FOR UPDATE", [key]],
      ["SELECT CURRENT_TIMESTAMP(3) now", []],
      ["UPDATE `app`.`app_leases` SET lease=?,revision=revision+1 WHERE resource_key=?", ['{"owner":"b"}', key]],
    ])
    expect(seen[0]).toEqual(lease)
    expect(seen[1]).toEqual(new Date("2026-01-01 00:00:00.000"))
    expect(typeof seen[2]).toBe("function")
    expect(scripted.events).toEqual(["begin", "commit", "release"])
  })

  it("stores a released lease as SQL NULL and defaults the table name", async () => {
    const scripted = createScriptedMySqlPool(responder(null))
    let current: unknown = "unset"
    await new MySqlAtomicLeaseBackend(scripted.pool as never).transition(resourceKey as never, ((value: unknown) => { current = value; return { lease: null, result: 1 } }) as never)
    expect(current).toBeNull()
    expect(scripted.calls[0]!.sql).toBe("INSERT IGNORE INTO `leases`(resource_key,lease,revision) VALUES(?,NULL,0)")
    expect(scripted.calls[3]!.params).toEqual([null, `${SCOPE}:ns:r1`])
  })

  it("reads the lease and the backend clock in one statement and releases the connection", async () => {
    const scripted = createScriptedMySqlPool(responder({ owner: "a" }))
    const read = await new MySqlAtomicLeaseBackend(scripted.pool as never, "app_leases", { database: "app" }).read(resourceKey as never)
    expect(read).toEqual({ lease: { owner: "a" }, backendNow: new Date("2026-01-01 00:00:00.000") })
    expect(scripted.calls).toEqual([{ via: "connection", sql: "SELECT (SELECT lease FROM `app`.`app_leases` WHERE resource_key=?) lease,CURRENT_TIMESTAMP(3) now", params: [`${SCOPE}:ns:r1`] }])
    expect(scripted.events).toEqual(["release"])
    const none = await new MySqlAtomicLeaseBackend(createScriptedMySqlPool(responder(undefined)).pool as never).read(resourceKey as never)
    expect(none.lease).toBeNull()
    const text = await new MySqlAtomicLeaseBackend(createScriptedMySqlPool(responder('{"owner":"z"}')).pool as never).read(resourceKey as never)
    expect(text.lease).toEqual({ owner: "z" })
  })

  it("qualifies lease tables only when a database is given", async () => {
    const scripted = createScriptedMySqlPool(responder(null))
    await createMySqlLeaseStore(scripted.pool as never, { database: "app", tables: { leases: "ls" } }).assertCurrent({ resource: resourceKey, owner: "a", fencingToken: 1 } as never).catch(() => undefined)
    expect(scripted.calls[0]!.sql).toContain("`app`.`ls`")
    const plain = createScriptedMySqlPool(responder(null))
    await createMySqlLeaseStore(plain.pool as never).assertCurrent({ resource: resourceKey, owner: "a", fencingToken: 1 } as never).catch(() => undefined)
    expect(plain.calls[0]!.sql).toContain("FROM `leases`")
  })
})

describe("MySQL collation and session assertions", () => {
  const recording = (rows: Record<string, unknown>[]) => {
    const calls: { sql: string; params: unknown[] | undefined }[] = []
    return { calls, db: { query: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return [rows, undefined] as [unknown, unknown] } } }
  }

  it("rejects unsafe table or column identifiers with the exact message before querying", async () => {
    for (const [table, columns] of [["bad table", ["ok"]], [" ok", ["ok"]], ["ok ", ["ok"]], ["ok", ["bad col"]], ["ok", [" a"]], ["ok", ["a "]], ["ok", ["fine", "a-b"]], ["", ["a"]], ["ok", [""]], ["t\n", ["a"]]] as const) {
      const f = recording([])
      await expect(assertMySqlBinaryCollation(f.db, table, columns)).rejects.toThrow(new ConfigurationError("Unsafe MySQL identifier"))
      expect(f.calls).toEqual([])
    }
  })

  it("accepts multi-character identifiers and issues one query with every column as a parameter", async () => {
    const f = recording([{ name: "col_1", collation: "utf8mb4_0900_bin", pad: "NO PAD" }, { name: "Col2", collation: "utf8mb4_0900_bin", pad: "NO PAD" }])
    await assertMySqlBinaryCollation(f.db, "tbl_9", ["col_1", "Col2"])
    expect(f.calls).toEqual([{ sql: "SELECT c.COLUMN_NAME AS name, c.COLLATION_NAME AS collation, k.PAD_ATTRIBUTE AS pad FROM information_schema.COLUMNS c LEFT JOIN information_schema.COLLATIONS k ON k.COLLATION_NAME = c.COLLATION_NAME WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME=? AND c.COLUMN_NAME IN (?,?)", params: ["tbl_9", "col_1", "Col2"] }])
  })

  it("does not query when there are no columns", async () => {
    const f = recording([])
    await assertMySqlBinaryCollation(f.db, "tbl", [])
    expect(f.calls).toEqual([])
  })

  it("skips columns without a collation and names the failing column and collation", async () => {
    await expect(assertMySqlBinaryCollation(recording([{ name: "n" }]).db, "tbl", ["n"])).resolves.toBeUndefined()
    await expect(assertMySqlBinaryCollation(recording([{ name: "n", collation: null, pad: null }]).db, "tbl", ["n"])).resolves.toBeUndefined()
    await expect(assertMySqlBinaryCollation(recording([]).db, "tbl", ["gone"])).rejects.toThrow(new ConfigurationError("Column tbl.gone does not exist"))
    await expect(assertMySqlBinaryCollation(recording([{ name: "a", collation: "utf8mb4_general_ci", pad: "NO PAD" }]).db, "tbl", ["a"])).rejects.toThrow(new ConfigurationError("Column tbl.a uses non-binary collation utf8mb4_general_ci; predicates would ignore case"))
    await expect(assertMySqlBinaryCollation(recording([{ name: "a", collation: "utf8mb4_bin", pad: "PAD SPACE" }]).db, "tbl", ["a"])).rejects.toThrow(new ConfigurationError("Column tbl.a uses PAD SPACE collation utf8mb4_bin; predicates would ignore trailing spaces (use utf8mb4_0900_bin)"))
    await expect(assertMySqlBinaryCollation(recording([{ name: "a", collation: "utf8mb4_bin", pad: null }]).db, "tbl", ["a"])).rejects.toThrow("PAD SPACE")
  })

  it("checks both daylight-saving instants independently, with the exact query and message", async () => {
    const calls: string[] = []
    const session = (winter: unknown, summer: unknown) => ({ query: async (sql: string) => { calls.push(sql); return [[{ winter, summer }], undefined] as [unknown, unknown] } })
    await expect(assertMySqlUtcSession(session(1704067200, 1719792000))).resolves.toBeUndefined()
    expect(calls).toEqual(["SELECT UNIX_TIMESTAMP('2024-01-01 00:00:00') AS winter, UNIX_TIMESTAMP('2024-07-01 00:00:00') AS summer"])
    const message = "MySQL session time_zone is not UTC; TIMESTAMP predicates compare in the session zone (set time_zone='+00:00')"
    await expect(assertMySqlUtcSession(session(1704067200 + 3600, 1719792000))).rejects.toThrow(new ConfigurationError(message))
    await expect(assertMySqlUtcSession(session(1704067200, 1719792000 + 3600))).rejects.toThrow(new ConfigurationError(message))
    await expect(assertMySqlUtcSession(session(1704067200 + 3600, 1719792000 + 3600))).rejects.toThrow(new ConfigurationError(message))
    await expect(assertMySqlUtcSession(session(1719792000, 1704067200))).rejects.toThrow(new ConfigurationError(message))
  })
})

describe("MySQL identifiers", () => {
  it("names what was rejected without echoing it", () => {
    expect(() => mysqlIdentifier("bad name")).toThrow(new ConfigurationError("Unsafe MySQL identifier"))
    expect(() => mysqlIdentifier("bad name", "table name")).toThrow(new ConfigurationError("Unsafe MySQL table name"))
    expect(() => mysqlQualifiedTable("ok", "bad db")).toThrow(new ConfigurationError("Unsafe MySQL database name"))
    expect(() => mysqlQualifiedTable("bad t")).toThrow(new ConfigurationError("Unsafe MySQL table name"))
    expect(mysqlQualifiedTable("ok", "app")).toBe("`app`.`ok`")
    expect(mysqlQualifiedTable("ok")).toBe("`ok`")
  })

  const defaults = Object.freeze({ a: "alpha", b: "beta" })
  it("rejects non-object options and overrides with their own messages", () => {
    for (const options of [null, "x", 5, true]) {
      expect(() => resolveMySqlTableNames(defaults, options as never)).toThrow(new ConfigurationError("MySQL store options must be an object"))
    }
    for (const tables of ["str", 5, true]) {
      expect(() => resolveMySqlTableNames(defaults, { tables } as never)).toThrow(new ConfigurationError("MySQL table overrides must be an object"))
    }
    expect(resolveMySqlTableNames(defaults, undefined)).toEqual({ tables: defaults })
    expect(resolveMySqlTableNames(defaults, { tables: null } as never)).toEqual({ tables: defaults })
  })

  it("reports unknown overrides with a sanitized, truncated key", () => {
    expect(() => resolveMySqlTableNames(defaults, { tables: { nope: "x" } } as never)).toThrow(new ConfigurationError('Unknown MySQL table override "nope"'))
    expect(() => resolveMySqlTableNames(defaults, { tables: { "a-b`; DROP": "x" } } as never)).toThrow(new ConfigurationError('Unknown MySQL table override "abDROP"'))
    expect(() => resolveMySqlTableNames(defaults, { tables: { [`z${"y".repeat(80)}`]: "x" } } as never)).toThrow(new ConfigurationError(`Unknown MySQL table override "z${"y".repeat(63)}"`))
    expect(() => resolveMySqlTableNames(defaults, { tables: { toString: "x" } } as never)).toThrow('Unknown MySQL table override "toString"')
  })

  it("validates each override and database, and returns frozen tables", () => {
    expect(() => resolveMySqlTableNames(defaults, { tables: { a: "bad name" } })).toThrow(new ConfigurationError("Unsafe MySQL table name"))
    expect(() => resolveMySqlTableNames(defaults, { database: "bad db" })).toThrow(new ConfigurationError("Unsafe MySQL database name"))
    const resolved = resolveMySqlTableNames(defaults, { database: "app", tables: { b: "custom" } })
    expect(resolved).toEqual({ database: "app", tables: { a: "alpha", b: "custom" } })
    expect(Object.isFrozen(resolved.tables)).toBe(true)
    expect(resolveMySqlTableNames(defaults, {})).toEqual({ tables: { a: "alpha", b: "beta" } })
    expect("database" in resolveMySqlTableNames(defaults, {})).toBe(false)
    expect(resolveMySqlTables(defaults, { database: "app", tables: { b: "custom" } })).toEqual({ a: "`app`.`alpha`", b: "`app`.`custom`" })
    expect(Object.isFrozen(resolveMySqlTables(defaults, undefined))).toBe(true)
  })
})

describe("MySQL utilities", () => {
  it("extracts affected rows from every result shape", () => {
    expect(getMySqlAffectedRows([{ affectedRows: 3 }, undefined])).toBe(3)
    expect(getMySqlAffectedRows({ affectedRows: 4 })).toBe(4)
    expect(getMySqlAffectedRows({ rowsAffected: 5 })).toBe(5)
    expect(getMySqlAffectedRows({ affectedRows: 0, rowsAffected: 9 })).toBe(0)
    for (const bad of [null, undefined, 0, 7, "text", true, [], [null], [undefined], {}, { affectedRows: "3" }, { rowsAffected: "3" }, { affectedRows: null, rowsAffected: "x" }]) {
      expect(getMySqlAffectedRows(bad)).toBe(0)
    }
  })

  it("validates transaction timeouts at their boundaries with the exact message", () => {
    const message = "MySQL transaction timeoutMs must be an integer from 1 to 2147483647"
    expect(validateMySqlTransactionTimeout(1)).toBe(1)
    expect(validateMySqlTransactionTimeout(2147483647)).toBe(2147483647)
    for (const bad of [0, -1, 1.5, Number.NaN, 2147483648, 2 ** 53, "5", null, {}]) {
      expect(() => validateMySqlTransactionTimeout(bad)).toThrow(new ConfigurationError(message))
    }
  })

  it("explains every constraint map rejection", () => {
    expect(() => validateMySqlConstraintMap(null)).toThrow(new ConfigurationError("MySQL constraintMap must be an object mapping unique index names to field names"))
    expect(() => validateMySqlConstraintMap({ "": "a" })).toThrow(new ConfigurationError("MySQL constraintMap keys must be non-empty index names"))
    expect(() => validateMySqlConstraintMap({ " ": "a" })).toThrow(new ConfigurationError("MySQL constraintMap keys must be non-empty index names"))
    expect(() => validateMySqlConstraintMap({ [Symbol("s")]: "a" })).toThrow(new ConfigurationError("MySQL constraintMap keys must be non-empty index names"))
    const getter = Object.defineProperty({}, "idx", { get: () => "email", enumerable: true })
    expect(() => validateMySqlConstraintMap(getter)).toThrow(new ConfigurationError('MySQL constraintMap entry "idx" must be a plain own property'))
    const hidden = Object.defineProperty({}, "idx", { value: "email", enumerable: false })
    expect(() => validateMySqlConstraintMap(hidden)).toThrow(new ConfigurationError('MySQL constraintMap entry "idx" must be a plain own property'))
    expect(() => validateMySqlConstraintMap({ idx: "" })).toThrow(new ConfigurationError('MySQL constraintMap entry "idx" must map to a non-empty field name'))
    expect(() => validateMySqlConstraintMap({ idx: "  " })).toThrow(new ConfigurationError('MySQL constraintMap entry "idx" must map to a non-empty field name'))
    expect(() => validateMySqlConstraintMap({ idx: 5 })).toThrow(new ConfigurationError('MySQL constraintMap entry "idx" must map to a non-empty field name'))
    expect(validateMySqlConstraintMap({ idx: " email " })).toEqual({ idx: " email " })
  })
})

describe("MySQL outbox sink guards", () => {
  const full = mysqlTable("outbox", { id: varchar("id", { length: 36 }), tenantId: varchar("tenant_id", { length: 64 }), idempotencyScope: varchar("idempotency_scope", { length: 255 }), idempotencyKey: varchar("idempotency_key", { length: 255 }), eventFingerprint: varchar("event_fingerprint", { length: 128 }) })
  const noId = mysqlTable("outbox", { tenantId: varchar("tenant_id", { length: 64 }), idempotencyKey: varchar("idempotency_key", { length: 255 }), eventFingerprint: varchar("event_fingerprint", { length: 128 }) })
  const noKey = mysqlTable("outbox", { id: varchar("id", { length: 36 }), tenantId: varchar("tenant_id", { length: 64 }), eventFingerprint: varchar("event_fingerprint", { length: 128 }) })
  const noFingerprint = mysqlTable("outbox", { id: varchar("id", { length: 36 }), tenantId: varchar("tenant_id", { length: 64 }), idempotencyKey: varchar("idempotency_key", { length: 255 }) })
  const noScope = mysqlTable("outbox", { id: varchar("id", { length: 36 }), idempotencyKey: varchar("idempotency_key", { length: 255 }), eventFingerprint: varchar("event_fingerprint", { length: 128 }) })
  const record = {
    id: "event-1", type: "a.created", version: 1, tenantId: "tenant-1", scope: { kind: "tenant", tenantId: "tenant-1" }, scopeId: "fscope:v1:eyJraW5kIjoidGVuYW50IiwidGVuYW50SWQiOiJ0ZW5hbnQtMSJ9",
    aggregateType: "a", aggregateId: "a1", payload: { a: 1 }, idempotencyKey: "key-1", occurredAt: new Date("2026-08-10T00:00:00Z"),
  } as unknown as OutboxRecord

  it("requires every identity column", async () => {
    const message = "MySQL outbox requires id, idempotency scope, idempotency key and event fingerprint columns"
    for (const table of [noId, noKey, noFingerprint, noScope]) {
      const scripted = createScriptedDb("mysql", () => [])
      await expect(new DrizzleMySqlOutboxSink(scripted.db as never, table, () => ({})).append(record)).rejects.toThrow(new ConfigurationError(message))
      expect(scripted.ops).toEqual([])
    }
  })

  it("does not let the mapper override any framework-owned column", async () => {
    for (const field of ["id", "tenantId", "idempotencyScope", "idempotencyKey", "eventFingerprint"]) {
      const scripted = createScriptedDb("mysql", () => [])
      await expect(new DrizzleMySqlOutboxSink(scripted.db as never, full, () => ({ [field]: "forged" })).append(record)).rejects.toThrow(new ConfigurationError(`Outbox mapper cannot override the framework-owned ${field}`))
      expect(scripted.ops).toEqual([])
    }
  })
})
