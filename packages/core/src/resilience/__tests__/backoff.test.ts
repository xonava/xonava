import { describe, expect, it } from "vitest"
import { canRetryAfter, computeBackoffDelayMs, DEFAULT_BACKOFF_POLICY, validateBackoffPolicy, type BackoffPolicy } from "../backoff"
import { ConfigurationError } from "../../domain/errors"

const policy: BackoffPolicy = { maxAttempts: 5, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 1_000, jitter: "none" }

describe("backoff policy", () => {
  it("grows exponentially and caps at maxDelayMs", () => {
    expect([1, 2, 3, 4, 5, 60].map((attempt) => computeBackoffDelayMs(policy, attempt))).toEqual([100, 200, 400, 800, 1_000, 1_000])
    expect(computeBackoffDelayMs({ ...policy, backoffMultiplier: 10, maxDelayMs: 604_800_000 }, 10_000)).toBe(604_800_000)
  })

  it("applies equal jitter within [base/2, base) and never retries immediately", () => {
    const jittered = { ...policy, jitter: "equal" as const }
    expect(computeBackoffDelayMs(jittered, 2, () => 0)).toBe(100)
    expect(computeBackoffDelayMs(jittered, 2, () => 0.999999)).toBe(199)
    for (const bad of [Number.NaN, -1, 1, 7, Number.POSITIVE_INFINITY]) expect(computeBackoffDelayMs(jittered, 2, () => bad)).toBe(150)
  })

  it("never yields a 0 ms retry delay for a positive base, even with a 1 ms base and a zero sample", () => {
    const tiny: BackoffPolicy = { maxAttempts: 5, initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 1, jitter: "equal" }
    for (const sample of [0, 0.25, 0.4999, 0.5, 0.999999]) expect(computeBackoffDelayMs(tiny, 1, () => sample)).toBe(1)
    expect(computeBackoffDelayMs({ ...tiny, initialDelayMs: 3, maxDelayMs: 3 }, 1, () => 0)).toBe(1)
    // An explicit zero base stays an opt-in no-delay schedule.
    expect(computeBackoffDelayMs({ ...tiny, initialDelayMs: 0, maxDelayMs: 0 }, 1, () => 0)).toBe(0)
  })

  it("permits retries only while attempts remain", () => {
    expect(canRetryAfter(policy, 4)).toBe(true)
    expect(canRetryAfter(policy, 5)).toBe(false)
    expect(canRetryAfter(policy, 0)).toBe(false)
    expect(canRetryAfter(policy, 1.5)).toBe(false)
    expect(() => computeBackoffDelayMs(policy, 0)).toThrow(ConfigurationError)
  })

  it("validates and freezes policies", () => {
    expect(validateBackoffPolicy(DEFAULT_BACKOFF_POLICY)).toEqual(DEFAULT_BACKOFF_POLICY)
    expect(Object.isFrozen(validateBackoffPolicy({ ...policy }))).toBe(true)
    for (const bad of [
      null, [], { ...policy, maxAttempts: 0 }, { ...policy, maxAttempts: 101 }, { ...policy, initialDelayMs: -1 },
      { ...policy, maxDelayMs: 50 }, { ...policy, backoffMultiplier: 0.5 }, { ...policy, backoffMultiplier: Number.NaN },
      { ...policy, jitter: "full" }, { ...policy, maxDelayMs: 604_800_001 },
    ]) expect(() => validateBackoffPolicy(bad as unknown as BackoffPolicy)).toThrow(ConfigurationError)
  })
})
