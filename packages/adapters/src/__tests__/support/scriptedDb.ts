import type { SQL } from "drizzle-orm"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import { PgDialect } from "drizzle-orm/pg-core"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"

/**
 * A scripted Drizzle session for adapter unit tests. It implements the fluent builder surface the adapters use
 * (select/insert/update/delete with where, orderBy, limit, offset, returning and onConflictDoNothing), records every
 * statement with its rendered SQL, and answers each one through a test-supplied handler. Statements are real Drizzle
 * SQL objects, so assertions can inspect the exact SQL and parameters the adapter issued.
 */
export type Dialect = "pg" | "mysql" | "sqlite"

export interface RenderedSql { readonly sql: string; readonly params: readonly unknown[] }

export interface ScriptedOp {
  readonly kind: "select" | "insert" | "update" | "delete"
  readonly table?: unknown
  readonly fields?: unknown
  readonly values?: unknown
  readonly set?: unknown
  readonly where?: RenderedSql
  readonly orderBy?: RenderedSql
  readonly limit?: number
  readonly offset?: number
  readonly returning: boolean
  readonly conflictDoNothing: boolean
}

export type ScriptedHandler = (op: ScriptedOp) => unknown

const dialects = { pg: new PgDialect(), mysql: new MySqlDialect(), sqlite: new SQLiteSyncDialect() }

export function renderSql(dialect: Dialect, query: unknown): RenderedSql | undefined {
  if (query === undefined || query === null) return undefined
  const renderer = dialects[dialect] as { sqlToQuery(sql: SQL): { sql: string; params: unknown[] } }
  try {
    const rendered = renderer.sqlToQuery(query as SQL)
    return { sql: rendered.sql, params: rendered.params }
  } catch {
    return { sql: "<unrenderable>", params: [] }
  }
}

export interface ScriptedDb {
  readonly db: Record<string, (...args: never[]) => unknown>
  readonly ops: ScriptedOp[]
}

export interface ScriptedDbOptions {
  /** When set, the session exposes `atomicJobTransition`, answered by this function (its argument is the adapter's request). */
  readonly atomicJobTransition?: (request: Record<string, unknown>) => unknown
}

export function createScriptedDb(dialect: Dialect, handler: ScriptedHandler, options: ScriptedDbOptions = {}): ScriptedDb {
  const ops: ScriptedOp[] = []

  const finish = (state: Partial<ScriptedOp> & { kind: ScriptedOp["kind"] }) => {
    const op: ScriptedOp = { returning: false, conflictDoNothing: false, ...state }
    ops.push(op)
    return Promise.resolve().then(() => handler(op))
  }

  const chain = (state: Partial<ScriptedOp> & { kind: ScriptedOp["kind"] }): Record<string, unknown> => {
    const next = (patch: Partial<ScriptedOp>) => chain({ ...state, ...patch })
    const builder: Record<string, unknown> = {
      from: (table: unknown) => next({ table }),
      where: (where: unknown) => next({ ...(where === undefined ? {} : { where: renderSql(dialect, where)! }) }),
      orderBy: (...order: unknown[]) => next({ orderBy: renderSql(dialect, order[0])! }),
      limit: (limit: number) => next({ limit }),
      offset: (offset: number) => next({ offset }),
      returning: () => next({ returning: true }),
      onConflictDoNothing: () => next({ conflictDoNothing: true }),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => finish(state).then(resolve, reject),
      catch: (reject: (reason: unknown) => unknown) => finish(state).catch(reject),
    }
    return builder
  }

  const db = {
    select: (fields?: unknown) => chain({ kind: "select", ...(fields === undefined ? {} : { fields }) }),
    insert: (table: unknown) => ({ values: (values: unknown) => chain({ kind: "insert", table, values }) }),
    update: (table: unknown) => ({ set: (set: unknown) => chain({ kind: "update", table, set }) }),
    delete: (table: unknown) => chain({ kind: "delete", table }),
    ...(options.atomicJobTransition ? { atomicJobTransition: async (request: Record<string, unknown>) => options.atomicJobTransition!(request) } : {}),
  }
  return { db: db as never, ops }
}
