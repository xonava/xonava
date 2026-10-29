import { describe, expect, it } from "vitest"
import { ConfigurationError, RateLimitError, RuntimeCapabilityError, UnavailableError, ValidationError } from "../../domain/errors"
import { checkRateLimit, enforceRateLimit, parseTimeWindowMs, type RateLimitStore } from "../rateLimit"

const POSITIVE = "Rate-limit time window must be a positive safe integer of milliseconds."
const atomicStore = (count = 1, resetAt = 5000): RateLimitStore => ({ increment: async () => ({ count, resetAt }), incrementAtomically: async () => ({ count, resetAt }) } as RateLimitStore)
const plainStore = (count = 1, resetAt = 5000): RateLimitStore => ({ increment: async () => ({ count, resetAt }) })
const base = { store: atomicStore(), key: "k", limit: 5, windowMs: 1000 }
const failing = (): RateLimitStore => ({ increment: async () => { throw new UnavailableError("down") } })
const rejects = async (promise: Promise<unknown>, type: new (...a: never[]) => Error, message: string) => {
  const e = await promise.then(() => undefined, (error: unknown) => error)
  expect(e).toBeInstanceOf(type)
  expect((e as Error).message).toBe(message)
}

describe("parseTimeWindowMs", () => {
  it("validates numeric windows", () => {
    for (const v of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(() => parseTimeWindowMs(v)).toThrow(new ConfigurationError(POSITIVE))
    expect(parseTimeWindowMs(1)).toBe(1)
  })
  it("rejects values that are neither number nor string", () => {
    for (const v of [null, undefined, {}, true]) expect(() => parseTimeWindowMs(v as never)).toThrow(new ConfigurationError("Rate-limit time window must be a string or number."))
  })
  it("parses every unit and rejects malformed text", () => {
    const cases: [string, number][] = [["1ms", 1], ["2 milliseconds", 2], ["1 millisecond", 1], ["3s", 3000], ["3 seconds", 3000], ["1 second", 1000], ["2m", 120_000], ["2 minutes", 120_000], ["1 minute", 60_000], ["2h", 7_200_000], ["2 hours", 7_200_000], ["1 hour", 3_600_000], ["1d", 86_400_000], ["2 days", 172_800_000], ["1 day", 86_400_000], [" 5 S ", 5000], ["99999999d", 99_999_999 * 86_400_000]]
    for (const [text, ms] of cases) expect(parseTimeWindowMs(text)).toBe(ms)
    for (const text of ["5 weeks", "", "s", "1.5s", "-1s", "1000000000s", "5 sec"]) expect(() => parseTimeWindowMs(text)).toThrow(new ConfigurationError(`Invalid rate-limit time window: ${text}`))
    expect(() => parseTimeWindowMs("0s")).toThrow(new ConfigurationError(POSITIVE))
    expect(() => parseTimeWindowMs("999999999d")).toThrow(new ConfigurationError(POSITIVE))
  })
})

describe("checkRateLimit validation", () => {
  it("validates key, limit, window, algorithm and cost", async () => {
    for (const key of ["", "   ", 5]) await rejects(checkRateLimit({ ...base, key: key as never }), ValidationError, "Rate-limit key must be non-empty.")
    for (const limit of [0, -1, 1.5]) await rejects(checkRateLimit({ ...base, limit }), ConfigurationError, "Rate-limit max must be a positive safe integer.")
    for (const windowMs of [0, -1, 1.5]) await rejects(checkRateLimit({ ...base, windowMs }), ConfigurationError, "Rate-limit window must be a positive safe integer of milliseconds.")
    await rejects(checkRateLimit({ ...base, algorithm: "leaky" as never }), ConfigurationError, "Rate-limit algorithm is invalid.")
    for (const cost of [0, -1, 1.5]) await rejects(checkRateLimit({ ...base, cost }), ConfigurationError, "Rate-limit cost must be a positive safe integer.")
  })
  it("validates consistency and failure-mode options", async () => {
    await rejects(checkRateLimit({ ...base, consistency: "atomic", policy: { consistency: "best-effort" } }), ConfigurationError, "Rate-limit consistency and policy options conflict.")
    await rejects(checkRateLimit({ ...base, consistency: "weird" as never }), ConfigurationError, "Rate-limit consistency is invalid.")
    await rejects(checkRateLimit({ ...base, failureMode: "weird" as never }), ConfigurationError, "Rate-limit failure mode is invalid.")
    await rejects(checkRateLimit({ ...base, consistency: "best-effort", failureMode: "fail-open", policy: { failureMode: "fail-closed" } }), ConfigurationError, "Rate-limit failure mode options conflict.")
    await rejects(checkRateLimit({ ...base, failureMode: "fail-open" }), ConfigurationError, "Rate-limit fail-open requires best-effort consistency; atomic limits always fail closed.")
    expect((await checkRateLimit({ ...base, consistency: "atomic", policy: { consistency: "atomic" } })).allowed).toBe(true)
    expect((await checkRateLimit({ ...base, policy: { consistency: "best-effort" }, store: plainStore() })).allowed).toBe(true)
  })
  it("requires the atomic capability and names it", async () => {
    const e = await checkRateLimit({ ...base, store: plainStore() }).then(() => undefined, (error: unknown) => error)
    expect(e).toBeInstanceOf(RuntimeCapabilityError)
    expect((e as Error).message).toBe("atomicIncrement")
  })
})

describe("checkRateLimit decisions and failure handling", () => {
  it("computes allowed, remaining and reset exactly", async () => {
    expect(await checkRateLimit({ ...base, store: atomicStore(5, 77) })).toEqual({ allowed: true, remaining: 0, resetAt: 77 })
    expect(await checkRateLimit({ ...base, store: atomicStore(6, 77) })).toEqual({ allowed: false, remaining: 0, resetAt: 77 })
    expect(await checkRateLimit({ ...base, store: atomicStore(2, 77) })).toEqual({ allowed: true, remaining: 3, resetAt: 77 })
    expect((await checkRateLimit({ ...base, store: atomicStore(0, 77) })).remaining).toBe(5)
  })
  it("treats a malformed bucket as an unavailable store", async () => {
    for (const bucket of [{ count: Number.NaN, resetAt: 1 }, { count: -1, resetAt: 1 }, { count: 1, resetAt: Number.NaN }, { count: Number.POSITIVE_INFINITY, resetAt: 1 }]) {
      const store = { increment: async () => bucket, incrementAtomically: async () => bucket } as RateLimitStore
      await rejects(checkRateLimit({ ...base, store }), UnavailableError, "Rate-limit store returned an invalid bucket.")
    }
    expect((await checkRateLimit({ ...base, store: atomicStore(0, 0) })).resetAt).toBe(0)
  })
  it("fails open only for best-effort limits configured to fail open", async () => {
    const open = await checkRateLimit({ ...base, store: failing(), consistency: "best-effort", failureMode: "fail-open", nowMs: () => 100 })
    expect(open).toEqual({ allowed: true, remaining: 5, resetAt: 1100 })
    await rejects(checkRateLimit({ ...base, store: failing(), consistency: "best-effort", failureMode: "fail-closed" }), UnavailableError, "down")
    await rejects(checkRateLimit({ ...base, store: failing(), consistency: "best-effort" }), UnavailableError, "down")
    const atomicFail = { increment: async () => { throw new UnavailableError("down") }, incrementAtomically: async () => { throw new UnavailableError("down") } } as RateLimitStore
    await rejects(checkRateLimit({ ...base, store: atomicFail }), UnavailableError, "down")
    const defaultNow = await checkRateLimit({ ...base, store: failing(), consistency: "best-effort", failureMode: "fail-open" })
    expect(defaultNow.resetAt).toBeGreaterThan(Date.now() - 5000)
  })
  it("never swallows configuration and capability errors in fail-open mode", async () => {
    const caps = { increment: async () => ({ count: 1, resetAt: 1 }), capabilities: { algorithms: ["fixed-window"], weightedCost: false } } as RateLimitStore
    const opts = { ...base, store: caps, consistency: "best-effort", failureMode: "fail-open" } as const
    await rejects(checkRateLimit({ ...opts, algorithm: "sliding-window" }), RuntimeCapabilityError, "rateLimitAlgorithm:sliding-window")
    await rejects(checkRateLimit({ ...opts, cost: 2 }), RuntimeCapabilityError, "weightedRateLimitCost")
    const weighted = { increment: async () => ({ count: 1, resetAt: 1 }), capabilities: { algorithms: ["fixed-window", "token-bucket"], weightedCost: true } } as RateLimitStore
    await rejects(checkRateLimit({ ...opts, store: weighted, cost: 2 }), RuntimeCapabilityError, "rateLimitConsume")
    await rejects(checkRateLimit({ ...opts, store: weighted, algorithm: "token-bucket" }), RuntimeCapabilityError, "rateLimitConsume")
    const throwing = { increment: async () => { throw new ConfigurationError("bad") } } as RateLimitStore
    await rejects(checkRateLimit({ ...opts, store: throwing }), ConfigurationError, "bad")
  })
  it("routes through consume when the algorithm or cost requires it", async () => {
    const seen: unknown[] = []
    const store = { increment: async () => ({ count: 9, resetAt: 1 }), consume: async (r: unknown) => { seen.push(r); return { count: 2, resetAt: 9 } }, capabilities: { algorithms: ["fixed-window", "token-bucket"], weightedCost: true } } as RateLimitStore
    const r = await checkRateLimit({ ...base, store, consistency: "best-effort", algorithm: "token-bucket", cost: 3 })
    expect(r).toEqual({ allowed: true, remaining: 3, resetAt: 9 })
    expect(seen).toEqual([{ key: "k", windowMs: 1000, algorithm: "token-bucket", cost: 3 }])
    const atomic = { increment: async () => ({ count: 9, resetAt: 1 }), incrementAtomically: async () => ({ count: 9, resetAt: 1 }), consumeAtomically: async () => ({ count: 4, resetAt: 8 }) } as RateLimitStore
    expect((await checkRateLimit({ ...base, store: atomic })).resetAt).toBe(8)
  })
})

describe("enforceRateLimit", () => {
  const cfg = { max: 5, timeWindow: "1s" }
  it("validates the configured maximum", async () => {
    for (const max of [0, -1, 1.5]) await rejects(enforceRateLimit({ store: atomicStore(), key: "k", config: { ...cfg, max } }), ConfigurationError, "Rate-limit max must be a positive safe integer.")
  })
  it("rejects configuration that conflicts with explicit options", async () => {
    const run = (config: object, extra: object) => enforceRateLimit({ store: plainStore(), key: "k", config: { ...cfg, ...config } as never, ...extra })
    await rejects(run({ consistency: "best-effort" }, { consistency: "atomic" }), ConfigurationError, "Rate-limit consistency configuration conflicts with explicit options.")
    await rejects(run({ consistency: "best-effort" }, { policy: { consistency: "atomic" } }), ConfigurationError, "Rate-limit consistency configuration conflicts with explicit options.")
    await rejects(run({ failureMode: "fail-open", consistency: "best-effort" }, { failureMode: "fail-closed" }), ConfigurationError, "Rate-limit failureMode configuration conflicts with explicit options.")
    await rejects(run({ failureMode: "fail-open", consistency: "best-effort" }, { policy: { failureMode: "fail-closed" } }), ConfigurationError, "Rate-limit failureMode configuration conflicts with explicit options.")
    expect((await run({ consistency: "best-effort" }, { consistency: "best-effort", policy: { consistency: "best-effort" } })).allowed).toBe(true)
    expect((await run({ consistency: "best-effort", failureMode: "fail-open" }, {})).allowed).toBe(true)
  })
  it("parses the window, honours config options and reports retry-after on denial", async () => {
    const seen: number[] = []
    const store = { increment: async (_k: string, w: number) => { seen.push(w); return { count: 1, resetAt: 9 } } } as RateLimitStore
    await enforceRateLimit({ store, key: "k", config: { max: 5, timeWindow: "2s", consistency: "best-effort" } })
    expect(seen).toEqual([2000])
    const denied = enforceRateLimit({ store: atomicStore(9, 1500), key: "k", config: cfg, nowMs: () => 1000 })
    const e = await denied.then(() => undefined, (error: unknown) => error as RateLimitError)
    expect(e).toBeInstanceOf(RateLimitError)
    expect((e as RateLimitError).retryAfterMs).toBe(500)
    const past = await enforceRateLimit({ store: atomicStore(9, 500), key: "k", config: cfg, nowMs: () => 1000 }).then(() => undefined, (error: unknown) => error as RateLimitError)
    expect((past as RateLimitError).retryAfterMs).toBe(0)
    const clock = await enforceRateLimit({ store: atomicStore(9, Date.now() + 60_000), key: "k", config: cfg }).then(() => undefined, (error: unknown) => error as RateLimitError)
    expect((clock as RateLimitError).retryAfterMs).toBeGreaterThan(0)
    expect((clock as RateLimitError).retryAfterMs).toBeLessThanOrEqual(60_000)
  })
  it("uses the injected clock for fail-open results", async () => {
    const r = await enforceRateLimit({ store: failing(), key: "k", config: { ...cfg, consistency: "best-effort", failureMode: "fail-open" }, nowMs: () => 10 })
    expect(r).toEqual({ allowed: true, remaining: 5, resetAt: 1010 })
  })
})
