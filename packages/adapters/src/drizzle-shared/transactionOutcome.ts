import { FrameworkCoreError, TimeoutError, TransactionRolledBackError } from "core/domain"
import { normalizeDrizzleError, type DrizzleDialect } from "./errors"

function machineCode(error: unknown): string | number | undefined {
  let current = error
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>
    const code = record.code ?? record.errno
    if (typeof code === "string" || typeof code === "number") return code
    current = record.cause
  }
  return undefined
}

/** Engine codes for which the database guarantees the whole transaction was rolled back. */
function isDefiniteRollback(code: string | number | undefined, dialect: DrizzleDialect): boolean {
  if (dialect === "postgresql") return code === "40001" || code === "40P01"
  if (dialect === "mysql") return code === "ER_LOCK_DEADLOCK" || code === 1213
  return false
}

function isStatementTimeout(code: string | number | undefined, dialect: DrizzleDialect): boolean {
  if (dialect === "postgresql") return code === "57014"
  if (dialect === "mysql") return code === "ER_QUERY_TIMEOUT" || code === 3024
  return false
}

/**
 * Classifies a failed interactive transaction (docs/spec/transactions-and-occ.md):
 * - a failure after the callback completed is a COMMIT failure: definite
 *   rollbacks become TransactionRolledBackError (safe to re-run), anything
 *   else keeps an unknown outcome and is never reported as rolled back;
 * - statement timeouts become TIMEOUT;
 * - raw driver errors are always normalized so SQL and provider text never escape.
 */
export function classifyTransactionFailure(error: unknown, dialect: DrizzleDialect, callbackCompleted: boolean): FrameworkCoreError {
  const code = machineCode(error)
  if (callbackCompleted && isDefiniteRollback(code, dialect)) return new TransactionRolledBackError("The transaction was rolled back at commit", { dialect, providerCode: String(code) })
  if (error instanceof FrameworkCoreError) return error
  if (isStatementTimeout(code, dialect)) return new TimeoutError("The database statement exceeded its deadline", { dialect, providerCode: String(code) })
  return normalizeDrizzleError(error, dialect)
}

/** Largest statement timeout accepted, in milliseconds (PostgreSQL limit is INT_MAX). */
export const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647

export function statementTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return 1
  return Math.min(Math.floor(timeoutMs), MAX_STATEMENT_TIMEOUT_MS)
}
