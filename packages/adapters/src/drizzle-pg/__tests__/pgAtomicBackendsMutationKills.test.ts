import { describe, expect, it } from "vitest"
import type { FencedLease, LeaseResourceKey } from "@xonava/core/events"
import { createPgLeaseStore, PgAtomicLeaseBackend } from "../pgAtomicLeaseBackend"
import { PgAtomicRecordBackend } from "../pgAtomicRecordBackend"
import { pgSchemaName } from "../pgSchemaName"
import { createScriptedPgPool, type PoolCall } from "../../__tests__/support/scriptedPool"

const SCOPE = "fscope:v1:a" as never
const resource: LeaseResourceKey = { namespace: "jobs", resourceId: "r1", scopeId: SCOPE }
const NOW = new Date("2026-01-01T00:00:00.000Z")
const squash = (sql: string) => sql.replace(/\s+/g, " ").trim()

describe("PgAtomicLeaseBackend statements", () => {
  it("runs the exact locked transaction and persists the new lease as JSON", async () => {
    const stored: FencedLease = { resource, owner: "o", fencingToken: 7, expiresAt: "2026-01-01T00:01:00.000Z" } as never
    const scripted = createScriptedPgPool((call: PoolCall) => {
      if (call.sql.startsWith("SELECT lease FROM")) return [{ lease: stored }]
      if (call.sql.startsWith("SELECT clock_timestamp()")) return [{ now: NOW }]
      return { rows: [], rowCount: 1 }
    })
    const backend = new PgAtomicLeaseBackend(scripted.pool, "app.leases")
    let seen: unknown[] = []
    const result = await backend.transition<string>(resource, (current, now, fresh) => {
      seen = [current, now, typeof fresh(), fresh() === fresh()]
      return { lease: { ...stored, fencingToken: 8 }, result: "done" }
    })
    expect(result).toBe("done")
    expect(seen).toEqual([stored, NOW, "string", false])
    const key = "fscope:v1:a:jobs:r1"
    expect(scripted.calls.map((c) => [squash(c.sql), c.params])).toEqual([
      ["BEGIN", []],
      ["INSERT INTO app.leases (resource_key, lease, revision) VALUES ($1, NULL, 0) ON CONFLICT DO NOTHING", [key]],
      ["SELECT lease FROM app.leases WHERE resource_key = $1 FOR UPDATE", [key]],
      ["SELECT clock_timestamp() AS now", []],
      ["UPDATE app.leases SET lease = $2::jsonb, revision = revision + 1 WHERE resource_key = $1", [key, JSON.stringify({ ...stored, fencingToken: 8 })]],
      ["COMMIT", []],
    ])
    expect(scripted.events.at(-1)).toBe("release")
    expect(scripted.events).not.toContain("ROLLBACK")
  })

  it("writes SQL NULL when the transition clears the lease and treats a missing row as no lease", async () => {
    const scripted = createScriptedPgPool((call: PoolCall) => {
      if (call.sql.startsWith("SELECT clock_timestamp()")) return [{ now: NOW.toISOString() }]
      return []
    })
    const backend = new PgAtomicLeaseBackend(scripted.pool)
    let seen: unknown = "unset"
    let seenNow: unknown
    await backend.transition(resource, (current, now) => { seen = current; seenNow = now; return { lease: null, result: undefined } })
    expect(seen).toBeNull()
    expect(seenNow).toEqual(NOW)
    expect(seenNow).toBeInstanceOf(Date)
    const update = scripted.calls.find((c) => c.sql.startsWith("UPDATE"))!
    expect(update.sql).toContain("lease_records")
    expect(update.params).toEqual(["fscope:v1:a:jobs:r1", null])
  })

  it("rolls back, rethrows the same error and never commits when the change throws", async () => {
    const scripted = createScriptedPgPool(() => [{ now: NOW }])
    const failure = new Error("boom")
    await expect(new PgAtomicLeaseBackend(scripted.pool).transition(resource, () => { throw failure })).rejects.toBe(failure)
    expect(scripted.calls.map((c) => squash(c.sql).split(" ")[0])).toEqual(["BEGIN", "INSERT", "SELECT", "SELECT", "ROLLBACK"])
    expect(scripted.events.at(-1)).toBe("release")
  })

  it("reads the lease and the database clock in one statement", async () => {
    const stored = { owner: "o" }
    const scripted = createScriptedPgPool(() => [{ lease: stored, now: NOW.toISOString() }])
    const read = await new PgAtomicLeaseBackend(scripted.pool, "app.leases").read(resource)
    expect(read).toEqual({ lease: stored, backendNow: NOW })
    expect(read.backendNow).toBeInstanceOf(Date)
    expect(scripted.calls).toHaveLength(1)
    expect(squash(scripted.calls[0]!.sql)).toBe("SELECT (SELECT lease FROM app.leases WHERE resource_key = $1) AS lease, clock_timestamp() AS now")
    expect(scripted.calls[0]!.params).toEqual(["fscope:v1:a:jobs:r1"])
    expect(scripted.events.at(-1)).toBe("release")
    const missing = createScriptedPgPool(() => [{ lease: undefined, now: NOW }])
    expect((await new PgAtomicLeaseBackend(missing.pool).read(resource)).lease).toBeNull()
  })
})

