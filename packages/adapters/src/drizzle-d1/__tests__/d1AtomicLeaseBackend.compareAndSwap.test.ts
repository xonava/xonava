import { describe, expect, it } from "vitest"
import { createD1LeaseStore, D1_LEASE_TABLES, D1AtomicLeaseBackend } from "../d1AtomicLeaseBackend"
import type { D1AtomicDatabase, D1Result, D1Statement } from "../d1AtomicRecordBackend"

interface StubStatement extends D1Statement { readonly sql: string; binds: unknown[] }
interface Script {
  first?: (sql: string, binds: readonly unknown[]) => unknown
  batch?: (statements: readonly StubStatement[]) => D1Result[]
}
function stub(script: Script) {
  const prepared: StubStatement[] = []
  const batches: (readonly StubStatement[])[] = []
  const database: D1AtomicDatabase = {
    prepare(sql: string) {
      const statement: StubStatement = {
        sql,
        binds: [],
        bind(...values: unknown[]) { statement.binds = values; return statement },
        first: async <T>() => (script.first ? script.first(sql, statement.binds) : null) as T | null,
        run: async () => ({}),
      }
      prepared.push(statement)
      return statement
    },
    batch: (async (statements: readonly StubStatement[]) => {
      batches.push(statements)
      return script.batch ? script.batch(statements) : [{ meta: { changes: 1 } }]
    }) as never,
  }
  return { database, prepared, batches }
}
const resource = { scopeId: "scope", namespace: "ns", resourceId: "res" } as never
const lease = { holder: "h", fencingToken: 3 }
const NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)"
const selectRow = (sql: string) => sql.startsWith("SELECT lease, revision")
const change = (outcome: { lease: unknown; result: unknown }) => (() => outcome) as never

