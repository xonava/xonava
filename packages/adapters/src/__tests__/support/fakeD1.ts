import { DatabaseSync } from "node:sqlite"

/**
 * A minimal in-process Cloudflare D1 binding backed by node:sqlite, enough for Drizzle's D1 driver and the
 * adapter's own `$client.batch` use. Test-only: real statements execute against a real SQLite engine, so
 * assertions can observe committed state instead of mocked rows.
 */
type SqlValue = string | number | bigint | null | Uint8Array

export interface FakeD1Statement {
  bind(...values: unknown[]): FakeD1Statement
  run(): Promise<{ success: true; results: never[]; meta: { changes: number; last_row_id: number } }>
  all(): Promise<{ success: true; results: Record<string, unknown>[]; meta: { changes: number } }>
  raw(): Promise<unknown[][]>
  first(column?: string): Promise<unknown>
  readonly sql: string
  readonly params: readonly unknown[]
}

export interface FakeD1 {
  readonly sqlite: DatabaseSync
  /** Every statement text executed, in order (batch members included). */
  readonly executed: string[]
  prepare(query: string): FakeD1Statement
  batch(statements: FakeD1Statement[]): Promise<Array<{ success: true; results: Record<string, unknown>[]; meta: { changes: number } }>>
  exec(query: string): Promise<{ count: number }>
  close(): void
}

const returnsRows = (query: string): boolean => /^\s*(select|with|pragma)\b/i.test(query) || /\breturning\b/i.test(query)

function normalize(values: readonly unknown[]): SqlValue[] {
  return values.map((value) => {
    if (value === undefined || value === null) return null
    if (typeof value === "boolean") return value ? 1 : 0
    if (value instanceof Date) return value.getTime()
    return value as SqlValue
  })
}

export function createFakeD1(setup: readonly string[] = []): FakeD1 {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")
  for (const statement of setup) sqlite.exec(statement)
  const executed: string[] = []

  const execute = (query: string, params: readonly unknown[]) => {
    executed.push(query)
    try {
      const statement = sqlite.prepare(query)
      const bound = normalize(params)
      if (returnsRows(query)) {
        const results = statement.all(...(bound as never[])) as Record<string, unknown>[]
        return { results, changes: results.length }
      }
      const info = statement.run(...(bound as never[]))
      return { results: [] as Record<string, unknown>[], changes: Number(info.changes), lastRowId: Number(info.lastInsertRowid) }
    } catch (error) {
      // Real D1 reports SQLite failures as "D1_ERROR: <sqlite message>: SQLITE_<CLASS>" without a machine code.
      const failure = error as { message?: string; errcode?: number }
      const primary = (failure.errcode ?? 0) & 0xff
      const marker = primary === 19 ? "SQLITE_CONSTRAINT" : primary === 5 ? "SQLITE_BUSY" : "SQLITE_ERROR"
      throw new Error(`D1_ERROR: ${failure.message ?? String(error)}: ${marker}`)
    }
  }

  const makeStatement = (query: string, params: readonly unknown[]): FakeD1Statement => ({
    sql: query,
    params,
    bind: (...values) => makeStatement(query, values),
    async run() {
      const result = execute(query, params)
      return { success: true as const, results: [] as never[], meta: { changes: result.changes, last_row_id: result.lastRowId ?? 0 } }
    },
    async all() {
      const result = execute(query, params)
      return { success: true as const, results: result.results, meta: { changes: result.changes } }
    },
    async raw() {
      return execute(query, params).results.map((row) => Object.values(row))
    },
    async first(column?: string) {
      const row = execute(query, params).results[0]
      if (row === undefined) return null
      return column === undefined ? row : row[column]
    },
  })

  return {
    sqlite,
    executed,
    prepare: (query) => makeStatement(query, []),
    async batch(statements) {
      sqlite.exec("BEGIN")
      try {
        const out = []
        for (const statement of statements) {
          const result = execute(statement.sql, statement.params)
          out.push({ success: true as const, results: result.results, meta: { changes: result.changes } })
        }
        sqlite.exec("COMMIT")
        return out
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
    async exec(query) {
      sqlite.exec(query)
      return { count: 1 }
    },
    close: () => sqlite.close(),
  }
}
