import { describe, expect, it } from "vitest"
import { computeNextAttemptAt, getNextRetryDelay, shouldRetry, validateRetryPolicy } from "../retryPolicy"

const policy = { maxAttempts: 3, delayMs: 100, backoffMultiplier: 2 }

describe("retry policy", () => {
  it("does not schedule a retry at the maxAttempts boundary", () => {
    expect(shouldRetry({ policy, attempt: 2 })).toBe(true)
    expect(shouldRetry({ policy, attempt: 3 })).toBe(false)
    expect(getNextRetryDelay({ policy, attempt: 3 })).toBe(-1)
    expect(computeNextAttemptAt({ policy, attempt: 3, now: new Date(0) })).toBeNull()
  })

  it("rejects non-finite and invalid retry values", () => {
    expect(() => validateRetryPolicy({ ...policy, maxAttempts: 0 })).toThrow()
    expect(() => validateRetryPolicy({ ...policy, delayMs: Number.POSITIVE_INFINITY })).toThrow()
    expect(() => validateRetryPolicy({ ...policy, backoffMultiplier: Number.NaN })).toThrow()
    expect(() => validateRetryPolicy({ ...policy, backoffMultiplier: 0 })).toThrow("greater than zero")
    expect(() => validateRetryPolicy({ ...policy, backoffMultiplier: -1 })).toThrow("greater than zero")
    expect(() => validateRetryPolicy({ ...policy, maxDelayMs: Number.NEGATIVE_INFINITY })).toThrow()
  })

  it("caps retry delay and computes the next attempt", () => {
    const capped = { ...policy, maxDelayMs: 150 }
    expect(getNextRetryDelay({ policy: capped, attempt: 3 })).toBe(-1)
    expect(getNextRetryDelay({ policy: capped, attempt: 2 })).toBe(150)
    expect(computeNextAttemptAt({ policy: capped, attempt: 2, now: new Date(1000) })).toEqual(new Date(1150))
    expect(() => shouldRetry({ policy, attempt: 0 })).toThrow()
  })
})
