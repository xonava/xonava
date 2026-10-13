import { ConfigurationError } from "core/domain"

/**
 * Normalize Postgres result shapes to extract affected-rows count.
 * Handles node-postgres (rowCount), Drizzle wrappers, and framework ({ affectedRows }).
 */
export function getAffectedRows(result: unknown): number {
  if (!result || typeof result !== "object") {
    throw new ConfigurationError("Unsupported PostgreSQL mutation result shape: expected an object")
  }

  const obj = result as Record<string, unknown>

  if (typeof obj.affectedRows === "number") return obj.affectedRows
  if (typeof obj.rowCount === "number") return obj.rowCount
  if (typeof obj.rowsAffected === "number") return obj.rowsAffected
  if (typeof obj.count === "number") return obj.count

  if (obj.meta && typeof obj.meta === "object") {
    const meta = obj.meta as Record<string, unknown>
    if (typeof meta.rowCount === "number") return meta.rowCount
    if (typeof meta.changes === "number") return meta.changes
  }

  throw new ConfigurationError("Unsupported PostgreSQL mutation result shape: could not extract affected rows")
}

/**
 * A `timestamptz` value read through node-postgres. The driver returns a `Date` (millisecond precision); `String(date)` renders
 * a locale string that drops the milliseconds, so only non-Date values (ISO strings from other drivers) are parsed from text.
 */
export function pgDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}
