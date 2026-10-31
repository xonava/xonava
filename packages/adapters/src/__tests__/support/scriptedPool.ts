/**
 * A scripted driver pool for adapter unit tests: `query` and `getConnection().query` both route to one responder that sees
 * the SQL text and parameters, and every call (plus transaction events) is recorded. The responder returns the first element
 * of the driver tuple: mysql2 resolves `[rows | resultHeader, fields]`; node-postgres resolves `{ rows, rowCount }`.
 */
export interface PoolCall { readonly sql: string; readonly params: unknown[]; readonly via: "pool" | "connection" }
export type PoolResponder = (call: PoolCall) => unknown

export interface ScriptedMySqlPool {
  readonly pool: { query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>; getConnection: () => Promise<Record<string, unknown>> }
  readonly calls: PoolCall[]
  /** begin/commit/rollback/release events of connections, in order. */
  readonly events: string[]
}

export function createScriptedMySqlPool(respond: PoolResponder): ScriptedMySqlPool {
  const calls: PoolCall[] = []
  const events: string[] = []
  const run = async (via: PoolCall["via"], sql: string, params: unknown[] = []): Promise<[unknown, unknown]> => {
    const call: PoolCall = { sql, params, via }
    calls.push(call)
    return [await respond(call), undefined]
  }
  const connection = {
    query: (sql: string, params?: unknown[]) => run("connection", sql, params),
    beginTransaction: async () => { events.push("begin") },
    commit: async () => { events.push("commit") },
    rollback: async () => { events.push("rollback") },
    release: () => { events.push("release") },
  }
  return { pool: { query: (sql, params) => run("pool", sql, params), getConnection: async () => connection }, calls, events }
}

export interface ScriptedPgPool {
  /** Typed `never` so it can be handed to any store expecting a driver pool without a cast at each call site. */
  readonly pool: never
  readonly calls: PoolCall[]
  readonly events: string[]
}

/** The responder returns rows (an array) or `{ rows, rowCount }`; a thrown value rejects the query. */
export function createScriptedPgPool(respond: PoolResponder): ScriptedPgPool {
  const calls: PoolCall[] = []
  const events: string[] = []
  const run = async (via: PoolCall["via"], sql: string, params: unknown[] = []) => {
    const call: PoolCall = { sql, params, via }
    calls.push(call)
    const reply = await respond(call)
    if (Array.isArray(reply)) return { rows: reply, rowCount: reply.length }
    const shaped = (reply ?? {}) as { rows?: unknown[]; rowCount?: number }
    return { rows: shaped.rows ?? [], rowCount: shaped.rowCount ?? shaped.rows?.length ?? 0 }
  }
  const client = {
    query: (sql: string, params?: unknown[]) => { events.push(sql.trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase()); return run("connection", sql, params) },
    release: () => { events.push("release") },
  }
  return { pool: { query: (sql: string, params?: unknown[]) => run("pool", sql, params), connect: async () => client } as never, calls, events }
}
