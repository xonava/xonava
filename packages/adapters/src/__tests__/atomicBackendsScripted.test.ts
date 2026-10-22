import { describe, expect, it } from "vitest"
import { ConfigurationError, StaleClaimError } from "@xonava/core/domain"
import type { InboxKey, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord } from "@xonava/core/events"
import { createPgLeaseStore, PG_LEASE_TABLES, PgAtomicLeaseBackend } from "../drizzle-pg/pgAtomicLeaseBackend"
import { PgAtomicRecordBackend } from "../drizzle-pg/pgAtomicRecordBackend"
import { getAffectedRows as pgAffectedRows, pgDate } from "../drizzle-pg/pgUtils"
import { createMySqlInboxStore, createMySqlLeaseStore, createMySqlOutboxStore, MySqlAtomicLeaseBackend, MySqlAtomicRecordBackend, MYSQL_ATOMIC_RECORD_TABLES, MYSQL_LEASE_TABLES } from "../drizzle-mysql/mysqlAtomicBackends"
import { assertMySqlBinaryCollation, assertMySqlUtcSession, compileDrizzlePredicate as compileMySqlPredicate } from "../drizzle-mysql/mysqlPredicate"
import { d1ColumnInputValue, d1ColumnKey, d1DriverValue, getAffectedRows as d1AffectedRows } from "../drizzle-d1/d1Utils"
import { renderSql } from "./support/scriptedDb"
import { createScriptedMySqlPool, createScriptedPgPool, type PoolCall } from "./support/scriptedPool"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { Predicate } from "@xonava/core/domain"

const SCOPE = "fscope:v1:a" as never
const resource = { namespace: "jobs", resourceId: "r1", scopeId: SCOPE }

/** A one-row lease table behind a node-postgres style pool: BEGIN/COMMIT/ROLLBACK are recorded, UPDATE persists the lease. */
function pgLeaseTable() {
  let lease: unknown = null
  let revision = 0
  let now = new Date("2026-01-01T00:00:00.000Z")
  const scripted = createScriptedPgPool((call: PoolCall) => {
    if (call.sql.startsWith("SELECT lease FROM")) return [{ lease }]
    if (call.sql.startsWith("SELECT clock_timestamp()")) return [{ now }]
    if (call.sql.startsWith("SELECT (SELECT lease")) return [{ lease, now }]
    if (call.sql.startsWith("UPDATE")) { lease = call.params[1] === null ? null : JSON.parse(String(call.params[1])); revision += 1; return { rows: [], rowCount: 1 } }
    return { rows: [], rowCount: 1 }
  })
  return { ...scripted, advance: (ms: number) => { now = new Date(now.getTime() + ms) }, revision: () => revision, lease: () => lease }
}

describe("PostgreSQL fenced lease backend", () => {
  it("acquires, renews, releases and fences leases inside locked transactions", async () => {
    const table = pgLeaseTable()
    const store = createPgLeaseStore(table.pool as never)
    const first = (await store.acquire(resource, "a", 60_000))!
    expect(first).toMatchObject({ owner: "a", fencingToken: 1 })
    expect(table.events.slice(0, 2)).toEqual(["BEGIN", "INSERT INTO"])
    expect(await store.acquire(resource, "b", 60_000)).toBeNull()
    await store.assertCurrent(first)
    const renewed = await store.renew(first, 120_000)
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt))
    await store.release(first)
    await expect(store.assertCurrent(first)).rejects.toBeInstanceOf(StaleClaimError)
    table.advance(1_000)
    expect((await store.acquire(resource, "b", 60_000))!.fencingToken).toBe(2)
    expect(table.revision()).toBeGreaterThanOrEqual(4)
    expect(table.events.filter((event) => event === "release").length).toBeGreaterThan(3)
  })

  it("rolls back and releases the client when the change callback throws", async () => {
    const table = pgLeaseTable()
    const backend = new PgAtomicLeaseBackend(table.pool as never, "app.lease_records")
    await expect(backend.transition(resource, () => { throw new Error("rejected") })).rejects.toThrow("rejected")
    expect(table.events).toContain("ROLLBACK")
    expect(table.events.at(-1)).toBe("release")
    const read = await backend.read(resource)
    expect(read.lease).toBeNull()
    expect(read.backendNow).toEqual(new Date("2026-01-01T00:00:00.000Z"))
  })

  it("validates table and schema names", () => {
    const { pool } = pgLeaseTable()
    expect(() => new PgAtomicLeaseBackend(pool as never, "bad name")).toThrow("Unsafe lease table name")
    expect(() => createPgLeaseStore(pool as never, { tables: { leases: "Bad-Name" } })).toThrow("Unsafe lease table name")
    expect(() => createPgLeaseStore(pool as never, { schema: "bad schema" })).toThrow(ConfigurationError)
    expect(() => createPgLeaseStore(pool as never, { schema: "Tenant_A", tables: { leases: "my_leases" } })).not.toThrow()
    expect(() => createPgLeaseStore(pool as never, {})).not.toThrow()
    expect(PG_LEASE_TABLES.leases).toBe("lease_records")
  })
})

