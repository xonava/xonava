import { ConfigurationError } from "../domain"

export interface ExecutionBudget { readonly maxNestingDepth: number; readonly maxDurationMs: number }
export const DEFAULT_EXECUTION_BUDGET: ExecutionBudget = Object.freeze({ maxNestingDepth: 8, maxDurationMs: 30_000 })
export function validateExecutionBudget(value: ExecutionBudget): ExecutionBudget {
  if (!Number.isSafeInteger(value.maxNestingDepth) || value.maxNestingDepth < 1) throw new ConfigurationError("maxNestingDepth must be a positive safe integer")
  if (!Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1) throw new ConfigurationError("maxDurationMs must be a positive safe integer")
  return Object.freeze({ ...value })
}
