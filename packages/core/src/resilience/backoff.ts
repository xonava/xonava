import { ConfigurationError } from "../domain/errors"

/**
 * Serializable retry/backoff policy shared by every retrying capability.
 * It is pure data so it can be persisted, fingerprinted, and implemented
 * identically in any language (docs/spec/resilience.md).
 *
 * The delay after failed attempt `n` (1-based) is
 *   base = min(maxDelayMs, initialDelayMs * backoffMultiplier^(n-1))
 * and with `jitter: "equal"` it is `base/2 + random * base/2` (rounded down),
 * which spreads retries without ever retrying immediately.
 */
export interface BackoffPolicy {
  /** Total attempts including the first one. */
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly backoffMultiplier: number
  readonly maxDelayMs: number
  readonly jitter: "none" | "equal"
}

export const MAX_BACKOFF_ATTEMPTS = 100
export const MAX_BACKOFF_DELAY_MS = 7 * 24 * 60 * 60 * 1000

export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 1_000,
  backoffMultiplier: 2,
  maxDelayMs: 60_000,
  jitter: "equal",
})

export function validateBackoffPolicy(policy: BackoffPolicy, label = "Backoff policy"): BackoffPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new ConfigurationError(`${label} must be an object`)
  const { maxAttempts, initialDelayMs, backoffMultiplier, maxDelayMs, jitter } = policy
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_BACKOFF_ATTEMPTS) throw new ConfigurationError(`${label} maxAttempts must be an integer from 1 to ${MAX_BACKOFF_ATTEMPTS}`)
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > MAX_BACKOFF_DELAY_MS) throw new ConfigurationError(`${label} initialDelayMs must be an integer from 0 to ${MAX_BACKOFF_DELAY_MS}`)
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < initialDelayMs || maxDelayMs > MAX_BACKOFF_DELAY_MS) throw new ConfigurationError(`${label} maxDelayMs must be an integer from initialDelayMs to ${MAX_BACKOFF_DELAY_MS}`)
  if (typeof backoffMultiplier !== "number" || !Number.isFinite(backoffMultiplier) || backoffMultiplier < 1 || backoffMultiplier > 10) throw new ConfigurationError(`${label} backoffMultiplier must be a number from 1 to 10`)
  if (jitter !== "none" && jitter !== "equal") throw new ConfigurationError(`${label} jitter must be "none" or "equal"`)
  return Object.freeze({ maxAttempts, initialDelayMs, backoffMultiplier, maxDelayMs, jitter })
}

/** Whether another attempt is permitted after `failedAttempt` attempts have been made. */
export function canRetryAfter(policy: BackoffPolicy, failedAttempt: number): boolean {
  return Number.isSafeInteger(failedAttempt) && failedAttempt >= 1 && failedAttempt < policy.maxAttempts
}

/**
 * Delay before the attempt that follows `failedAttempt`. `random` must return a
 * value in [0, 1); it is injectable so behaviour is reproducible in tests and
 * conformance vectors.
 */
export function computeBackoffDelayMs(policy: BackoffPolicy, failedAttempt: number, random: () => number = Math.random): number {
  if (!Number.isSafeInteger(failedAttempt) || failedAttempt < 1) throw new ConfigurationError("Backoff attempt must be a positive integer")
  // Cap the exponent so the intermediate value cannot overflow to Infinity.
  const exponent = Math.min(failedAttempt - 1, 64)
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * Math.pow(policy.backoffMultiplier, exponent))
  if (policy.jitter === "none") return Math.floor(base)
  let sample = random()
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample >= 1) sample = 0.5
  return Math.floor(base / 2 + (sample * base) / 2)
}