describe("PostgreSQL atomic record backend", () => {
  const key: InboxKey = { consumerKey: "c", messageId: "m", scopeId: SCOPE }

  it("reads records and runs transitions under a row lock with database time", async () => {
    let record: unknown = null
    const scripted = createScriptedPgPool((call) => {
      if (call.sql.startsWith("SELECT record FROM") && call.sql.includes("FOR UPDATE")) return [{ record }]
      if (call.sql.startsWith("SELECT record FROM")) return record === null ? [] : [{ record }]
      if (call.sql.startsWith("SELECT clock_timestamp()")) return [{ now: new Date("2026-01-01T00:00:00.000Z") }]
      if (call.sql.startsWith("UPDATE")) { record = JSON.parse(String(call.params[1])); return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 1 }
    })
    const backend = new PgAtomicRecordBackend<InboxKey, { n: number }>({ pool: scripted.pool as never, table: "app.atomic_records", encodeKey: (k) => `${k.scopeId}:${k.consumerKey}:${k.messageId}` })
    expect(backend.transactional).toBe(true)
    expect(await backend.read(key)).toBeNull()
    const seen: unknown[] = []
    const result = await backend.transact(key, (current, now) => { seen.push(current, now); return { record: { n: 1 }, result: "ok" } })
    expect(result).toBe("ok")
    expect(seen).toEqual([null, new Date("2026-01-01T00:00:00.000Z")])
    expect(await backend.read(key)).toEqual({ n: 1 })
    await expect(backend.transact(key, () => { throw new Error("stale") })).rejects.toThrow("stale")
    expect(scripted.events).toContain("ROLLBACK")
    expect(scripted.events.at(-1)).toBe("release")
    expect(() => new PgAtomicRecordBackend({ pool: scripted.pool as never, table: "bad;table", encodeKey: () => "" })).toThrow("Unsafe atomic-record table name")
  })
})

