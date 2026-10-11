import { describe, expect, it } from "vitest"
import { forAllAsync, forAll, type Rng } from "./harness"
import { ConfigurationError, FrameworkCoreError, RateLimitError, RuntimeCapabilityError, UnavailableError, ValidationError } from "../../domain/errors"
import {
  checkRateLimit, enforceRateLimit, parseTimeWindowMs,
  type RateLimitAlgorithm, type RateLimitConsumeRequest, type RateLimitStore,
} from "../../rate-limit/rateLimit"

/**
 * The rate-limit module is the glue in front of a store: it validates the
 * request, negotiates capabilities, picks the atomic / best-effort store
 * operation, interprets the bucket, and applies the failure mode. These
 * properties compare that glue with a decision-table model written from
 * docs/spec/rate-limit.md, and run whole request streams through a
 * brute-force reference store for each algorithm.
 */

// ------------------------------------------------------------ window parsing oracle

const WS = [" ", "\t", "\n", " ", " ", "﻿"]
const UNITS: Record<string, number> = {
  ms: 1, millisecond: 1, milliseconds: 1,
  s: 1000, second: 1000, seconds: 1000,
  m: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
}

/** Hand-rolled scan (no regex): 1-9 ASCII digits, optional whitespace, a known unit, case-insensitive, outer whitespace trimmed. */
function oracleWindow(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== "string") return null
  const isWs = (ch: string): boolean => WS.includes(ch) || ch === "\r" || ch === "\v" || ch === "\f" || ch === " " || ch === " " || ch === " " || ch === " " || ch === " " || ch === " " || ch === "　"
  const chars = [...value]
  let start = 0
  let end = chars.length
  while (start < end && isWs(chars[start]!)) start++
  while (end > start && isWs(chars[end - 1]!)) end--
  let i = start
  let digits = ""
  while (i < end && chars[i]! >= "0" && chars[i]! <= "9") digits += chars[i++]
  if (digits.length < 1 || digits.length > 9) return null
  while (i < end && isWs(chars[i]!)) i++
  const unit = chars.slice(i, end).join("").toLowerCase()
  const factor = Object.hasOwn(UNITS, unit) ? UNITS[unit] : undefined
  if (factor === undefined) return null
  const result = Number(digits) * factor
  return Number.isSafeInteger(result) && result > 0 ? result : null
}

function generateWindowText(rng: Rng): string | number {
  const roll = rng.int(10)
  if (roll === 0) return rng.pick([0, -1, 0.5, 1.5, NaN, Infinity, -Infinity, 1e300, 1, 1000, Number.MAX_SAFE_INTEGER])
  const digits = rng.pick(["0", "00", "1", "01", "7", "30", "999999999", "1000000000", "٣", "1.5", "-1", "", "12a"])
  const unit = rng.pick(["ms", "s", "m", "h", "d", "S", "MS", "Seconds", "minute", "minutes", "hour", "HOURS", "day", "days", "millisecond", "sec", "min", "w", "week", "", "second s", "μs"])
  const gap = rng.pick(["", " ", "  ", "\t", " ", "​"])
  const pad = rng.pick(["", " ", "\n", "　"])
  return `${pad}${digits}${gap}${unit}${pad}`
}

describe("rate-limit window parsing", () => {
  it("parseTimeWindowMs agrees with an independent scanner for numbers and text", () => {
    forAll("rate-limit window parsing", generateWindowText, (input) => {
      const expected = oracleWindow(input)
      if (expected === null) expect(() => parseTimeWindowMs(input)).toThrow(ConfigurationError)
      else expect(parseTimeWindowMs(input)).toBe(expected)
    }, { runs: 500, describe: (v) => JSON.stringify(typeof v === "number" ? String(v) : v) })
  })
})

// ------------------------------------------------------------ decision table

type StoreBehavior = "ok" | "throw-plain" | "throw-config" | "throw-capability" | "nan-count" | "negative-count" | "infinite-reset" | "undefined-bucket"

interface Scenario {
  via: "check" | "enforce"
  key: unknown
  limit: unknown
  window: unknown
  algorithm: unknown
  cost: unknown
  consistency: unknown
  failureMode: unknown
  configConsistency: unknown
  configFailureMode: unknown
  policy: { consistency?: unknown; failureMode?: unknown } | undefined
  store: {
    atomic: boolean
    consume: boolean
    consumeAtomically: boolean
    capabilities: { algorithms: RateLimitAlgorithm[]; weightedCost: boolean } | undefined
    behavior: StoreBehavior
    count: number
    resetAt: number
  }
  now: number
}

