import { describe, expect, it, vi } from "vitest"
import { enforceRateLimit, parseTimeWindowMs, checkRateLimit, type AtomicRateLimitStore, type RateLimitStore } from "../rateLimit"

function store(count: number, atomicIncrement = true): RateLimitStore | AtomicRateLimitStore {
  const base: RateLimitStore = {
    increment: vi.fn(async () => ({ count, resetAt: 10_000 })),
  }
  if (!atomicIncrement) return base
  const atomic: AtomicRateLimitStore = {
    ...base,
    incrementAtomically: vi.fn(async () => ({ count, resetAt: 10_000 })),
  }
  return atomic
}

describe("rate-limit ports", () => {
  it("parses numeric and unit time windows", () => {
    expect(parseTimeWindowMs(500)).toBe(500)
    expect(parseTimeWindowMs("2 seconds")).toBe(2000)
    expect(parseTimeWindowMs("3 minutes")).toBe(180000)
    expect(parseTimeWindowMs("1 hour")).toBe(3600000)
    expect(() => parseTimeWindowMs("0 minutes")).toThrow()
  })

  it("returns remaining capacity and supports explicit consistency", async () => {
    await expect(checkRateLimit({ store: store(2), key: "key", limit: 3, windowMs: 1000 })).resolves.toMatchObject({ allowed: true, remaining: 1 })
    await expect(checkRateLimit({ store: store(2, false), key: "key", limit: 3, windowMs: 1000, consistency: "atomic" })).rejects.toThrow()
    await expect(checkRateLimit({ store: store(2, false), key: "key", limit: 3, windowMs: 1000, consistency: "best-effort" })).resolves.toMatchObject({ allowed: true, remaining: 1 })
  })

  it("defaults to atomic and fail-closed enforcement", async () => {
    const failingStore: AtomicRateLimitStore = {
      increment: vi.fn(async () => { throw new Error("rate-limit backend unavailable") }),
      incrementAtomically: vi.fn(async () => { throw new Error("rate-limit backend unavailable") }),
    }

    await expect(checkRateLimit({ store: store(1, false), key: "key", limit: 3, windowMs: 1000 })).rejects.toThrow()
    await expect(checkRateLimit({ store: failingStore, key: "key", limit: 3, windowMs: 1000 })).rejects.toThrow("backend unavailable")
  })

  it("supports explicit fail-open behavior only for approximate runtime failures", async () => {
    const failingStore: RateLimitStore = {
      increment: vi.fn(async () => { throw new Error("rate-limit backend unavailable") }),
    }

    await expect(checkRateLimit({
      store: failingStore,
      key: "key",
      limit: 3,
      windowMs: 1000,
      consistency: "best-effort",
      failureMode: "fail-open",
      nowMs: () => 5000,
    })).resolves.toEqual({ allowed: true, remaining: 3, resetAt: 6000 })

    await expect(checkRateLimit({
      store: failingStore,
      key: "key",
      limit: 3,
      windowMs: 1000,
      policy: { consistency: "best-effort", failureMode: "fail-open" },
      nowMs: () => 5000,
    })).resolves.toEqual({ allowed: true, remaining: 3, resetAt: 6000 })

    await expect(checkRateLimit({
      store: failingStore,
      key: "key",
      limit: 3,
      windowMs: 1000,
      consistency: "atomic",
      failureMode: "fail-open",
      nowMs: () => 5000,
    })).rejects.toThrow("atomic")
  })

  it("rejects contradictory explicit consistency options", async () => {
    await expect(checkRateLimit({
      store: store(1), key: "key", limit: 3, windowMs: 1000,
      consistency: "atomic", policy: { consistency: "best-effort" },
    })).rejects.toThrow("conflict")
  })

  it("rejects malformed buckets from the rate-limit store", async () => {
    const malformed: AtomicRateLimitStore = {
      increment: vi.fn(async () => ({ count: Number.NaN, resetAt: 10_000 })),
      incrementAtomically: vi.fn(async () => ({ count: Number.NaN, resetAt: 10_000 })),
    }
    await expect(checkRateLimit({ store: malformed, key: "key", limit: 3, windowMs: 1000 })).rejects.toThrow("invalid bucket")
  })

  it("throws a bounded rate-limit error when the limit is exceeded", async () => {
    await expect(enforceRateLimit({ store: store(4), key: "key", config: { max: 3, timeWindow: "1 minute" }, nowMs: () => 9500 })).rejects.toMatchObject({ retryAfterMs: 500 })
    await expect(enforceRateLimit({ store: store(4), key: "key", config: { max: 3, timeWindow: "1 minute" } })).rejects.toThrow()
  })

  it("returns an allowed result from the enforcing wrapper", async () => {
    await expect(enforceRateLimit({ store: store(1), key: "key", config: { max: 3, timeWindow: 1000 } })).resolves.toMatchObject({ allowed: true, remaining: 2 })
  })

  it("rejects malformed windows and check inputs", async () => {
    expect(() => parseTimeWindowMs(Number.NaN)).toThrow()
    expect(() => parseTimeWindowMs("forever")).toThrow()
    await expect(checkRateLimit({ store: store(1), key: " ", limit: 1, windowMs: 1 })).rejects.toThrow()
    await expect(checkRateLimit({ store: store(1), key: "key", limit: 0, windowMs: 1 })).rejects.toThrow()
    await expect(checkRateLimit({ store: store(1), key: "key", limit: 1, windowMs: 0 })).rejects.toThrow()
    await expect(enforceRateLimit({ store: store(1), key: "key", config: { max: 0, timeWindow: 1 } })).rejects.toThrow()
  })
})
