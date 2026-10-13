import { describe, expect, it } from "vitest"
import { isStaleConnectionError, tolerateStaleConnections } from "./staleConnection.js"

/** What undici throws for a request written to a keep-alive socket that the server already closed. */
function staleSocketError(): Error {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }) })
}

/** A binding whose first `failures` calls of `all` fail like a stale connection before succeeding. */
function flakyBinding(failures: number, failure: () => unknown = staleSocketError) {
  const calls: string[] = []
  let remaining = failures
  const statement = (sql: string, params: unknown[]) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    all: async () => {
      calls.push(`all ${sql} ${JSON.stringify(params)}`)
      if (remaining-- > 0) throw failure()
      return { results: [{ sql, params }] }
    },
  })
  return { calls, binding: { prepare: (sql: string) => statement(sql, []), batch: async (statements: unknown[]) => statements.length } }
}

describe("D1 stale keep-alive connection tolerance", () => {
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
})