const ALGORITHMS: readonly RateLimitAlgorithm[] = ["fixed-window", "sliding-window", "token-bucket"]

function maybe<T>(rng: Rng, probability: number, make: () => T): T | undefined { return rng.bool(probability) ? make() : undefined }

function generateScenario(rng: Rng): Scenario {
  const bad = rng.bool(0.25)
  const enforce = rng.bool(0.4)
  const algorithms = rng.subset(ALGORITHMS, 0.7)
  return {
    via: enforce ? "enforce" : "check",
    key: rng.bool(bad ? 0.2 : 0.01) ? rng.pick(["", "  ", "\t", 5 as unknown]) : "k",
    limit: rng.bool(bad ? 0.3 : 0.02) ? rng.pick([0, -1, NaN, Infinity, 1.5]) : rng.pick([1, 2, 3, 10]),
    window: enforce ? (rng.bool(bad ? 0.3 : 0.05) ? generateWindowText(rng) : rng.pick(["1 second", "5m", 1000, 60_000, "2 hours"])) : (rng.bool(bad ? 0.3 : 0.02) ? rng.pick([0, -5, NaN, Infinity]) : rng.pick([1, 1000, 60_000])),
    algorithm: maybe(rng, 0.6, () => (rng.bool(bad ? 0.2 : 0.02) ? "leaky-bucket" : rng.pick(ALGORITHMS))),
    cost: maybe(rng, 0.4, () => (rng.bool(bad ? 0.3 : 0.02) ? rng.pick([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) : rng.pick([1, 1, 2, 5]))),
    consistency: maybe(rng, 0.5, () => (rng.bool(bad ? 0.2 : 0.02) ? "weak" : rng.pick(["atomic", "best-effort"] as const))),
    failureMode: maybe(rng, 0.5, () => (rng.bool(bad ? 0.2 : 0.02) ? "fail-sometimes" : rng.pick(["fail-open", "fail-closed"] as const))),
    configConsistency: enforce ? maybe(rng, 0.3, () => rng.pick(["atomic", "best-effort"] as const)) : undefined,
    configFailureMode: enforce ? maybe(rng, 0.3, () => rng.pick(["fail-open", "fail-closed"] as const)) : undefined,
    policy: maybe(rng, 0.35, () => ({
      ...(rng.bool(0.6) ? { consistency: rng.pick(["atomic", "best-effort"] as const) } : {}),
      ...(rng.bool(0.6) ? { failureMode: rng.pick(["fail-open", "fail-closed"] as const) } : {}),
    })),
    store: {
      atomic: rng.bool(0.7),
      consume: rng.bool(0.6),
      consumeAtomically: rng.bool(0.6),
      capabilities: maybe(rng, 0.6, () => ({ algorithms, weightedCost: rng.bool(0.6) })),
      behavior: rng.pick(["ok", "ok", "ok", "ok", "throw-plain", "throw-config", "throw-capability", "nan-count", "negative-count", "infinite-reset", "undefined-bucket"] as const),
      count: rng.pick([0, 1, 2, 3, 4, 10, 2.5]),
      resetAt: rng.pick([0, 500, 10_000, 1_000_000]),
    },
    now: rng.pick([0, 200, 9_999, 10_000, 10_001, 5_000_000]),
  }
}

interface Calls { method: string; args: unknown[] }

function buildStore(s: Scenario["store"], calls: Calls[]): RateLimitStore {
  const respond = async (): Promise<{ count: number; resetAt: number }> => {
    switch (s.behavior) {
      case "ok": return { count: s.count, resetAt: s.resetAt }
      case "throw-plain": throw new Error("backend down")
      case "throw-config": throw new ConfigurationError("store misconfigured")
      case "throw-capability": throw new RuntimeCapabilityError("store lacks something")
      case "nan-count": return { count: NaN, resetAt: s.resetAt }
      case "negative-count": return { count: -1, resetAt: s.resetAt }
      case "infinite-reset": return { count: s.count, resetAt: Infinity }
      case "undefined-bucket": return undefined as never
    }
  }
  const record = (method: string) => async (...args: unknown[]): Promise<{ count: number; resetAt: number }> => { calls.push({ method, args }); return respond() }
  const store: Record<string, unknown> = { increment: record("increment") }
  if (s.capabilities) store.capabilities = s.capabilities
  if (s.atomic) store.incrementAtomically = record("incrementAtomically")
  if (s.consume) store.consume = record("consume")
  if (s.consumeAtomically) store.consumeAtomically = record("consumeAtomically")
  return store as unknown as RateLimitStore
}

type Verdict =
  | { kind: "invalid"; classes: Array<typeof ValidationError | typeof ConfigurationError> }
  | { kind: "capability" }
  | { kind: "call"; method: string; args: unknown[]; failOpen: boolean; limit: number; windowMs: number }

const isAlgorithm = (v: unknown): v is RateLimitAlgorithm => v === "fixed-window" || v === "sliding-window" || v === "token-bucket"

function distinct(values: unknown[]): unknown[] { return [...new Set(values.filter((v) => v !== undefined))] }

function verdictFor(s: Scenario): Verdict {
  const problems: Array<typeof ValidationError | typeof ConfigurationError> = []
  if (typeof s.key !== "string" || s.key.trim().length === 0) problems.push(ValidationError)
  if (!(typeof s.limit === "number" && Number.isFinite(s.limit) && s.limit > 0)) problems.push(ConfigurationError)
  const windowMs = s.via === "enforce" ? oracleWindow(s.window) : (typeof s.window === "number" && Number.isFinite(s.window) && s.window > 0 ? s.window : null)
  if (windowMs === null) problems.push(ConfigurationError)
  const algorithm = s.algorithm ?? "fixed-window"
  if (!isAlgorithm(algorithm)) problems.push(ConfigurationError)
  const cost = s.cost ?? 1
  if (!(typeof cost === "number" && Number.isSafeInteger(cost) && cost > 0)) problems.push(ConfigurationError)
  const consistencies = distinct([s.consistency, s.configConsistency, s.policy?.consistency])
  const failureModes = distinct([s.failureMode, s.configFailureMode, s.policy?.failureMode])
  if (consistencies.length > 1 || failureModes.length > 1) problems.push(ConfigurationError)
  const consistency = consistencies[0] ?? "atomic"
  const failureMode = failureModes[0] ?? "fail-closed"
  if (consistency !== "atomic" && consistency !== "best-effort") problems.push(ConfigurationError)
  if (failureMode !== "fail-open" && failureMode !== "fail-closed") problems.push(ConfigurationError)
  if (failureMode === "fail-open" && consistency === "atomic") problems.push(ConfigurationError)
  if (problems.length > 0) return { kind: "invalid", classes: [...new Set(problems)] }

  const store = s.store
  const atomic = consistency === "atomic"
  const needsConsume = algorithm !== "fixed-window" || cost !== 1
  const storeAtomic = store.atomic
  if (atomic && !storeAtomic) return { kind: "capability" }
  if (store.capabilities && !store.capabilities.algorithms.includes(algorithm as RateLimitAlgorithm)) return { kind: "capability" }
  if (cost !== 1 && store.capabilities?.weightedCost !== true) return { kind: "capability" }
  if (needsConsume && !(atomic ? store.consumeAtomically : store.consume)) return { kind: "capability" }
  const request: RateLimitConsumeRequest = { key: s.key as string, windowMs: windowMs!, algorithm: algorithm as RateLimitAlgorithm, cost: cost as number }
  let method: string
  let args: unknown[]
  if (atomic) {
    if (store.consumeAtomically) { method = "consumeAtomically"; args = [request] } else { method = "incrementAtomically"; args = [request.key, request.windowMs] }
  } else if (store.consume) { method = "consume"; args = [request] } else { method = "increment"; args = [request.key, request.windowMs] }
  return { kind: "call", method, args, failOpen: failureMode === "fail-open" && consistency === "best-effort", limit: s.limit as number, windowMs: windowMs! }
}

async function runScenario(s: Scenario): Promise<unknown> {
  const calls: Calls[] = []
  const store = buildStore(s.store, calls)
  const nowMs = (): number => s.now
  const policy = s.policy as never
  try {
    if (s.via === "check") {
      const result = await checkRateLimit({
        store, key: s.key as string, limit: s.limit as number, windowMs: s.window as number, nowMs,
        ...(s.policy ? { policy } : {}),
        ...(s.algorithm !== undefined ? { algorithm: s.algorithm as RateLimitAlgorithm } : {}),
        ...(s.cost !== undefined ? { cost: s.cost as number } : {}),
        ...(s.consistency !== undefined ? { consistency: s.consistency as never } : {}),
        ...(s.failureMode !== undefined ? { failureMode: s.failureMode as never } : {}),
      })
      return { ok: result, calls }
    }
    const config = {
      max: s.limit as number, timeWindow: s.window as string | number,
      ...(s.algorithm !== undefined ? { algorithm: s.algorithm as RateLimitAlgorithm } : {}),
      ...(s.cost !== undefined ? { cost: s.cost as number } : {}),
      ...(s.configConsistency !== undefined ? { consistency: s.configConsistency as never } : {}),
      ...(s.configFailureMode !== undefined ? { failureMode: s.configFailureMode as never } : {}),
    }
    const result = await enforceRateLimit({
      store, key: s.key as string, config, nowMs,
      ...(s.policy ? { policy } : {}),
      ...(s.consistency !== undefined ? { consistency: s.consistency as never } : {}),
      ...(s.failureMode !== undefined ? { failureMode: s.failureMode as never } : {}),
    })
    return { ok: result, calls }
  } catch (error) {
    return { error, calls }
  }
}

describe("checkRateLimit / enforceRateLimit ≡ decision-table model", () => {
  it("validation order-independence, capability negotiation, store operation choice, bucket interpretation and failure modes", async () => {
    await forAllAsync("rate-limit decision table", generateScenario, async (s) => {
      const verdict = verdictFor(s)
      const outcome = await runScenario(s) as { ok?: { allowed: boolean; remaining: number; resetAt: number }; error?: unknown; calls: Calls[] }
      if (verdict.kind === "invalid") {
        expect(outcome.error, "invalid input must be rejected").toBeInstanceOf(FrameworkCoreError)
        expect(verdict.classes.some((cls) => outcome.error instanceof cls), `error class ${(outcome.error as Error).constructor.name} not among ${verdict.classes.map((c) => c.name)}`).toBe(true)
        expect(outcome.calls, "invalid input must not reach the store").toEqual([])
        return
      }
      if (verdict.kind === "capability") {
        expect(outcome.error).toBeInstanceOf(RuntimeCapabilityError)
        expect(outcome.calls, "a capability failure must not reach the store").toEqual([])
        return
      }
      expect(outcome.calls, "exactly one store operation, never downgraded").toEqual([{ method: verdict.method, args: verdict.args }])
      const b = s.store.behavior
      if (b === "throw-config" || b === "throw-capability") { expect(outcome.error, "store configuration/capability errors are never swallowed").toBeInstanceOf(FrameworkCoreError); return }
      const faulty = b === "throw-plain" || b === "nan-count" || b === "negative-count" || b === "infinite-reset" || b === "undefined-bucket"
      if (faulty) {
        if (verdict.failOpen) expect(outcome.ok).toEqual({ allowed: true, remaining: verdict.limit, resetAt: s.now + verdict.windowMs })
        else {
          expect(outcome.ok, "fail-closed must not allow on a store fault").toBeUndefined()
          expect(outcome.error).toBeDefined()
          if (b === "nan-count" || b === "negative-count" || b === "infinite-reset") expect(outcome.error).toBeInstanceOf(UnavailableError)
        }
        return
      }
      const allowed = s.store.count <= verdict.limit
      if (s.via === "enforce" && !allowed) {
        expect(outcome.error).toBeInstanceOf(RateLimitError)
        expect((outcome.error as RateLimitError).retryAfterMs).toBe(Math.max(s.store.resetAt - s.now, 0))
        return
      }
      expect(outcome.error).toBeUndefined()
      expect(outcome.ok).toEqual({ allowed, remaining: Math.max(verdict.limit - s.store.count, 0), resetAt: s.store.resetAt })
    }, { runs: 600, describe: (s) => JSON.stringify(s, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)) })
  })
})