describe("D1AtomicLeaseBackend", () => {
  it("validates the table name and defaults to the production lease table", async () => {
    expect(D1_LEASE_TABLES).toEqual({ leases: "lease_records" })
    for (const table of ["Leases", "1leases", "le ases", "leases;x", "", "lea-ses"]) {
      expect(() => new D1AtomicLeaseBackend(stub({}).database, table)).toThrow(new Error("Unsafe lease table name"))
    }
    const f = stub({ first: () => ({ lease: null, now_ms: 0 }) })
    await new D1AtomicLeaseBackend(f.database).read(resource)
    expect(f.prepared[0]!.sql).toContain("FROM lease_records WHERE")
  })

  it("updates an existing row under a revision compare-and-swap and returns the change result", async () => {
    const f = stub({ first: (sql) => (selectRow(sql) ? { lease: JSON.stringify(lease), revision: 4, now_ms: 7_000 } : null) })
    const seen: unknown[] = []
    const result = await new D1AtomicLeaseBackend(f.database, "leases").transition(resource, (current, now, uuid) => {
      seen.push(current, now, typeof uuid())
      return { lease: { holder: "n", fencingToken: 4 }, result: "acquired" } as never
    })
    expect(result).toBe("acquired")
    expect(seen).toEqual([lease, new Date(7_000), "string"])
    expect(f.prepared[0]!.sql).toBe(`SELECT lease, revision, ${NOW} AS now_ms FROM leases WHERE resource_key = ?`)
    expect(f.prepared[0]!.binds).toEqual(["scope:ns:res"])
    expect(f.prepared.filter((s) => s.sql.startsWith("SELECT"))).toHaveLength(1)
    const update = f.batches[0]![0]!
    expect(update.sql).toBe("UPDATE leases SET lease = ?, revision = revision + 1 WHERE resource_key = ? AND revision = ?")
    expect(update.binds).toEqual([JSON.stringify({ holder: "n", fencingToken: 4 }), "scope:ns:res", 4])
    expect(f.batches[0]).toHaveLength(1)
  })

  it("writes a null lease for a released resource and reads a null stored lease as no lease", async () => {
    const f = stub({ first: (sql) => (selectRow(sql) ? { lease: null, revision: 2, now_ms: 0 } : null) })
    const seen: unknown[] = []
    await new D1AtomicLeaseBackend(f.database, "leases").transition(resource, (current, now) => { seen.push(current, now); return { lease: null, result: null } as never })
    expect(seen).toEqual([null, new Date(0)])
    expect(f.batches[0]![0]!.binds).toEqual([null, "scope:ns:res", 2])
    expect(f.prepared.filter((s) => s.sql.startsWith("SELECT"))).toHaveLength(1)
  })

  it("inserts a missing row with revision 1, taking the clock from a separate query", async () => {
    const f = stub({ first: (sql) => (selectRow(sql) ? null : { now_ms: 12_000 }) })
    const seen: unknown[] = []
    await new D1AtomicLeaseBackend(f.database, "leases").transition(resource, (current, now) => { seen.push(current, now); return { lease, result: null } as never })
    expect(seen).toEqual([null, new Date(12_000)])
    expect(f.prepared[1]!.sql).toBe(`SELECT ${NOW} AS now_ms`)
    const insert = f.batches[0]![0]!
    expect(insert.sql).toBe("INSERT OR IGNORE INTO leases (resource_key, lease, revision) VALUES (?, ?, 1)")
    expect(insert.binds).toEqual(["scope:ns:res", JSON.stringify(lease)])
  })

  it("retries a lost swap exactly up to the retry budget", async () => {
    for (const [maxRetries, attempts] of [[3, 3], [1, 1], [undefined, 16]] as const) {
      const f = stub({ first: () => ({ lease: null, revision: 1, now_ms: 1 }), batch: () => [{ meta: { changes: 0 } }] })
      const backend = maxRetries === undefined ? new D1AtomicLeaseBackend(f.database, "leases") : new D1AtomicLeaseBackend(f.database, "leases", maxRetries)
      let calls = 0
      await expect(backend.transition(resource, () => { calls += 1; return { lease, result: null } as never })).rejects.toThrow(new Error("D1 lease transition exceeded retry budget"))
      expect(calls).toBe(attempts)
      expect(f.batches).toHaveLength(attempts)
    }
  })

  it("only an exact single-row change commits; missing metadata counts as a lost swap", async () => {
    const outcomes: D1Result[][] = [[{}], [{ meta: {} }], [undefined as never], [{ meta: { changes: 2 } }], [{ meta: { changes: 1 } }]]
    const f = stub({ first: () => ({ lease: null, revision: 1, now_ms: 1 }), batch: () => outcomes.shift()! })
    let calls = 0
    expect(await new D1AtomicLeaseBackend(f.database, "leases").transition(resource, () => { calls += 1; return { lease, result: "ok" } as never })).toBe("ok")
    expect(calls).toBe(5)
  })

  it("reads the stored lease and the database clock in one query", async () => {
    const f = stub({ first: () => ({ lease: JSON.stringify(lease), now_ms: 5_000 }) })
    const backend = new D1AtomicLeaseBackend(f.database, "leases")
    expect(await backend.read(resource)).toEqual({ lease, backendNow: new Date(5_000) })
    expect(f.prepared[0]!.sql).toBe(`SELECT (SELECT lease FROM leases WHERE resource_key = ?) AS lease, ${NOW} AS now_ms`)
    expect(f.prepared[0]!.binds).toEqual(["scope:ns:res"])
    const empty = new D1AtomicLeaseBackend(stub({ first: () => ({ lease: null, now_ms: 0 }) }).database, "leases")
    expect(await empty.read(resource)).toEqual({ lease: null, backendNow: new Date(0) })
  })
})

describe("createD1LeaseStore", () => {
  const touch = async (build: (database: D1AtomicDatabase) => ReturnType<typeof createD1LeaseStore>) => {
    const f = stub({ first: () => ({ lease: null, revision: 1, now_ms: 0 }) })
    await build(f.database).acquire(resource, "o", 1_000).catch(() => undefined)
    return f.prepared.map((s) => s.sql).join("\n")
  }

  it("accepts a table name, an options object or nothing", async () => {
    expect(await touch((db) => createD1LeaseStore(db))).toContain("FROM lease_records WHERE")
    expect(await touch((db) => createD1LeaseStore(db, "custom_leases"))).toContain("FROM custom_leases WHERE")
    expect(await touch((db) => createD1LeaseStore(db, { tables: { leases: "opt_leases" } }))).toContain("FROM opt_leases WHERE")
    expect(await touch((db) => createD1LeaseStore(db, {}))).toContain("FROM lease_records WHERE")
    expect(await touch((db) => createD1LeaseStore(db, { tables: {} }))).toContain("FROM lease_records WHERE")
    expect(() => createD1LeaseStore(stub({}).database, "Bad Name")).toThrow(new Error("Unsafe lease table name"))
  })

  it("passes the retry budget through to the backend", async () => {
    const f = stub({ first: () => ({ lease: null, revision: 1, now_ms: 1 }), batch: () => [{ meta: { changes: 0 } }] })
    const store = createD1LeaseStore(f.database, { maxRetries: 2 })
    await expect(store.acquire(resource, "o", 1_000)).rejects.toThrow()
    expect(f.batches.length).toBe(2)
  })
})
