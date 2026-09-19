import type { RetryPolicy } from "./types"
import { ValidationError } from "../domain"

function assertFiniteRetryValue(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || value < minimum) {
    throw new ValidationError(`${name} must be a finite number >= ${minimum}`)
  }
}

export function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new ValidationError("maxAttempts must be a finite integer >= 1")
  }
  assertFiniteRetryValue("delayMs", policy.delayMs, 0)
  if (!Number.isFinite(policy.backoffMultiplier) || policy.backoffMultiplier <= 0) {
    throw new ValidationError("backoffMultiplier must be greater than zero.")
  }
  if (policy.maxDelayMs !== undefined) assertFiniteRetryValue("maxDelayMs", policy.maxDelayMs, 0)
}

export function getNextRetryDelay(args: {
  policy: RetryPolicy
  attempt: number
}): number {
  validateRetryPolicy(args.policy)
  if (!Number.isInteger(args.attempt) || args.attempt < 1) throw new ValidationError("attempt must be a finite integer >= 1")
  if (args.attempt >= args.policy.maxAttempts) return -1

  const delay = args.policy.delayMs * Math.pow(args.policy.backoffMultiplier, args.attempt - 1)

  if (args.policy.maxDelayMs !== undefined) {
    return Math.min(delay, args.policy.maxDelayMs)
  }

  return delay
}

export function shouldRetry(args: {
  policy: RetryPolicy
  attempt: number
}): boolean {
  validateRetryPolicy(args.policy)
  if (!Number.isInteger(args.attempt) || args.attempt < 1) throw new ValidationError("attempt must be a finite integer >= 1")
  return args.attempt < args.policy.maxAttempts
}

export function computeNextAttemptAt(args: {
  policy: RetryPolicy
  attempt: number
  now: Date
}): Date | null {
  const delay = getNextRetryDelay({ policy: args.policy, attempt: args.attempt })
  if (delay < 0) return null
  return new Date(args.now.getTime() + delay)
}