// ------------------------------------------------------------ reference stores

interface Hit { at: number; cost: number }

/**
 * Brute-force reference stores: they keep the whole request log and recompute
 * the bucket from scratch on every call. The oracle for "allowed" is derived
 * independently of the store from the same log.
 */
function referenceStore(algorithm: "fixed-window" | "sliding-window", clock: { now: number }): { store: RateLimitStore; log: Map<string, Hit[]> } {
  const log = new Map<string, Hit[]>()
  const bucketOf = (key: string, windowMs: number, cost: number): { count: number; resetAt: number } => {
    const hits = log.get(key) ?? []
    const now = clock.now
    if (algorithm === "fixed-window") {
      const windowStart = Math.floor(now / windowMs) * windowMs
      const count = hits.filter((h) => h.at >= windowStart && h.at < windowStart + windowMs).reduce((sum, h) => sum + h.cost, 0) + cost
      hits.push({ at: now, cost }); log.set(key, hits)
      return { count, resetAt: windowStart + windowMs }
    }
    if (algorithm === "sliding-window") {
      // Reset is exclusive: a hit at time h stops counting at h + windowMs exactly.
      const live = hits.filter((h) => h.at + windowMs > now && h.at <= now)
      const count = live.reduce((sum, h) => sum + h.cost, 0) + cost
      hits.push({ at: now, cost }); log.set(key, hits)
      const oldest = live.length > 0 ? Math.min(...live.map((h) => h.at)) : now
      return { count, resetAt: oldest + windowMs }
    }
    throw new Error(`no reference for ${algorithm}`)
  }
  const store: RateLimitStore & { consumeAtomically: (r: RateLimitConsumeRequest) => Promise<{ count: number; resetAt: number }>; incrementAtomically: RateLimitStore["increment"] } = {
    capabilities: { algorithms: [algorithm], weightedCost: true },
    increment: async (key, windowMs) => bucketOf(key, windowMs, 1),
    incrementAtomically: async (key, windowMs) => bucketOf(key, windowMs, 1),
    consumeAtomically: async (r) => bucketOf(r.key, r.windowMs, r.cost),
  }
  return { store, log }
}

