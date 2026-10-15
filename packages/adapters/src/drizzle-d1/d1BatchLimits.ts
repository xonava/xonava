import { ConfigurationError } from "@xonava/core/domain"

export type D1BatchLimit = "maxBindParams" | "maxStatementBytes" | "maxBatchItems"

export interface D1BatchLimitExceededDetails {
  readonly limit: D1BatchLimit
  readonly actual: number
  readonly maximum: number
  readonly statementIndex?: number
}

export class D1BatchLimitExceededError extends Error {
  readonly code = "D1_BATCH_LIMIT_EXCEEDED"

  constructor(readonly details: D1BatchLimitExceededDetails) {
    super(`D1 atomic batch exceeds ${details.limit}: ${details.actual} > ${details.maximum}`)
    Object.setPrototypeOf(this, new.target.prototype)
    this.name = "D1BatchLimitExceededError"
  }
}

export interface D1StatementEstimate {
  readonly bindParams: number
  readonly statementBytes: number
}

interface SqlCapableCommand {
  toSQL: () => { sql: string; params: readonly unknown[] }
}

function isSqlCapableCommand(command: unknown): command is SqlCapableCommand {
  return typeof command === "object" && command !== null &&
    "toSQL" in command && typeof command.toSQL === "function"
}

export function estimateD1Statement(command: unknown): D1StatementEstimate {
  if (!isSqlCapableCommand(command)) {
    throw new ConfigurationError("D1 atomic batches require executable Drizzle queries with a toSQL method")
  }

  let query: { sql: string; params: readonly unknown[] }
  try {
    query = command.toSQL()
  } catch {
    throw new ConfigurationError("D1 atomic batch could not inspect a Drizzle query safely")
  }
  if (typeof query?.sql !== "string" || !Array.isArray(query.params)) {
    throw new ConfigurationError("D1 atomic batch could not inspect a Drizzle query safely")
  }

  return {
    bindParams: query.params.length,
    statementBytes: new TextEncoder().encode(query.sql).byteLength,
  }
}

export function assertD1BatchLimits(
  estimates: readonly D1StatementEstimate[],
  limits: { maxBindParams: number; maxStatementBytes: number; maxBatchItems: number },
): void {
  if (estimates.length > limits.maxBatchItems) {
    throw new D1BatchLimitExceededError({
      limit: "maxBatchItems",
      actual: estimates.length,
      maximum: limits.maxBatchItems,
    })
  }

  for (const [statementIndex, estimate] of estimates.entries()) {
    if (estimate.bindParams > limits.maxBindParams) {
      throw new D1BatchLimitExceededError({
        limit: "maxBindParams",
        actual: estimate.bindParams,
        maximum: limits.maxBindParams,
        statementIndex,
      })
    }
    if (estimate.statementBytes > limits.maxStatementBytes) {
      throw new D1BatchLimitExceededError({
        limit: "maxStatementBytes",
        actual: estimate.statementBytes,
        maximum: limits.maxStatementBytes,
        statementIndex,
      })
    }
  }
}
