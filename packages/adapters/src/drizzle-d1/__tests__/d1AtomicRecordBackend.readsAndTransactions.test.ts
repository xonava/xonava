import { describe, expect, it } from "vitest"
import { D1AtomicRecordBackend, type D1AtomicDatabase, type D1Result, type D1Statement } from "../d1AtomicRecordBackend"

interface StubStatement extends D1Statement { readonly sql: string; binds: unknown[] }
interface Script {
  first?: (sql: string, binds: readonly unknown[]) => unknown
  batch?: (statements: readonly StubStatement[]) => Promise<D1Result[]> | D1Result[]
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
      return script.batch ? await script.batch(statements) : [{ meta: { changes: 1 } }]
    }) as never,
  }
  return { database, prepared, batches }
}
const backend = (script: Script, config: { maxRetries?: number } = {}) => {
  const s = stub(script)
  return { ...s, backend: new D1AtomicRecordBackend<string, { n: number }>({ database: s.database, table: "records", encodeKey: (key) => `k:${key}`, ...config }) }
}
const row = (n: number, revision: number, nowMs = 1_000) => ({ record: JSON.stringify({ n }), revision, now_ms: nowMs })
const selectRow = (sql: string) => sql.startsWith("SELECT record, revision")

describe("D1AtomicRecordBackend construction and reads", () => {
  it("is not transactional and rejects unsafe table names", () => {
    expect(backend({}).backend.transactional).toBe(false)
    for (const table of ["Records", "1records", "re cords", "records;drop", "", "re-cords", "records\n"]) {
      expect(() => new D1AtomicRecordBackend({ database: stub({}).database, table, encodeKey: String })).toThrow(new Error("Unsafe atomic-record table name"))
    }
    expect(() => new D1AtomicRecordBackend({ database: stub({}).database, table: "_a1_b2", encodeKey: String })).not.toThrow()
  })

  it("reads and parses the record, or null when missing, using the encoded key", async () => {
    const found = backend({ first: () => ({ record: '{"n":3}' }) })
    expect(await found.backend.read("a")).toEqual({ n: 3 })
    expect(found.prepared[0]!.sql).toBe("SELECT record FROM records WHERE record_key = ?")
    expect(found.prepared[0]!.binds).toEqual(["k:a"])
    expect(await backend({ first: () => null }).backend.read("a")).toBeNull()
  })
})