describe("request streams against brute-force reference stores", () => {
  it("fixed and sliding windows: allowed/remaining/retry-after follow the raw request log, including same-instant bursts and a clock that goes backwards", async () => {
    await forAllAsync("rate-limit fixed and sliding window streams", (rng) => ({
      algorithm: rng.pick(["fixed-window", "sliding-window"] as const),
      limit: 1 + rng.int(6),
      windowMs: rng.pick([1, 2, 10, 1000]),
      requests: Array.from({ length: 5 + rng.int(40) }, () => ({
        step: rng.pick([0, 0, 0, 1, 1, 2, 5, 9, 10, 11, 999, 1000, -1, -7]),
        cost: rng.pick([1, 1, 1, 2, 3]),
        key: rng.pick(["a", "a", "a", "b"]),
      })),
    }), async (c) => {
      const clock = { now: 100_000 }
      const { store, log } = referenceStore(c.algorithm, clock)
      const expectedLog = new Map<string, Hit[]>()
      for (const request of c.requests) {
        clock.now += request.step
        const hits = expectedLog.get(request.key) ?? []
        // Independent oracle for the count this request must observe.
        const live = c.algorithm === "fixed-window"
          ? hits.filter((h) => Math.floor(h.at / c.windowMs) === Math.floor(clock.now / c.windowMs))
          : hits.filter((h) => h.at <= clock.now && clock.now < h.at + c.windowMs)
        const count = live.reduce((sum, h) => sum + h.cost, 0) + request.cost
        hits.push({ at: clock.now, cost: request.cost }); expectedLog.set(request.key, hits)
        const result = await checkRateLimit({ store, key: request.key, limit: c.limit, windowMs: c.windowMs, algorithm: c.algorithm, cost: request.cost, nowMs: () => clock.now })
        expect(result.allowed, `count ${count} vs limit ${c.limit}`).toBe(count <= c.limit)
        expect(result.remaining).toBe(Math.max(c.limit - count, 0))
        expect(result.remaining).toBeGreaterThanOrEqual(0)
        expect(Number.isFinite(result.resetAt)).toBe(true)
        const enforced = await enforceRateLimit({ store, key: request.key, config: { max: c.limit, timeWindow: c.windowMs, algorithm: c.algorithm, cost: request.cost }, nowMs: () => clock.now }).then(() => null, (error: unknown) => error)
        if (enforced !== null) {
          expect(enforced).toBeInstanceOf(RateLimitError)
          expect((enforced as RateLimitError).retryAfterMs).toBeGreaterThanOrEqual(0)
        }
        // The enforcing call consumed again, so keep the oracle log in step.
        const live2 = c.algorithm === "fixed-window"
          ? expectedLog.get(request.key)!.filter((h) => Math.floor(h.at / c.windowMs) === Math.floor(clock.now / c.windowMs))
          : expectedLog.get(request.key)!.filter((h) => h.at <= clock.now && clock.now < h.at + c.windowMs)
        const count2 = live2.reduce((sum, h) => sum + h.cost, 0) + request.cost
        expectedLog.get(request.key)!.push({ at: clock.now, cost: request.cost })
        expect(enforced === null, `enforce count ${count2} vs limit ${c.limit}`).toBe(count2 <= c.limit)
      }
      expect([...log.keys()].sort()).toEqual([...expectedLog.keys()].sort())
    }, { runs: 200, describe: (c) => JSON.stringify(c) })
  })
})
