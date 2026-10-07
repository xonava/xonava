import type { RetryPolicy } from "./types"
import { ValidationError } from "../domain"

/** Backoff ceiling applied when a policy sets no maxDelayMs (24 hours). */
export const DEFAULT_MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000

/** Largest millisecond timestamp a JavaScript Date can represent. */
const MAX_DATE_MS = 8_640_000_000_000_000

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

  const { delayMs, backoffMultiplier } = args.policy
  // Without an explicit cap, growth stops at 24h (but never below the configured base delay).
  const cap = args.policy.maxDelayMs ?? Math.max(DEFAULT_MAX_RETRY_DELAY_MS, delayMs)
  const exponent = args.attempt - 1
  if (delayMs === 0 || exponent === 0) return Math.min(delayMs, cap)
  // Compare in log space so large attempts/multipliers can never overflow to Infinity.
  if (backoffMultiplier > 1 && exponent * Math.log(backoffMultiplier) >= Math.log(cap / delayMs)) return cap
  const delay = delayMs * Math.pow(backoffMultiplier, exponent)
  return Number.isFinite(delay) ? Math.min(delay, cap) : cap
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
  const nowMs = args.now.getTime()
  if (!Number.isFinite(nowMs)) throw new ValidationError("now must be a valid Date")
  const next = new Date(Math.min(nowMs + delay, MAX_DATE_MS))
  if (Number.isNaN(next.getTime())) throw new ValidationError("Computed retry time is not a valid Date")
  return next
}
