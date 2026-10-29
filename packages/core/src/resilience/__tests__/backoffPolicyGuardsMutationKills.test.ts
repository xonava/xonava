import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain/errors"
import { validateBackoffPolicy, type BackoffPolicy } from "../backoff"

const valid = { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 2, maxDelayMs: 100, jitter: "none" } as const

const rejection = (policy: unknown): unknown => {
  try {
    validateBackoffPolicy(policy as BackoffPolicy, "P")
  } catch (error) {
    return error
  }
  return undefined
}

describe("validateBackoffPolicy guards", () => {
  it("rejects a missing or non-object policy with the object message", () => {
    for (const policy of [null, undefined, 5, "x", []]) {
      const error = rejection(policy)
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as Error).message).toBe("P must be an object")
    }
  })

  it("rejects an out-of-range initialDelayMs even when maxDelayMs would allow it", () => {
    const error = rejection({ ...valid, initialDelayMs: -1 })
    expect(error).toBeInstanceOf(ConfigurationError)
    expect((error as Error).message).toMatch(/^P initialDelayMs must be an integer from 0 to /)
  })

  it("rejects a backoffMultiplier outside 1 to 10", () => {
    for (const backoffMultiplier of [0, 0.99, 10.01, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
      const error = rejection({ ...valid, backoffMultiplier })
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as Error).message).toBe("P backoffMultiplier must be a number from 1 to 10")
    }
  })

  it("accepts the valid policy and returns a frozen copy", () => {
    const result = validateBackoffPolicy(valid)
    expect(result).toEqual(valid)
    expect(Object.isFrozen(result)).toBe(true)
  })
})
