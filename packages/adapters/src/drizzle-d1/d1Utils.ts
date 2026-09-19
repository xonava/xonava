import { sql, type SQL } from "drizzle-orm"

const SQLITE_EPOCH_MS = "(julianday('now') - 2440587.5) * 86400000"

/** Build numeric epoch-millisecond expressions for D1 INTEGER timestamp columns. */
export function d1CurrentEpochMilliseconds(): SQL<unknown> {
  return sql`CAST(${sql.raw(SQLITE_EPOCH_MS)} AS INTEGER)`
}

/** Build a numeric epoch-millisecond expression relative to SQLite's current time. */
export function d1EpochMillisecondsAfter(durationMs: number): SQL<unknown> {
  return sql`CAST(${sql.raw(SQLITE_EPOCH_MS)} + ${durationMs} AS INTEGER)`
}

/**
 * Normalize D1 / SQLite result shapes to extract affected-rows count.
 * Handles D1Result (meta.changes), better-sqlite3 (changes),
 * and framework wrapper ({ affectedRows }).
 */
export function getAffectedRows(result: unknown): number {
  if (!result || typeof result !== "object") return 0

  const obj = result as Record<string, unknown>

  if (typeof obj.affectedRows === "number") return obj.affectedRows
  if (typeof obj.changes === "number") return obj.changes
  if (typeof obj.rowsAffected === "number") return obj.rowsAffected
  if (typeof obj.count === "number") return obj.count

  if (obj.meta && typeof obj.meta === "object") {
    const meta = obj.meta as Record<string, unknown>
    if (typeof meta.changes === "number") return meta.changes
  }

  return 0
}