describe("MySQL atomic backends", () => {
  const key: InboxKey = { consumerKey: "c", messageId: "m", scopeId: SCOPE }
  const outboxKey: OutboxDeliveryKey = { messageId: "m", scopeId: SCOPE }

  function recordTable() {
    let record: unknown = null
    return createScriptedMySqlPool((call) => {
      if (call.sql.startsWith("SELECT record")) return record === null ? [] : [{ record: typeof record === "string" ? record : JSON.stringify(record) }]
      if (call.sql.startsWith("SELECT CURRENT_TIMESTAMP")) return [{ now: new Date("2026-01-01T00:00:00.000Z") }]
      if (call.sql.startsWith("UPDATE")) { record = JSON.parse(String(call.params[0])); return { affectedRows: 1 } }
      return { affectedRows: 1 }
    })
  }

  it("reads, transitions and retries deadlocks up to twelve times", async () => {
    const scripted = recordTable()
    const backend = new MySqlAtomicRecordBackend<InboxKey, { n: number }>(scripted.pool as never, "atomic_records", (k) => `${k.scopeId}:${k.consumerKey}:${k.messageId}`, { database: "app" })
    expect(await backend.read(key)).toBeNull()
    expect(scripted.calls[0]!.sql).toContain("`app`.`atomic_records`")
    expect(await backend.transact(key, (current) => ({ record: { n: (current?.n ?? 0) + 1 }, result: "ok" }))).toBe("ok")
    expect(await backend.read(key)).toEqual({ n: 1 })
    expect(scripted.events).toContain("commit")
    let failures = 3
    const flaky = createScriptedMySqlPool((call) => {
      if (call.sql.startsWith("SELECT record") && failures-- > 0) throw Object.assign(new Error("deadlock"), { errno: 1213 })
      return call.sql.startsWith("SELECT CURRENT_TIMESTAMP") ? [{ now: "2026-01-01 00:00:00.000" }] : call.sql.startsWith("SELECT record") ? [] : { affectedRows: 1 }
    })
    const flakyBackend = new MySqlAtomicRecordBackend<InboxKey, { n: number }>(flaky.pool as never, "atomic_records", () => "k")
    expect(await flakyBackend.transact(key, () => ({ record: { n: 1 }, result: 7 }))).toBe(7)
    expect(flaky.events.filter((event) => event === "rollback")).toHaveLength(3)
    const hopeless = createScriptedMySqlPool((call) => { if (call.sql.startsWith("SELECT record")) throw Object.assign(new Error("lock wait"), { code: "ER_LOCK_WAIT_TIMEOUT" }); return [] })
    await expect(new MySqlAtomicRecordBackend(hopeless.pool as never, "atomic_records", () => "k").transact(key, () => ({ record: {}, result: 1 }))).rejects.toMatchObject({ code: "ER_LOCK_WAIT_TIMEOUT" })
    expect(hopeless.events.filter((event) => event === "begin")).toHaveLength(13)
    const fatal = createScriptedMySqlPool((call) => { if (call.sql.startsWith("SELECT record")) throw new Error("syntax"); return [] })
    await expect(new MySqlAtomicRecordBackend(fatal.pool as never, "atomic_records", () => "k").transact(key, () => ({ record: {}, result: 1 }))).rejects.toThrow("syntax")
    expect(fatal.events).toEqual(["begin", "rollback", "release"])
  })

  it("runs the lease lifecycle through the fenced lease store", async () => {
    let lease: unknown = null
    let now = new Date("2026-01-01T00:00:00.000Z")
    const scripted = createScriptedMySqlPool((call) => {
      if (call.sql.startsWith("SELECT lease FROM")) return [{ lease }]
      if (call.sql.startsWith("SELECT CURRENT_TIMESTAMP")) return [{ now }]
      if (call.sql.startsWith("SELECT (SELECT lease")) return [{ lease, now }]
      if (call.sql.startsWith("UPDATE")) { lease = call.params[0] === null ? null : JSON.parse(String(call.params[0])); return { affectedRows: 1 } }
      return { affectedRows: 1 }
    })
    const store = createMySqlLeaseStore(scripted.pool as never, { database: "app", tables: { leases: "app_leases" } })
    const first = (await store.acquire(resource, "a", 60_000))!
    expect(first.fencingToken).toBe(1)
    expect(await store.acquire(resource, "b", 60_000)).toBeNull()
    await store.assertCurrent(first)
    const renewed = await store.renew(first, 120_000)
    expect(renewed.owner).toBe("a")
    await store.release(first)
    await expect(store.assertCurrent(first)).rejects.toBeInstanceOf(StaleClaimError)
    now = new Date(now.getTime() + 1_000)
    expect((await store.acquire(resource, "b", 60_000))!.fencingToken).toBe(2)
    expect(scripted.calls.some((call) => call.sql.includes("`app`.`app_leases`"))).toBe(true)
    expect(new MySqlAtomicLeaseBackend(scripted.pool as never)).toBeInstanceOf(MySqlAtomicLeaseBackend)
  })

  it("creates inbox and outbox stores from a table name or options", () => {
    const pool = recordTable().pool as never
    expect(createMySqlInboxStore(pool)).toBeDefined()
    expect(createMySqlInboxStore(pool, "custom_records")).toBeDefined()
    expect(createMySqlOutboxStore(pool, { database: "app", tables: { atomicRecords: "custom" } })).toBeDefined()
    expect(createMySqlLeaseStore(pool)).toBeDefined()
    expect(createMySqlLeaseStore(pool, "custom_leases")).toBeDefined()
    expect(MYSQL_ATOMIC_RECORD_TABLES.atomicRecords).toBe("atomic_records")
    expect(MYSQL_LEASE_TABLES.leases).toBe("leases")
    expect(() => createMySqlInboxStore(pool, "bad table")).toThrow(ConfigurationError)
  })

  it("persists inbox and outbox deliveries as JSON records", async () => {
    const inboxPool = recordTable()
    const inbox = createMySqlInboxStore(inboxPool.pool as never)
    const at = new Date().toISOString()
    const observed = await inbox.observe({
      ...key, consumerDefinitionVersion: 1, state: "pending", attempt: 0, replayGeneration: 0, claim: null, firstObservedAt: at, lastObservedAt: at, eventFormatVersion: 1, eventPayloadVersion: 1,
      originalProvenance: { format: "framework.authority-provenance", formatVersion: 1, correlationId: "c" } as never, replay: { kind: "original-delivery" }, history: [],
    } as InboxRecord)
    expect(observed.state).toBe("pending")
    expect((await inbox.get(key))?.state).toBe("pending")
    const outbox = createMySqlOutboxStore(recordTable().pool as never)
    const appended = await outbox.append({ envelope: { messageId: "m", eventType: "x", payloadVersion: 1, payload: {} } as never, scopeId: SCOPE, idempotencyKey: "k", state: "pending", attempt: 0, claim: null } as OutboxDeliveryRecord)
    expect(appended.state).toBe("pending")
    expect((await outbox.get(outboxKey))?.state).toBe("pending")
  })
})

