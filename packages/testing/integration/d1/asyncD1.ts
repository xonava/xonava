import type { Miniflare } from "miniflare"

/**
 * An async-only D1 binding for the Miniflare fixtures.
 *
 * `mf.getD1Database()` returns a proxy whose property reads and first-time function calls are SYNCHRONOUS: the main
 * thread posts the request to a helper worker thread and blocks in `Atomics.wait` until that thread answers (Miniflare
 * `SynchronousFetcher`). Every statement `prepare().bind().run()` crosses that path several times, because each
 * statement object is a fresh proxy. Under CPU starvation the blocked thread is woken without the reply being readable
 * (`assert(message?.id === id)` in `miniflare/dist/src/index.js` fails), the fixture breaks and every remaining property of
 * the file fails with it. The statements themselves are healthy; only the transport is.
 *
 * This binding never touches that path. The statements run inside the Worker below, next to the real D1 binding, and the
 * test process talks to it with one ordinary async `dispatchFetch` per prepared statement, `exec` or `batch`. The SQL, the
 * parameters and the D1 results and errors are the real ones; only the hop between this process and workerd differs.
 */
export const ASYNC_D1_WORKER_SCRIPT = `
const decode = (value) => {
  if (value === null || typeof value !== "object") return value
  if ("$undefined" in value) return undefined
  if ("$bigint" in value) return BigInt(value.$bigint)
  if ("$bytes" in value) return new Uint8Array(value.$bytes).buffer
  return value
}
const statement = (db, description) => {
  const prepared = db.prepare(description.sql)
  return description.params.length === 0 ? prepared : prepared.bind(...description.params.map(decode))
}
export default {
  async fetch(request, env) {
    const call = await request.json()
    try {
      const db = env[call.binding]
      let result
      if (call.op === "exec") result = await db.exec(call.sql)
      else if (call.op === "batch") result = await db.batch(call.statements.map((description) => statement(db, description)))
      else {
        const prepared = statement(db, call.statement)
        if (call.op === "run") result = await prepared.run()
        else if (call.op === "all") result = await prepared.all()
        else if (call.op === "first") result = call.column === undefined ? await prepared.first() : await prepared.first(call.column)
        else if (call.op === "raw") result = await prepared.raw(call.options)
        else throw new Error("unknown D1 fixture operation " + call.op)
      }
      return Response.json({ result: result === undefined ? null : result })
    } catch (error) {
      return Response.json({ error: { message: String(error && error.message), cause: error && error.cause ? String(error.cause.message) : undefined } })
    }
  },
}
`

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface StatementDescription { sql: string; params: Json[] }

function encodeParameter(value: unknown): Json {
  if (value === undefined) return { $undefined: true }
  if (typeof value === "bigint") return { $bigint: value.toString() }
  if (value instanceof ArrayBuffer) return { $bytes: Array.from(new Uint8Array(value)) }
  if (ArrayBuffer.isView(value)) return { $bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) }
  return value as Json
}

/** Rebuilds what workerd throws for a failed statement: `Error("D1_ERROR: ...")` with the SQLite error as `cause`. */
function fixtureError(error: { message: string; cause?: string }): Error {
  return error.cause === undefined ? new Error(error.message) : new Error(error.message, { cause: new Error(error.cause) })
}

interface Statement {
  readonly sql: string
  readonly params: readonly unknown[]
  bind(...values: unknown[]): Statement
  run(): Promise<unknown>
  all(): Promise<unknown>
  first(column?: string): Promise<unknown>
  raw(options?: unknown): Promise<unknown>
}

/** Returns the Miniflare D1 binding `binding` as an object with the `D1Database` surface the fixtures and adapters use. */
export function asyncD1Binding(mf: Miniflare, binding = "DB"): Awaited<ReturnType<Miniflare["getD1Database"]>> {
  const send = async (body: Record<string, unknown>): Promise<unknown> => {
    const response = await mf.dispatchFetch("http://d1-fixture.invalid/", { method: "POST", body: JSON.stringify({ binding, ...body }) })
    const reply = (await response.json()) as { result?: unknown; error?: { message: string; cause?: string } }
    if (reply.error !== undefined) throw fixtureError(reply.error)
    return reply.result
  }
  const describeStatement = (statement: Pick<Statement, "sql" | "params">): StatementDescription => ({ sql: statement.sql, params: statement.params.map(encodeParameter) })
  const prepare = (sql: string, params: readonly unknown[] = []): Statement => {
    const self: Statement = {
      sql,
      params,
      bind: (...values) => prepare(sql, values),
      run: () => send({ op: "run", statement: describeStatement(self) }),
      all: () => send({ op: "all", statement: describeStatement(self) }),
      first: (column) => send({ op: "first", statement: describeStatement(self), ...(column === undefined ? {} : { column }) }),
      raw: (options) => send({ op: "raw", statement: describeStatement(self), options }),
    }
    return self
  }
  const database = {
    prepare: (sql: string) => prepare(sql),
    exec: (sql: string) => send({ op: "exec", sql }),
    batch: (statements: readonly Statement[]) => send({ op: "batch", statements: statements.map(describeStatement) }),
  }
  return database as never
}