describe("createPgLeaseStore table resolution", () => {
  async function tableUsed(pool: never, store: ReturnType<typeof createPgLeaseStore>): Promise<string> {
    await store.acquire(resource, "a", 1_000)
    return squash((pool as never as { calls: PoolCall[] }).calls[1]!.sql)
  }
  const make = () => {
    const scripted = createScriptedPgPool((call: PoolCall) => (call.sql.startsWith("SELECT clock_timestamp()") ? [{ now: NOW }] : []))
    return scripted
  }

  it("uses a string argument as the table name, the default otherwise", async () => {
    const a = make()
    expect(await tableUsed(a as never, createPgLeaseStore(a.pool, "my_schema.my_leases"))).toContain("INSERT INTO my_schema.my_leases ")
    const b = make()
    expect(await tableUsed(b as never, createPgLeaseStore(b.pool))).toContain("INSERT INTO lease_records ")
    const c = make()
    expect(await tableUsed(c as never, createPgLeaseStore(c.pool, {}))).toContain("INSERT INTO lease_records ")
  })

  it("qualifies the configured table with the lower-cased validated schema", async () => {
    const a = make()
    expect(await tableUsed(a as never, createPgLeaseStore(a.pool, { schema: "Tenant_A", tables: { leases: "my_leases" } }))).toContain("INSERT INTO tenant_a.my_leases ")
    const b = make()
    expect(await tableUsed(b as never, createPgLeaseStore(b.pool, { tables: { leases: "plain" } }))).toContain("INSERT INTO plain ")
    const c = make()
    expect(await tableUsed(c as never, createPgLeaseStore(c.pool, { schema: "s1" }))).toContain("INSERT INTO s1.lease_records ")
  })

  it("rejects unsafe names with the exact messages", () => {
    const { pool } = make()
    expect(() => new PgAtomicLeaseBackend(pool, "a.b.c")).toThrow("Unsafe lease table name")
    expect(() => new PgAtomicLeaseBackend(pool, "Upper")).toThrow("Unsafe lease table name")
    expect(() => new PgAtomicLeaseBackend(pool, "bad;")).toThrow("Unsafe lease table name")
    expect(() => new PgAtomicLeaseBackend(pool, "x.y")).not.toThrow()
    expect(() => createPgLeaseStore(pool, { tables: { leases: "s.t" } })).toThrow("Unsafe lease table name")
    expect(() => createPgLeaseStore(pool, { tables: { leases: "_ok9" } })).not.toThrow()
    expect(() => pgSchemaName("")).toThrow("Unsafe PostgreSQL schema name")
    expect(() => pgSchemaName("1abc")).toThrow("Unsafe PostgreSQL schema name")
    expect(() => pgSchemaName("a".repeat(64))).toThrow("Unsafe PostgreSQL schema name")
    expect(() => pgSchemaName("bad-name")).toThrow("Unsafe PostgreSQL schema name")
    expect(() => pgSchemaName(5 as never)).toThrow("Unsafe PostgreSQL schema name")
    expect(() => pgSchemaName(["abc"] as never)).toThrow("Unsafe PostgreSQL schema name")
    expect(() => pgSchemaName({ toString: () => "abc" } as never)).toThrow("Unsafe PostgreSQL schema name")
    expect(pgSchemaName("a".repeat(63))).toBe("a".repeat(63))
    expect(pgSchemaName("_A9")).toBe("_A9")
  })
})

