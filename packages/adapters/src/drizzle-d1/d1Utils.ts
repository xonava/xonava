import { getTableColumns, sql, type AnyColumn, type SQL } from "drizzle-orm"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { ConfigurationError } from "@xonava/core/domain"

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

/**
 * Resolve the TypeScript property key under which `column` is declared on
 * `table`. Drizzle `.values()`/`.set()` objects are keyed by property keys, not
 * by physical column names, so physical names silently drop the value.
 */
export function d1ColumnKey(table: AnySQLiteTable, column: AnyColumn, fallback?: string): string {
  const columns = (getTableColumns(table) as Record<string, AnyColumn> | undefined) ?? {}
  for (const [key, candidate] of Object.entries(columns)) if (candidate === column) return key
  for (const [key, candidate] of Object.entries(columns)) if (candidate.name === column.name) return key
  if (fallback !== undefined) return fallback
  throw new ConfigurationError("Mapped column is not declared on its table")
}

function mapsDatesItself(column: AnyColumn): boolean {
  try { return !(column.mapToDriverValue(new Date(0)) instanceof Date) } catch { return false }
}

/**
 * Value for a Drizzle `.values()`/`.set()` object. Dates are left to columns
 * that encode them (timestamp modes); every other column receives epoch
 * milliseconds, this adapter's time encoding, because D1 cannot bind objects.
 */
export function d1ColumnInputValue(column: AnyColumn, value: unknown): unknown {
  return value instanceof Date && !mapsDatesItself(column) ? value.getTime() : value
}

/** Fully driver-encoded value for raw SQL; Dates always end up as epoch milliseconds or the column's own encoding. */
export function d1DriverValue(column: AnyColumn, value: unknown): unknown {
  if (value === null || value === undefined) return null
  const mapped: unknown = typeof column.mapToDriverValue === "function" ? column.mapToDriverValue(value) : value
  return mapped instanceof Date ? mapped.getTime() : mapped
}