describe("D1AtomicRecordBackend.transact", () => {
  it("updates an existing row under a revision compare-and-swap and returns the transition result", async () => {
    const f = backend({ first: (sql) => (selectRow(sql) ? row(1, 7, 5_000) : null) })
    const seen: unknown[] = []
    const result = await f.backend.transact("a", (current, now, uuid) => { seen.push(current, now, typeof uuid()); return { record: { n: 2 }, result: "done" } })
    expect(result).toBe("done")
    expect(seen).toEqual([{ n: 1 }, new Date(5_000), "string"])
    expect(f.prepared.filter((s) => s.sql.startsWith("SELECT")).length).toBe(1)
    expect(f.prepared[0]!.sql).toBe("SELECT record, revision, CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms FROM records WHERE record_key = ?")
    expect(f.prepared[0]!.binds).toEqual(["k:a"])
    const update = f.batches[0]![0]!
    expect(update.sql).toBe("UPDATE records SET record = ?, revision = revision + 1 WHERE record_key = ? AND revision = ?")
    expect(update.binds).toEqual(['{"n":2}', "k:a", 7])
    expect(f.batches[0]).toHaveLength(1)
  })

  it("inserts a missing row, taking the clock from a separate query", async () => {
    const f = backend({ first: (sql) => (selectRow(sql) ? null : { now_ms: 9_000 }) })
    const seen: unknown[] = []
    await f.backend.transact("a", (current, now) => { seen.push(current, now); return { record: { n: 1 }, result: null } })
    expect(seen).toEqual([null, new Date(9_000)])
    expect(f.prepared[1]!.sql).toBe("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
    const insert = f.batches[0]![0]!
    expect(insert.sql).toBe("INSERT OR IGNORE INTO records (record_key, record, revision) VALUES (?, ?, 1)")
    expect(insert.binds).toEqual(["k:a", '{"n":1}'])
  })

  it("does not read the clock separately when the row already carries it, even when it is zero", async () => {
    const f = backend({ first: (sql) => (selectRow(sql) ? row(1, 1, 0) : { now_ms: 123 }) })
    let seen: Date | undefined
    await f.backend.transact("a", (_current, now) => { seen = now; return { record: { n: 1 }, result: null } })
    expect(seen).toEqual(new Date(0))
    expect(f.prepared.filter((s) => s.sql.startsWith("SELECT"))).toHaveLength(1)
  })

  it("retries a lost compare-and-swap up to the retry budget and then fails", async () => {
    for (const [config, attempts] of [[{ maxRetries: 3 }, 3], [{ maxRetries: 1 }, 1], [{}, 16]] as const) {
      const f = backend({ first: () => row(1, 1), batch: () => [{ meta: { changes: 0 } }] }, config)
      let calls = 0
      await expect(f.backend.transact("a", () => { calls += 1; return { record: { n: 2 }, result: null } })).rejects.toThrow(new Error("D1 atomic-record transition exceeded retry budget"))
      expect(calls).toBe(attempts)
      expect(f.batches).toHaveLength(attempts)
    }
  })

  it("treats missing change metadata as a lost swap and succeeds once exactly one row changed", async () => {
    const outcomes: D1Result[][] = [[{}], [{ meta: {} }], [undefined as never], [{ meta: { changes: 2 } }], [{ meta: { changes: 1 } }]]
    const f = backend({ first: () => row(1, 1), batch: () => outcomes.shift()! })
    let calls = 0
    expect(await f.backend.transact("a", () => { calls += 1; return { record: { n: 2 }, result: "ok" } })).toBe("ok")
    expect(calls).toBe(5)
  })
})

describe("D1AtomicRecordBackend.transactBatch", () => {
  const business = (label: string): StubStatement => ({ sql: label, binds: [], bind: () => business(label), first: async () => null, run: async () => ({}) })
  const transition = (n: number) => (_current: { n: number } | null) => ({ record: { n }, result: `result-${n}` })

  it("commits the business statements, each followed by a guard, and then the guarded record update", async () => {
    const f = backend({ first: () => row(1, 4) })
    const [one, two] = [business("b1"), business("b2")]
    expect(await f.backend.transactBatch("a", [one, two], transition(2))).toBe("result-2")
    const statements = f.batches[0]! as readonly StubStatement[]
    expect(statements).toHaveLength(6)
    const guard = statements[1]!
    expect(guard.sql).toBe("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('framework_atomic_batch_guard_failure') END")
    expect(statements[0]).toBe(one)
    expect(statements[2]).toBe(two)
    expect(statements[3]).toBe(guard)
    expect(statements[5]).toBe(guard)
    expect(statements[4]!.sql).toBe("UPDATE records SET record = ?, revision = revision + 1 WHERE record_key = ? AND revision = ?")
    expect(statements[4]!.binds).toEqual(['{"n":2}', "k:a", 4])
  })

  it("fails for a missing row after evaluating the transition against null with the backend clock", async () => {
    const f = backend({ first: (sql) => (selectRow(sql) ? null : { now_ms: 8_000 }) })
    const seen: unknown[] = []
    await expect(f.backend.transactBatch("a", [], (current, now) => { seen.push(current, now); return { record: { n: 1 }, result: null } })).rejects.toThrow(new Error("Atomic-record row does not exist"))
    expect(seen).toEqual([null, new Date(8_000)])
    expect(f.batches).toHaveLength(0)
  })

  it("rethrows a batch failure when the record revision is unchanged", async () => {
    const failure = new Error("business statement failed")
    const f = backend({ first: (sql) => (selectRow(sql) ? row(1, 4) : { revision: 4 }), batch: () => { throw failure } })
    let calls = 0
    expect(await f.backend.transactBatch("a", [business("b")], () => { calls += 1; return { record: { n: 2 }, result: null } }).catch((e: unknown) => e)).toBe(failure)
    expect(calls).toBe(1)
    const lookup = f.prepared.find((s) => s.sql.startsWith("SELECT revision FROM"))!
    expect(lookup.sql).toBe("SELECT revision FROM records WHERE record_key = ?")
    expect(lookup.binds).toEqual(["k:a"])
  })

  it("re-evaluates the transition against the new record after a concurrent change", async () => {
    let reads = 0
    let failures = 0
    const f = backend({
      first: (sql) => (selectRow(sql) ? row(reads++ + 1, reads) : { revision: reads + 1 }),
      batch: () => { if (failures++ === 0) throw new Error("raced"); return [{ meta: { changes: 1 } }] },
    })
    const seen: unknown[] = []
    expect(await f.backend.transactBatch("a", [], (current) => { seen.push(current); return { record: { n: 9 }, result: "won" } })).toBe("won")
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("treats a vanished record as a concurrent change and stops at the retry budget", async () => {
    const f = backend({ first: (sql) => (selectRow(sql) ? row(1, 1) : null), batch: () => { throw new Error("raced") } }, { maxRetries: 2 })
    let calls = 0
    await expect(f.backend.transactBatch("a", [], () => { calls += 1; return { record: { n: 2 }, result: null } })).rejects.toThrow(new Error("D1 atomic-record batch exceeded retry budget"))
    expect(calls).toBe(2)
    const defaults = backend({ first: (sql) => (selectRow(sql) ? row(1, 1) : { revision: 99 }), batch: () => { throw new Error("raced") } })
    let defaultCalls = 0
    await expect(defaults.backend.transactBatch("a", [], () => { defaultCalls += 1; return { record: { n: 2 }, result: null } })).rejects.toThrow("exceeded retry budget")
    expect(defaultCalls).toBe(16)
  })
})
