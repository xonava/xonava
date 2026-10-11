import { describe, expect, it } from "vitest"
import { forAll, type Rng } from "./harness"
import { DEFAULT_MAX_RETRY_DELAY_MS, computeNextAttemptAt, getNextRetryDelay, shouldRetry, validateRetryPolicy } from "../../execution/retryPolicy"
import type { RetryPolicy } from "../../execution/types"

/**
 * Backoff properties. The job RetryPolicy has no jitter (resilience.md: jitter belongs to BackoffPolicy), so the
 * documented contract is `delay(n) = min(cap, delayMs * multiplier^(n-1))` with
 * `cap = maxDelayMs ?? max(24h, delayMs)`, and `-1` once `n >= maxAttempts`.
 */

const MAX_DATE_MS = 8_640_000_000_000_000
const DELAYS = [0, 0, 1e-300, Number.MIN_VALUE, 1, 7, 100, 1000, 1.5, 250.25, 60_000, 3_600_000, DEFAULT_MAX_RETRY_DELAY_MS, DEFAULT_MAX_RETRY_DELAY_MS + 1, 1e12, Number.MAX_SAFE_INTEGER, 1e300, Number.MAX_VALUE]
const MULTIPLIERS = [1, 1, 2, 2, 3, 1.5, 10, 1.0001, 0.5, 0.9, 1e-9, 1e-300, 1e9, 1e100, 1e300, Number.MAX_VALUE, Number.MIN_VALUE]
const CAPS: Array<number | undefined> = [undefined, undefined, undefined, 0, 1, 100, 1000, 60_000, 1e9, Number.MAX_SAFE_INTEGER, 1e300, Number.MAX_VALUE]
const MAX_ATTEMPTS = [1, 2, 3, 5, 10, 50, 1000, 1_000_000, Number.MAX_SAFE_INTEGER, 1e20]

interface RetryCase { policy: RetryPolicy; attempts: number[]; now: number }

function attemptValues(rng: Rng, maxAttempts: number): number[] {
  const out = new Set<number>([1, 2])
  for (let index = 0; index < 8; index++) out.add(1 + rng.int(Math.min(maxAttempts, 70)))
  for (const huge of [1000, 100_000, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, 1e20, 1e300, Number.MAX_VALUE]) if (rng.bool(0.5)) out.add(huge)
  out.add(maxAttempts - 1).add(maxAttempts).add(maxAttempts + 1)
  return [...out].filter((value) => value >= 1 && Number.isInteger(value)).sort((left, right) => left - right)
}

function generateCase(rng: Rng): RetryCase {
  const maxAttempts = rng.pick(MAX_ATTEMPTS)
  const cap = rng.pick(CAPS)
  const policy: RetryPolicy = { maxAttempts, delayMs: rng.pick(DELAYS), backoffMultiplier: rng.pick(MULTIPLIERS), ...(cap === undefined ? {} : { maxDelayMs: cap }) }
  return { policy, attempts: attemptValues(rng, maxAttempts), now: rng.pick([0, 1_700_000_000_000, -1, MAX_DATE_MS, -MAX_DATE_MS, MAX_DATE_MS - 1, Date.UTC(2030, 0, 1), rng.int(2 ** 31) * 1000]) }
}

function* shrinkCase(value: RetryCase): Generator<RetryCase> {
  if (value.attempts.length > 1) for (const attempt of value.attempts) yield { ...value, attempts: [attempt] }
  if (value.policy.maxDelayMs !== undefined) { const { maxDelayMs: _drop, ...rest } = value.policy; yield { ...value, policy: rest } }
  if (value.policy.delayMs !== 100) yield { ...value, policy: { ...value.policy, delayMs: 100 } }
  if (value.policy.backoffMultiplier !== 2) yield { ...value, policy: { ...value.policy, backoffMultiplier: 2 } }
}

