import { afterEach, describe, expect, it, vi } from "vitest"
import { isStaleConnectionError, tolerateStaleConnections } from "./staleConnection.js"

/** What undici throws for a request written to a keep-alive socket that the server already closed. */
function staleSocketError(): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }) })
}

/** A binding whose first `failures` calls of `all` fail like a stale connection before succeeding. */
function flakyBinding(failures: number, failure: () => unknown = staleSocketError, only = /./) {
  const calls: string[] = []
  let remaining = failures
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => {
      calls.push(`all ${sql} ${JSON.stringify(params)}`)
      if (only.test(sql) && remaining-- > 0) throw failure()
      return { results: [{ sql, params }] }
    },
  })
  return { calls, binding: { prepare: (sql: string) => statement(sql, []), batch: async (statements: unknown[]) => statements.length } }
}

describe("D1 stale keep-alive connection tolerance", () => {
  afterEach(() => { vi.restoreAllMocks() })

  it("recognises the undici stale-socket failure anywhere in the cause chain and nothing else", () => {
    expect(isStaleConnectionError(staleSocketError())).toBe(true)
    expect(isStaleConnectionError(new Error("Failed query", { cause: staleSocketError() }))).toBe(true)
    expect(isStaleConnectionError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true)
    expect(isStaleConnectionError(new Error("D1_ERROR: no such table: t"))).toBe(false)
    expect(isStaleConnectionError(new Error("UNIQUE constraint failed"))).toBe(false)
    expect(isStaleConnectionError("other side closed")).toBe(false)
    expect(isStaleConnectionError(undefined)).toBe(false)
  })

  it("repeats a statement once on a fresh connection when the first attempt hit a stale socket", async () => {
    const { binding, calls } = flakyBinding(1)
    const result = await tolerateStaleConnections(binding).prepare("select ?").bind(41).all()
    expect(result).toEqual({ results: [{ sql: "select ?", params: [41] }] })
    expect(calls).toEqual(['all select ? [41]', 'all select ? [41]'])
  })

  it("does not hide a second stale failure, a database error, or a non-promise failure", async () => {
    const twice = flakyBinding(2)
    await expect(tolerateStaleConnections(twice.binding).prepare("select 1").all()).rejects.toThrow("fetch failed")
    expect(twice.calls).toHaveLength(2)

    const real = flakyBinding(1, () => new Error("D1_ERROR: no such table: fw_rich_parity"))
    await expect(tolerateStaleConnections(real.binding).prepare("select 1").all()).rejects.toThrow("no such table")
    expect(real.calls).toHaveLength(1)
  })

  it("retries synchronous stale failures and hands the underlying statements to batch", async () => {
    let attempts = 0
    const binding = { prepare: () => { if (attempts++ === 0) throw staleSocketError(); return { marker: true } } }
    expect(tolerateStaleConnections(binding).prepare()).toMatchObject({ marker: true })
    expect(attempts).toBe(2)

    const seen: unknown[] = []
    const statement = { sql: "x" }
    const batching = { prepare: () => statement, batch: async (statements: unknown[]) => { seen.push(...statements); return statements.length } }
    const wrapped = tolerateStaleConnections(batching)
    expect(await wrapped.batch([wrapped.prepare(), wrapped.prepare()])).toBe(2)
    expect(seen).toEqual([statement, statement])
    expect(seen[0]).toBe(statement)
  })

  it("never repeats a write that failed with a stale socket, because the server may already have executed it", async () => {
    const { binding, calls } = flakyBinding(1, staleSocketError, /UPDATE/)
    await expect(tolerateStaleConnections(binding).prepare("UPDATE t SET a = ?").bind(1).all()).rejects.toThrow("fetch failed")
    expect(calls.filter((call) => call.includes("UPDATE"))).toEqual(["all UPDATE t SET a = ? [1]"])
    // A batch is repeatable only when every statement in it is read-only.
    const mixed = { prepare: (sql: string) => ({ sql, bind: () => ({ sql }), all: async () => ({ results: [] }) }), batch: async (statements: unknown[]) => { attempts++; if (attempts === 1) throw staleSocketError(); return statements.length } }
    let attempts = 0
    const wrapped = tolerateStaleConnections(mixed)
    await expect(wrapped.batch([wrapped.prepare("SELECT 1"), wrapped.prepare("DELETE FROM t")])).rejects.toThrow("fetch failed")
    expect(attempts).toBe(1)
    attempts = 0
    await expect(wrapped.batch([wrapped.prepare("SELECT 1"), wrapped.prepare("select 2")])).resolves.toBe(2)
    expect(attempts).toBe(2)
  })

  it("revalidates the connection with a read before the first request after a quiet spell", async () => {
    const { binding, calls } = flakyBinding(0)
    const wrapped = tolerateStaleConnections(binding)
    await wrapped.prepare("INSERT INTO t VALUES (?)").bind(1).all()
    expect(calls, "no quiet spell yet").toEqual(["all INSERT INTO t VALUES (?) [1]"])
    const now = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000)
    await wrapped.prepare("INSERT INTO t VALUES (?)").bind(2).all()
    expect(calls).toEqual(["all INSERT INTO t VALUES (?) [1]", "all SELECT 1 []", "all INSERT INTO t VALUES (?) [2]"])
  })

  it("sends requests one at a time, in the order they were made, so the HTTP client keeps one busy connection", async () => {
    const order: string[] = []
    let inFlight = 0
    let peak = 0
    const statement = (sql: string) => ({
      bind: () => statement(sql),
      run: async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        order.push(sql)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        return { meta: { changes: 1 } }
      },
    })
    const wrapped = tolerateStaleConnections({ prepare: statement })
    await Promise.all(["a", "b", "c"].map((sql) => wrapped.prepare(`UPDATE ${sql}`).run()))
    expect(order).toEqual(["UPDATE a", "UPDATE b", "UPDATE c"])
    expect(peak).toBe(1)
  })
})