describe("MySQL collation and session assertions", () => {
  const collations = (rows: Record<string, unknown>[]) => ({ query: async () => [rows, undefined] as [unknown, unknown] })

  it("accepts NO PAD binary collations and rejects everything else", async () => {
    await expect(assertMySqlBinaryCollation(collations([{ name: "a", collation: "utf8mb4_0900_bin", pad: "NO PAD" }]), "t", ["a"])).resolves.toBeUndefined()
    await expect(assertMySqlBinaryCollation(collations([]), "t", [])).resolves.toBeUndefined()
    await expect(assertMySqlBinaryCollation(collations([{ name: "n", collation: null, pad: null }]), "t", ["n"])).resolves.toBeUndefined()
    await expect(assertMySqlBinaryCollation(collations([{ name: "a", collation: "utf8mb4_bin", pad: "PAD SPACE" }]), "t", ["a"])).rejects.toThrow("PAD SPACE")
    await expect(assertMySqlBinaryCollation(collations([{ name: "a", collation: "utf8mb4_general_ci", pad: "PAD SPACE" }]), "t", ["a"])).rejects.toThrow("non-binary collation")
    await expect(assertMySqlBinaryCollation(collations([]), "t", ["missing"])).rejects.toThrow("does not exist")
    await expect(assertMySqlBinaryCollation(collations([]), "t; DROP", ["a"])).rejects.toBeInstanceOf(ConfigurationError)
    await expect(assertMySqlBinaryCollation(collations([]), "t", ["a b"])).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("accepts only a UTC session across both daylight-saving instants", async () => {
    const session = (winter: unknown, summer: unknown) => ({ query: async () => [[{ winter, summer }], undefined] as [unknown, unknown] })
    await expect(assertMySqlUtcSession(session(1704067200, 1719792000))).resolves.toBeUndefined()
    await expect(assertMySqlUtcSession(session("1704067200", "1719792000"))).resolves.toBeUndefined()
    await expect(assertMySqlUtcSession(session(1704067200, 1719788400))).rejects.toThrow("not UTC")
    await expect(assertMySqlUtcSession({ query: async () => [[], undefined] as [unknown, unknown] })).rejects.toThrow("not UTC")
  })

  it("compiles predicates for MySQL by default and lets options override", () => {
    const table = mysqlTable("t", { name: varchar("name", { length: 10 }) })
    const columns = { name: table.name }
    const defaulted = compileMySqlPredicate(Predicate.eq("name", "x"), columns)
    const binary = compileMySqlPredicate(Predicate.eq("name", "x"), columns, { mysqlBinaryCollation: true })
    expect(renderSql("mysql", defaulted)!.sql).toContain("utf8mb4_0900_bin")
    expect(renderSql("mysql", binary)!.sql).not.toContain("utf8mb4_0900_bin")
  })
})

describe("driver result helpers", () => {
  it("reads PostgreSQL affected-row counts from every supported shape", () => {
    expect(pgAffectedRows({ affectedRows: 2 })).toBe(2)
    expect(pgAffectedRows({ rowCount: 3 })).toBe(3)
    expect(pgAffectedRows({ rowsAffected: 4 })).toBe(4)
    expect(pgAffectedRows({ count: 5 })).toBe(5)
    expect(pgAffectedRows({ meta: { rowCount: 6 } })).toBe(6)
    expect(pgAffectedRows({ meta: { changes: 7 } })).toBe(7)
    expect(() => pgAffectedRows(null)).toThrow("expected an object")
    expect(() => pgAffectedRows("x")).toThrow(ConfigurationError)
    expect(() => pgAffectedRows({ meta: {} })).toThrow("could not extract affected rows")
    expect(() => pgAffectedRows({})).toThrow(ConfigurationError)
    expect(pgDate(new Date(5))).toEqual(new Date(5))
    expect(pgDate("2026-01-01T00:00:00.000Z")).toEqual(new Date("2026-01-01T00:00:00.000Z"))
  })

  it("reads D1 affected-row counts and encodes values for D1 bindings", () => {
    expect(d1AffectedRows(null)).toBe(0)
    expect(d1AffectedRows("x")).toBe(0)
    expect(d1AffectedRows({ affectedRows: 1 })).toBe(1)
    expect(d1AffectedRows({ changes: 2 })).toBe(2)
    expect(d1AffectedRows({ rowsAffected: 3 })).toBe(3)
    expect(d1AffectedRows({ count: 4 })).toBe(4)
    expect(d1AffectedRows({ meta: { changes: 5 } })).toBe(5)
    expect(d1AffectedRows({ meta: {} })).toBe(0)
    expect(d1AffectedRows({})).toBe(0)
    const table = sqliteTable("t", { id: text("id"), at: integer("at", { mode: "timestamp_ms" }), n: integer("n") })
    expect(d1ColumnKey(table, table.at)).toBe("at")
    expect(d1ColumnKey(table, { ...table.at } as never)).toBe("at")
    const other = sqliteTable("o", { x: text("x") })
    expect(() => d1ColumnKey(table, other.x)).toThrow("not declared on its table")
    expect(d1ColumnKey(table, other.x, "fallback")).toBe("fallback")
    const date = new Date(1234)
    expect(d1ColumnInputValue(table.n, date)).toBe(1234)
    expect(d1ColumnInputValue(table.at, date)).toBe(date)
    expect(d1ColumnInputValue(table.n, "plain")).toBe("plain")
    expect(d1DriverValue(table.n, null)).toBeNull()
    expect(d1DriverValue(table.n, undefined)).toBeNull()
    expect(d1DriverValue(table.at, date)).toBe(1234)
    expect(d1DriverValue(table.n, 7)).toBe(7)
    expect(d1DriverValue({} as never, new Date(9))).toBe(9)
  })
})
