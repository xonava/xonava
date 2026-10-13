import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, UnavailableError, ValidationError } from "../../domain/errors"
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

  it("requires positive safe integers for limit, cost and window (configuration errors)", async () => {
    for (const limit of [2.5, 0.5, 1e300, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, 0, -1]) {
      await expect(checkRateLimit({ store: store(1), key: "key", limit, windowMs: 1000 }), `limit ${limit}`).rejects.toBeInstanceOf(ConfigurationError)
      await expect(enforceRateLimit({ store: store(1), key: "key", config: { max: limit, timeWindow: 1000 } }), `max ${limit}`).rejects.toBeInstanceOf(ConfigurationError)
    }
    for (const windowMs of [1.5, 0.5, 1e300, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, 0, -1]) {
      await expect(checkRateLimit({ store: store(1), key: "key", limit: 3, windowMs }), `windowMs ${windowMs}`).rejects.toBeInstanceOf(ConfigurationError)
      expect(() => parseTimeWindowMs(windowMs), `timeWindow ${windowMs}`).toThrow(ConfigurationError)
    }
    await expect(checkRateLimit({ store: store(1), key: "key", limit: Number.MAX_SAFE_INTEGER, windowMs: Number.MAX_SAFE_INTEGER })).resolves.toMatchObject({ allowed: true })
    expect(parseTimeWindowMs(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    // A blank key stays a request-input (validation) error.
    await expect(checkRateLimit({ store: store(1), key: " ", limit: 3, windowMs: 1000 })).rejects.toBeInstanceOf(ValidationError)
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

describe("rate-limit configuration hardening", () => {
  it("rejects fail-open on an atomic limiter instead of silently failing closed", async () => {
    const atomic = { increment: vi.fn(), incrementAtomically: vi.fn(async () => { throw new Error("down") }) }
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: 1000, consistency: "atomic", failureMode: "fail-open" })).rejects.toThrow("fail-open requires best-effort")
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: 1000, failureMode: "fail-open" })).rejects.toThrow("fail-open requires best-effort")
    expect(atomic.incrementAtomically).not.toHaveBeenCalled()
  })

  it("parses common window units and rejects overflowing windows", () => {
    expect(["500ms", "30s", "2 minutes", "1h", "1 day", "7d"].map(parseTimeWindowMs)).toEqual([500, 30_000, 120_000, 3_600_000, 86_400_000, 604_800_000])
    expect(() => parseTimeWindowMs("0s")).toThrow()
    expect(() => parseTimeWindowMs("1 week")).toThrow()
    expect(() => parseTimeWindowMs("9999999999 days")).toThrow()
  })
})

describe("rate-limit error contract", () => {
  it("treats an invalid store bucket as a dependency fault, not a client error", async () => {
    const malformed: AtomicRateLimitStore = {
      increment: vi.fn(async () => ({ count: Number.NaN, resetAt: 10_000 })),
      incrementAtomically: vi.fn(async () => ({ count: 1, resetAt: Number.POSITIVE_INFINITY })),
    }
    await expect(checkRateLimit({ store: malformed, key: "key", limit: 3, windowMs: 1000 })).rejects.toBeInstanceOf(UnavailableError)
    await expect(checkRateLimit({ store: malformed, key: "key", limit: 3, windowMs: 1000, consistency: "best-effort" })).rejects.toBeInstanceOf(UnavailableError)
  })

  it("applies fail-open to an invalid store bucket on a best-effort limiter", async () => {
    const malformed: RateLimitStore = { increment: vi.fn(async () => ({ count: -1, resetAt: 10_000 })) }
    await expect(checkRateLimit({ store: malformed, key: "key", limit: 3, windowMs: 1000, consistency: "best-effort", failureMode: "fail-open", nowMs: () => 5 })).resolves.toEqual({ allowed: true, remaining: 3, resetAt: 1005 })
  })

  it("reports limiter misconfiguration as a ConfigurationError", async () => {
    const atomic = { increment: vi.fn(), incrementAtomically: vi.fn(async () => ({ count: 1, resetAt: 1 })) }
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: 1000, failureMode: "fail-open" })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 0, windowMs: 1000 })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: Number.NaN })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: 1000, cost: 0 })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: 1000, algorithm: "leaky" as never })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: 1000, consistency: "typo" as never })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: 1000, consistency: "atomic", policy: { consistency: "best-effort" } })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: 1000, failureMode: "typo" as never })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(checkRateLimit({ store: atomic, key: "k", limit: 1, windowMs: 1000, failureMode: "fail-closed", policy: { failureMode: "fail-open", consistency: "best-effort" } })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(enforceRateLimit({ store: atomic, key: "k", config: { max: Number.NaN, timeWindow: 1000 } })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(enforceRateLimit({ store: atomic, key: "k", config: { max: 1, timeWindow: 1000, consistency: "atomic" }, consistency: "best-effort" })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(enforceRateLimit({ store: atomic, key: "k", config: { max: 1, timeWindow: "1 fortnight" } })).rejects.toBeInstanceOf(ConfigurationError)
    expect(() => parseTimeWindowMs("0s")).toThrow(ConfigurationError)
    expect(() => parseTimeWindowMs(-1)).toThrow(ConfigurationError)
    expect(() => parseTimeWindowMs(null as never)).toThrow(ConfigurationError)
  })

  it("keeps a blank request-derived key a ValidationError", async () => {
    await expect(checkRateLimit({ store: store(1), key: " ", limit: 1, windowMs: 1000 })).rejects.toBeInstanceOf(ValidationError)
  })
})