describe("PgAtomicRecordBackend statements", () => {
  type Key = { id: string }
  const encodeKey = (k: Key) => `k:${k.id}`

  it("reads by encoded key, returning null for a missing row", async () => {
    const hit = createScriptedPgPool(() => [{ record: { n: 1 } }])
    const backend = new PgAtomicRecordBackend<Key, { n: number }>({ pool: hit.pool, table: "app.recs", encodeKey })
    expect(await backend.read({ id: "a" })).toEqual({ n: 1 })
    expect(squash(hit.calls[0]!.sql)).toBe("SELECT record FROM app.recs WHERE record_key = $1")
    expect(hit.calls[0]!.params).toEqual(["k:a"])
    expect(hit.events.at(-1)).toBe("release")
    const miss = createScriptedPgPool(() => [])
    expect(await new PgAtomicRecordBackend<Key, { n: number }>({ pool: miss.pool, table: "recs", encodeKey }).read({ id: "a" })).toBeNull()
  })

  it("runs the exact locked transaction with database time and persists the record", async () => {
    const scripted = createScriptedPgPool((call: PoolCall) => {
      if (call.sql.includes("FOR UPDATE")) return [{ record: { n: 1 } }]
      if (call.sql.startsWith("SELECT clock_timestamp()")) return [{ now: NOW }]
      return { rows: [], rowCount: 1 }
    })
    const backend = new PgAtomicRecordBackend<Key, { n: number }>({ pool: scripted.pool, table: "app.recs", encodeKey })
    let seen: unknown[] = []
    const result = await backend.transact<string>({ id: "a" }, async (current, now, fresh, tx) => {
      seen = [current, now, typeof fresh(), tx !== undefined]
      return { record: { n: 2 }, result: "ok" }
    })
    expect(result).toBe("ok")
    expect(seen).toEqual([{ n: 1 }, NOW, "string", true])
    expect(scripted.calls.map((c) => [squash(c.sql), c.params])).toEqual([
      ["BEGIN", []],
      ["INSERT INTO app.recs (record_key, record, revision) VALUES ($1, 'null'::jsonb, 0) ON CONFLICT DO NOTHING", ["k:a"]],
      ["SELECT record FROM app.recs WHERE record_key = $1 FOR UPDATE", ["k:a"]],
      ["SELECT clock_timestamp() AS now", []],
      ["UPDATE app.recs SET record = $2::jsonb, revision = revision + 1 WHERE record_key = $1", ["k:a", '{"n":2}']],
      ["COMMIT", []],
    ])
    expect(scripted.events.at(-1)).toBe("release")
  })

  it("passes null when the locked row is missing and rolls back the same error", async () => {
    const scripted = createScriptedPgPool((call: PoolCall) => (call.sql.startsWith("SELECT clock_timestamp()") ? [{ now: NOW }] : []))
    const backend = new PgAtomicRecordBackend<Key, { n: number }>({ pool: scripted.pool, table: "recs", encodeKey })
    let seen: unknown = "unset"
    await backend.transact({ id: "a" }, (current) => { seen = current; return { record: { n: 1 }, result: 0 } })
    expect(seen).toBeNull()
    const failure = new Error("stale")
    const failing = createScriptedPgPool(() => [{ now: NOW }])
    await expect(new PgAtomicRecordBackend<Key, { n: number }>({ pool: failing.pool, table: "recs", encodeKey })
      .transact({ id: "a" }, () => { throw failure })).rejects.toBe(failure)
    expect(failing.calls.map((c) => squash(c.sql).split(" ")[0])).toEqual(["BEGIN", "INSERT", "SELECT", "SELECT", "ROLLBACK"])
    expect(failing.events.at(-1)).toBe("release")
  })

  it("accepts only lower-case schema-qualified identifiers", () => {
    const { pool } = createScriptedPgPool(() => [])
    const make = (table: string) => new PgAtomicRecordBackend({ pool, table, encodeKey: () => "" })
    for (const bad of ["a.b.c", "Upper", "1abc", "a b", "a.", ".a", "a;b", ""]) expect(() => make(bad)).toThrow("Unsafe atomic-record table name")
    for (const good of ["a", "_a1", "s.t", "s_1.t_2"]) expect(() => make(good)).not.toThrow()
  })
})
