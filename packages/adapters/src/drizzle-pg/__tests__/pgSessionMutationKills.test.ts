import { describe, expect, it } from "vitest"
import { createPgSession, type PgDatabaseLike } from "../pgSession"

type Call = { readonly path: string; readonly args: readonly unknown[] }

/** A recording chainable fake: every method call is logged and returns the next builder; the terminal awaits `result`. */
function chain(calls: Call[], path: string, result: unknown): unknown {
  const target = Promise.resolve(result) as unknown as Record<string, unknown>
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "then" || prop === "catch" || prop === "finally") {
        const fn = Reflect.get(t, prop) as (...a: unknown[]) => unknown
        return fn.bind(t)
      }
      return (...args: unknown[]) => {
        calls.push({ path: `${path}.${String(prop)}`, args })
        return chain(calls, `${path}.${String(prop)}`, result)
      }
    },
  })
}

function fakeDb(result: unknown, rootCalls: Call[] = []) {
  const db = {
    select: (...args: unknown[]) => { rootCalls.push({ path: "select", args }); return chain(rootCalls, "select", result) },
    insert: (...args: unknown[]) => { rootCalls.push({ path: "insert", args }); return chain(rootCalls, "insert", result) },
    update: (...args: unknown[]) => { rootCalls.push({ path: "update", args }); return chain(rootCalls, "update", result) },
    delete: (...args: unknown[]) => { rootCalls.push({ path: "delete", args }); return chain(rootCalls, "delete", result) },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  }
  return { db: db as unknown as PgDatabaseLike, calls: rootCalls }
}

const table = { name: "t" } as never

describe("createPgSession select", () => {
  it("passes the projection argument through when given and calls select() bare otherwise", async () => {
    const withFields = fakeDb([{ a: 1 }])
    const fields = { a: "col" }
    const rows = await createPgSession(withFields.db).select(fields as never).from(table).where("w" as never).limit(3)
    expect(rows).toEqual([{ a: 1 }])
    expect(withFields.calls[0]).toEqual({ path: "select", args: [fields] })
    expect(withFields.calls.map((c) => c.path)).toEqual(["select", "select.from", "select.from.where", "select.from.where.limit"])
    expect(withFields.calls[1]?.args).toEqual([table])
    expect(withFields.calls[2]?.args).toEqual(["w"])
    expect(withFields.calls[3]?.args).toEqual([3])

    const bare = fakeDb([])
    await createPgSession(bare.db).select().from(table).where("w" as never).limit(1)
    expect(bare.calls[0]).toEqual({ path: "select", args: [] })
  })

  it("chains orderBy, limit and offset with their arguments", async () => {
    const f = fakeDb([{ id: 1 }])
    const rows = await createPgSession(f.db).select().from(table).where("w" as never).orderBy("o" as never).limit(5).offset(10)
    expect(rows).toEqual([{ id: 1 }])
    const tail = f.calls.slice(-3)
    expect(tail.map((c) => c.path)).toEqual(["select.from.where.orderBy", "select.from.where.orderBy.limit", "select.from.where.orderBy.limit.offset"])
    expect(tail.map((c) => c.args)).toEqual([["o"], [5], [10]])
  })
})

describe("createPgSession insert, update and delete", () => {
  it("insert().values() forwards the data to the driver builder", async () => {
    const f = fakeDb({ rowCount: 1 })
    const result = await createPgSession(f.db).insert(table).values({ id: "x" } as never)
    expect(result).toEqual({ rowCount: 1 })
    expect(f.calls).toEqual([{ path: "insert", args: [table] }, { path: "insert.values", args: [{ id: "x" }] }])
  })

  it("update().set().where() forwards the set data and the predicate", async () => {
    const f = fakeDb({ rowCount: 2 })
    const result = await createPgSession(f.db).update(table).set({ a: 1 } as never).where("w" as never)
    expect(result).toEqual({ rowCount: 2 })
    expect(f.calls).toEqual([
      { path: "update", args: [table] },
      { path: "update.set", args: [{ a: 1 }] },
      { path: "update.set.where", args: ["w"] },
    ])
  })

  it("delete().where() forwards the predicate", async () => {
    const f = fakeDb({ rowCount: 3 })
    const result = await createPgSession(f.db).delete(table).where("w" as never)
    expect(result).toEqual({ rowCount: 3 })
    expect(f.calls).toEqual([{ path: "delete", args: [table] }, { path: "delete.where", args: ["w"] }])
  })
})

describe("createPgSession atomicJobTransition", () => {
  const request = (): Parameters<NonNullable<ReturnType<typeof createPgSession>["atomicJobTransition"]>>[0] => ({
    updateTable: { name: "jobs" },
    updateSet: { status: "done" },
    updateWhere: "uw",
    historyTable: { name: "hist" },
    historyValues: { id: "h1" },
    historyWhere: "hw",
  }) as never

  it("applies: updates, writes history, then clears the claim token inside one transaction", async () => {
    const f = fakeDb({ rowCount: 1 })
    const out = await createPgSession(f.db).atomicJobTransition!(request())
    expect(out).toEqual({ applied: true, historyId: "h1" })
    expect(f.calls.map((c) => c.path)).toEqual([
      "update", "update.set", "update.set.where",
      "insert", "insert.values",
      "update", "update.set", "update.set.where",
    ])
    expect(f.calls[1]?.args).toEqual([{ status: "done" }])
    expect(f.calls[2]?.args).toEqual(["uw"])
    expect(f.calls[4]?.args).toEqual([{ id: "h1" }])
    expect(f.calls[6]?.args).toEqual([{ claimToken: null }])
    expect(f.calls[7]?.args).toEqual(["hw"])
  })

  it("a fenced-out transition (0 rows) writes no history and reports not applied", async () => {
    const f = fakeDb({ rowCount: 0 })
    const out = await createPgSession(f.db).atomicJobTransition!(request())
    expect(out).toEqual({ applied: false, historyId: "h1" })
    expect(f.calls.map((c) => c.path)).toEqual(["update", "update.set", "update.set.where"])
  })
})