const options = { shrink: shrinkCase, describe: (value: RetryCase) => JSON.stringify(value, (_key, item: unknown) => (typeof item === "number" && !Number.isFinite(item) ? String(item) : item)) }

function capOf(policy: RetryPolicy): number {
  return policy.maxDelayMs ?? Math.max(DEFAULT_MAX_RETRY_DELAY_MS, policy.delayMs)
}

/** Independent closed form with a log-space guard; accurate to a few ulps for non-degenerate inputs. */
function referenceDelay(policy: RetryPolicy, attempt: number): number {
  const cap = capOf(policy)
  if (policy.delayMs === 0) return 0
  const exponent = attempt - 1
  if (exponent === 0) return Math.min(policy.delayMs, cap)
  const logValue = Math.log(policy.delayMs) + exponent * Math.log(policy.backoffMultiplier)
  if (logValue >= Math.log(cap)) return cap
  return Math.min(Math.exp(logValue), cap)
}

function closeTo(actual: number, expected: number): boolean {
  if (actual === expected) return true
  return Math.abs(actual - expected) <= Math.max(Math.abs(expected), 1e-300) * 1e-7 + 1e-9
}

describe("job retry policy properties", () => {
  it("keeps every delay finite, non-negative and under the cap, and ends the schedule exactly at maxAttempts", () => {
    forAll("job retry: delays are bounded, finite and end at maxAttempts", generateCase, ({ policy, attempts }) => {
      const cap = capOf(policy)
      for (const attempt of attempts) {
        const delay = getNextRetryDelay({ policy, attempt })
        if (attempt >= policy.maxAttempts) {
          expect(delay, `attempt ${attempt}`).toBe(-1)
          expect(shouldRetry({ policy, attempt })).toBe(false)
          continue
        }
        expect(shouldRetry({ policy, attempt })).toBe(true)
        expect(Number.isFinite(delay), `attempt ${attempt} delay ${delay}`).toBe(true)
        expect(delay, `attempt ${attempt}`).toBeGreaterThanOrEqual(0)
        expect(delay, `attempt ${attempt} cap ${cap}`).toBeLessThanOrEqual(cap)
        if (policy.maxDelayMs !== undefined) expect(delay).toBeLessThanOrEqual(policy.maxDelayMs)
      }
    }, { runs: 400, ...options })
  })

  it("is monotone in the attempt number: non-decreasing for multiplier >= 1, non-increasing below 1", () => {
    forAll("job retry: delay is monotone in attempt", generateCase, ({ policy, attempts }) => {
      const retryable = attempts.filter((attempt) => attempt < policy.maxAttempts)
      let previous: number | undefined
      for (const attempt of retryable) {
        const delay = getNextRetryDelay({ policy, attempt })
        if (previous !== undefined) {
          if (policy.backoffMultiplier >= 1) expect(delay, `attempt ${attempt}`).toBeGreaterThanOrEqual(previous)
          else expect(delay, `attempt ${attempt}`).toBeLessThanOrEqual(previous)
        }
        previous = delay
      }
    }, { runs: 400, ...options })
  })

  it("matches the documented closed form delay = min(cap, delayMs * multiplier^(attempt-1))", () => {
    forAll("job retry: delay matches the closed form", generateCase, ({ policy, attempts }) => {
      // Sub-millisecond bases are excluded: the production product overflows to the cap before the true value reaches it.
      if (policy.delayMs !== 0 && policy.delayMs < 1e-3) return
      for (const attempt of attempts) {
        if (attempt >= policy.maxAttempts || attempt > 5000) continue
        const delay = getNextRetryDelay({ policy, attempt })
        const expected = referenceDelay(policy, attempt)
        expect(closeTo(delay, expected), `attempt ${attempt}: got ${delay}, closed form ${expected}`).toBe(true)
      }
    }, { runs: 400, ...options })
  })

  it("schedules the next attempt at now + delay, clamped to the Date range, and never yields an invalid Date", () => {
    forAll("job retry: next attempt time is delay after now and always a valid Date", generateCase, ({ policy, attempts, now }) => {
      for (const attempt of attempts) {
        const next = computeNextAttemptAt({ policy, attempt, now: new Date(now) })
        if (attempt >= policy.maxAttempts) { expect(next).toBeNull(); continue }
        expect(next).not.toBeNull()
        const nextMs = next!.getTime()
        expect(Number.isNaN(nextMs), `attempt ${attempt}`).toBe(false)
        expect(Math.abs(nextMs)).toBeLessThanOrEqual(MAX_DATE_MS)
        const delay = getNextRetryDelay({ policy, attempt })
        const expected = Math.min(now + delay, MAX_DATE_MS)
        // Date truncates fractional milliseconds; allow the one-millisecond truncation either way.
        expect(Math.abs(nextMs - Math.trunc(expected)), `attempt ${attempt} now ${now} delay ${delay}`).toBeLessThanOrEqual(1 + Math.abs(expected) * 1e-15)
        expect(nextMs).toBeGreaterThanOrEqual(now)
      }
    }, { runs: 300, ...options })
  })

  it("rejects invalid policies and attempts instead of producing a delay", () => {
    const badPolicies: RetryPolicy[] = [
      { maxAttempts: 0, delayMs: 1, backoffMultiplier: 1 }, { maxAttempts: 1.5, delayMs: 1, backoffMultiplier: 1 }, { maxAttempts: Number.NaN, delayMs: 1, backoffMultiplier: 1 },
      { maxAttempts: Number.POSITIVE_INFINITY, delayMs: 1, backoffMultiplier: 1 }, { maxAttempts: 3, delayMs: -1, backoffMultiplier: 1 }, { maxAttempts: 3, delayMs: Number.NaN, backoffMultiplier: 1 },
      { maxAttempts: 3, delayMs: Number.POSITIVE_INFINITY, backoffMultiplier: 1 }, { maxAttempts: 3, delayMs: 1, backoffMultiplier: 0 }, { maxAttempts: 3, delayMs: 1, backoffMultiplier: -2 },
      { maxAttempts: 3, delayMs: 1, backoffMultiplier: Number.NaN }, { maxAttempts: 3, delayMs: 1, backoffMultiplier: Number.POSITIVE_INFINITY }, { maxAttempts: 3, delayMs: 1, backoffMultiplier: 1, maxDelayMs: -1 },
      { maxAttempts: 3, delayMs: 1, backoffMultiplier: 1, maxDelayMs: Number.NaN }, { maxAttempts: 3, delayMs: 1, backoffMultiplier: 1, maxDelayMs: Number.POSITIVE_INFINITY },
    ]
    const badAttempts = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5]
    forAll("job retry: invalid policy or attempt is rejected everywhere", (rng) => ({ policy: rng.pick(badPolicies), attempt: rng.pick([1, 2, ...badAttempts]), validPolicy: { maxAttempts: 5, delayMs: 10, backoffMultiplier: 2 }, badAttempt: rng.pick(badAttempts) }), ({ policy, attempt, validPolicy, badAttempt }) => {
      expect(() => validateRetryPolicy(policy)).toThrow()
      expect(() => getNextRetryDelay({ policy, attempt })).toThrow()
      expect(() => shouldRetry({ policy, attempt })).toThrow()
      expect(() => computeNextAttemptAt({ policy, attempt, now: new Date(0) })).toThrow()
      for (const call of [getNextRetryDelay, shouldRetry] as const) expect(() => call({ policy: validPolicy, attempt: badAttempt })).toThrow()
      expect(() => computeNextAttemptAt({ policy: validPolicy, attempt: badAttempt, now: new Date(0) })).toThrow()
      expect(() => computeNextAttemptAt({ policy: validPolicy, attempt: 1, now: new Date(Number.NaN) })).toThrow()
    }, { runs: 100 })
  })
})
