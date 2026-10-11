import { describe, expect, it, vi } from "vitest"
import { forAllAsync, forAll, type Rng } from "./harness"
import { FakeSignal } from "./primitiveFakeSignal"
import { CancelledError, ConfigurationError, ForbiddenError, TimeoutError, UnavailableError } from "../../domain/errors"
import { computeBackoffDelayMs, MAX_BACKOFF_ATTEMPTS, MAX_BACKOFF_DELAY_MS, validateBackoffPolicy, type BackoffPolicy } from "../../resilience/backoff"
import { createBulkhead, createCircuitBreaker, withResilience, type Bulkhead, type CircuitBreaker } from "../../resilience/executor"
import { validateResiliencePolicy, type ExternalCallSemantics, type ResiliencePolicy } from "../../resilience/resilience"

/**
 * Differential tests for the resilience executor. The executor is run under a
 * fake clock (setTimeout/clearTimeout/Date) against a small discrete-event
 * model of the documented semantics: per-attempt timeout, jittered
 * exponential retry, caller abort (before / during an attempt / during
 * backoff), circuit breaker, and bulkhead slot accounting.
 */

const DAY_MS = 24 * 60 * 60 * 1000

type ErrKind = "retryable" | "permanent" | "plain" | "string" | "undefined"
interface Step { kind: "ok" | "fail" | "hang"; d: number; err: ErrKind; honors: boolean }
type ReasonKind = "default" | "string" | "error" | "domTimeout" | "cancelled" | "frameworkTimeout" | "null"
type SemanticsKind = "read" | "idempotent" | "non-idempotent"

interface ResilienceCase {
  steps: Step[]
  timeoutMs: number | undefined
  retry: { maxAttempts: number; backoffMs: number | undefined } | undefined
  semantics: SemanticsKind
  breaker: { failureThreshold: number; resetAfterMs: number } | undefined
  bulkhead: boolean
  rand: number[]
  preAborted: boolean
  reason: ReasonKind
  abortAt: number | undefined
}

type Expected =
  | { kind: "ok"; attempt: number; at: number }
  | { kind: "work-error"; attempt: number; at: number }
  | { kind: "timeout"; at: number }
  | { kind: "abort"; at: number }
  | { kind: "unavailable"; at: number; why: "breaker" | "outstanding" }
  | { kind: "pending" }

interface Model { result: Expected; events: number[]; tie: boolean; attempts: number; slotLeaked: boolean; breaker: { status: string; fails: number } }

function effectiveBackoff(c: ResilienceCase): { maxAttempts: number; init: number } | undefined {
  if (!c.retry || c.retry.maxAttempts <= 1 || c.semantics === "non-idempotent") return undefined
  return { maxAttempts: c.retry.maxAttempts, init: c.retry.backoffMs ?? 100 }
}

/** Independent model: written from the spec's formulas, not from the executor's code. */
function simulate(c: ResilienceCase, abortAt: number | undefined): Model {
  const events: number[] = [0]
  let tie = false
  let br: { status: "closed" | "open" | "half_open"; fails: number; openedAt: number } = { status: "closed", fails: 0, openedAt: 0 }
  const done = (result: Expected, attempts: number, slotLeaked: boolean): Model => ({ result, events, tie, attempts, slotLeaked, breaker: { status: br.status, fails: br.fails } })
  if (c.preAborted) return done({ kind: "abort", at: 0 }, 0, false)
  const backoff = effectiveBackoff(c)
  const maxAttempts = backoff?.maxAttempts ?? 1
  const started: { ws: number; s: number }[] = []
  const leaked = (): boolean => started.some((entry) => entry.ws === Infinity)
  let t = 0
  for (let attempt = 1; ; attempt++) {
    if (c.breaker && br.status === "open") {
      if (t - br.openedAt >= c.breaker.resetAfterMs) br = { ...br, status: "half_open" }
      else return done({ kind: "unavailable", at: t, why: "breaker" }, attempt - 1, leaked())
    }
    const step = c.steps[Math.min(attempt - 1, c.steps.length - 1)]!
    const dEnd = step.kind === "hang" ? Infinity : step.d
    const tOut = c.timeoutMs ?? Infinity
    const aRel = abortAt === undefined ? Infinity : abortAt - t
    if (Number.isFinite(dEnd) && dEnd === tOut) tie = true
    if (Number.isFinite(dEnd)) events.push(t + dEnd)
    if (Number.isFinite(tOut)) events.push(t + tOut)
    const interrupt = Math.min(tOut, aRel)
    if (dEnd === Infinity && interrupt === Infinity) {
      // A hung attempt that honours its signal is released by the late abort the driver issues afterwards.
      started.push({ ws: step.honors ? 0 : Infinity, s: Infinity })
      return done({ kind: "pending" }, attempt, leaked())
    }
    let s: number
    let error: Expected
    if (dEnd < interrupt) {
      s = t + dEnd
      started.push({ ws: s, s })
      if (step.kind === "ok") { br = { status: "closed", fails: 0, openedAt: 0 }; return done({ kind: "ok", attempt, at: s }, attempt, leaked()) }
      error = { kind: "work-error", attempt, at: s }
      br = failBreaker(br, c, s)
    } else if (aRel < tOut) {
      started.push({ ws: step.honors ? abortAt! : t + dEnd, s: abortAt! })
      return done({ kind: "abort", at: abortAt! }, attempt, leaked())
    } else {
      s = t + tOut
      started.push({ ws: step.honors ? s : t + dEnd, s })
      error = { kind: "timeout", at: s }
      br = failBreaker(br, c, s)
    }
    if (error.kind === "work-error" && step.err === "permanent") return done(error, attempt, leaked())
    if (attempt >= maxAttempts || !backoff) return done(error, attempt, leaked())
    const n = attempt
    const base = Math.min(MAX_BACKOFF_DELAY_MS, backoff.init * 2 ** (n - 1))
    const sample = c.rand[(n - 1) % c.rand.length]!
    const delay = Math.floor(base / 2 + (sample * base) / 2)
    const endDelay = s + delay
    if (delay > 0) events.push(endDelay)
    if (delay > 0 && abortAt !== undefined && abortAt < endDelay) return done({ kind: "abort", at: abortAt }, attempt, leaked())
    t = endDelay
    if (c.bulkhead) {
      for (const entry of started) if (entry.ws === t && entry.ws > entry.s) tie = true
      if (started.some((entry) => entry.ws > t)) return done({ kind: "unavailable", at: t, why: "outstanding" }, attempt, leaked())
    }
  }
}

function failBreaker(br: { status: "closed" | "open" | "half_open"; fails: number; openedAt: number }, c: ResilienceCase, at: number): typeof br {
  if (!c.breaker) return br
  if (br.status === "half_open") return { status: "open", fails: br.fails + 1, openedAt: at }
  const fails = br.fails + 1
  return fails >= c.breaker.failureThreshold ? { status: "open", fails, openedAt: at } : { ...br, fails }
}

function makeError(kind: ErrKind): unknown {
  switch (kind) {
    case "retryable": return new UnavailableError("flaky")
    case "permanent": return new ForbiddenError("nope")
    case "plain": return new Error("plain")
    case "string": return "a thrown string"
    case "undefined": return undefined
  }
}

function makeReason(kind: ReasonKind): unknown {
  switch (kind) {
    case "default": return new DOMException("This operation was aborted", "AbortError")
    case "string": return "stop"
    case "error": return new Error("stop")
    case "domTimeout": return new DOMException("signal timed out", "TimeoutError")
    case "cancelled": return new CancelledError("by dispatcher")
    case "frameworkTimeout": return new TimeoutError("deadline")
    case "null": return null
  }
}

interface Observed { outcome: { kind: "ok"; value: unknown; at: number } | { kind: "throw"; error: unknown; at: number } | undefined; calls: number; errors: unknown[]; reason: unknown; values: unknown[] }

async function execute(c: ResilienceCase, abortAt: number | undefined, model: Model): Promise<void> {
  vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "Date"] })
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on("unhandledRejection", onUnhandled)
  try {
    const signal = new FakeSignal()
    const reason = makeReason(c.reason)
    if (c.preAborted) signal.abort(reason)
    const errors: unknown[] = []
    const values: unknown[] = []
    let calls = 0
    let pendingWorkTimers = 0
    const work = (attemptSignal: AbortSignal): Promise<unknown> => {
      const index = calls++
      const step = c.steps[Math.min(index, c.steps.length - 1)]!
      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let settled = false
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) { clearTimeout(timer); pendingWorkTimers--; timer = undefined }
          fn()
        }
        if (step.kind !== "hang") {
          pendingWorkTimers++
          timer = setTimeout(() => {
            timer = undefined; pendingWorkTimers--
            finish(() => {
              if (step.kind === "ok") { const value = { attempt: index + 1 }; values[index] = value; resolve(value) }
              else { const error = makeError(step.err); errors[index] = error; reject(error) }
            })
          }, step.d)
        }
        if (step.honors) attemptSignal.addEventListener("abort", () => finish(() => reject(attemptSignal.reason)), { once: true })
      })
    }
    const semantics: ExternalCallSemantics = c.semantics === "read" ? { kind: "read" } : c.semantics === "idempotent" ? { kind: "idempotent-mutation", idempotencyKey: "k" } : { kind: "non-idempotent-mutation" }
    const policy: ResiliencePolicy = {
      ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}),
      ...(c.retry ? { retry: { maxAttempts: c.retry.maxAttempts, ...(c.retry.backoffMs !== undefined ? { backoffMs: c.retry.backoffMs } : {}) } } : {}),
      ...(c.breaker ? { circuitBreaker: c.breaker } : {}),
      ...(c.bulkhead ? { bulkhead: { maxConcurrent: 1 } } : {}),
    }
    const bulkhead: Bulkhead | undefined = c.bulkhead ? createBulkhead(1, 0) : undefined
    const breaker: CircuitBreaker | undefined = c.breaker ? createCircuitBreaker(c.breaker, () => Date.now()) : undefined
    let randomCalls = 0
    const random = (): number => c.rand[randomCalls++ % c.rand.length]!
    let outcome: Observed["outcome"]
    const call = withResilience(policy, semantics, work, { signal: signal.asSignal(), random, ...(bulkhead ? { bulkhead } : {}), ...(breaker ? { breaker } : {}) }).then(
      (value) => { outcome = { kind: "ok", value, at: Date.now() } },
      (error: unknown) => { outcome = { kind: "throw", error, at: Date.now() } },
    )
    void call
    const abortTimer = abortAt !== undefined && !c.preAborted ? setTimeout(() => signal.abort(reason), abortAt) : undefined
    await vi.advanceTimersByTimeAsync(0)
    for (let guard = 0; guard < 5_000 && outcome === undefined && vi.getTimerCount() > 0; guard++) await vi.advanceTimersToNextTimerAsync()
    await vi.advanceTimersByTimeAsync(0)

    if (model.result.kind === "pending") {
      expect(outcome, "model says the call never settles").toBeUndefined()
      expect(model.tie).toBe(false)
    } else {
      expect(outcome, `expected ${JSON.stringify(model.result)} but the call never settled`).toBeDefined()
    }
    const settled = outcome
    if (settled !== undefined && model.result.kind !== "pending") {
      const expected = model.result
      expect(settled.at, `settle time of ${expected.kind}`).toBe(expected.at)
      switch (expected.kind) {
        case "ok":
          expect(settled.kind).toBe("ok")
          expect((settled as { value: unknown }).value).toBe(values[expected.attempt - 1])
          break
        case "work-error":
          expect(settled.kind).toBe("throw")
          expect((settled as { error: unknown }).error).toBe(errors[expected.attempt - 1])
          break
        case "timeout": {
          expect(settled.kind).toBe("throw")
          const error = (settled as { error: unknown }).error
          expect(error).toBeInstanceOf(TimeoutError)
          break
        }
        case "unavailable": {
          expect(settled.kind).toBe("throw")
          expect((settled as { error: unknown }).error).toBeInstanceOf(UnavailableError)
          break
        }
        case "abort": {
          expect(settled.kind).toBe("throw")
          const error = (settled as { error: unknown }).error
          if (c.reason === "cancelled" || c.reason === "frameworkTimeout") expect(error).toBe(reason)
          else if (c.reason === "domTimeout") { expect(error).toBeInstanceOf(TimeoutError); expect((error as Error).cause).toBe(reason) }
          else { expect(error).toBeInstanceOf(CancelledError); expect((error as Error).cause).toBe(reason) }
          break
        }
      }
    }
    expect(calls, "number of work invocations").toBe(model.attempts)
    if (breaker && settled !== undefined) expect({ status: breaker.state.status, fails: breaker.state.consecutiveFailures }, "breaker state after the call").toEqual(model.breaker)
    // Whatever happened, the executor must own no live abort listener or timer once the call has settled.
    if (settled !== undefined) {
      if (abortTimer !== undefined) clearTimeout(abortTimer)
      expect(signal.liveListeners, "live abort listeners after settle").toBe(0)
      expect(vi.getTimerCount(), "executor timers after settle (only the work's own timers may remain)").toBe(pendingWorkTimers)
    }
    await vi.runAllTimersAsync()
    if (settled === undefined) {
      // A call that can never settle on its own must still be cancellable, and cancelling it must release everything.
      expect(signal.liveListeners, "a pending call holds exactly its own listeners").toBeGreaterThan(0)
      signal.abort(reason)
      await vi.runAllTimersAsync()
      expect(outcome, "a late abort must settle a hung call").toBeDefined()
    }
    expect(signal.liveListeners, "live abort listeners after drain").toBe(0)
    if (bulkhead) {
      expect(bulkhead.queued).toBe(0)
      expect(bulkhead.active, "bulkhead slot after all work settled").toBe(model.slotLeaked ? 1 : 0)
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(unhandled, "unhandled rejections").toEqual([])
  } finally {
    process.off("unhandledRejection", onUnhandled)
    vi.useRealTimers()
  }
}

function generateStep(rng: Rng, maxD: number): Step {
  const kind = rng.pick(["ok", "ok", "fail", "fail", "fail", "hang"] as const)
  return { kind, d: 1 + rng.int(maxD), err: rng.pick(["retryable", "retryable", "plain", "string", "undefined", "permanent"] as const), honors: rng.bool(0.5) }
}

function generateCase(rng: Rng): ResilienceCase {
  const semantics = rng.pick(["read", "read", "idempotent", "non-idempotent"] as const)
  const maxD = rng.pick([50, 3000])
  const steps = Array.from({ length: 1 + rng.int(6) }, () => generateStep(rng, maxD))
  const timeoutMs = rng.bool(0.6) ? 1 + rng.int(maxD) : undefined
  const retry = semantics === "non-idempotent"
    ? (rng.bool(0.5) ? { maxAttempts: 1, backoffMs: undefined } : undefined)
    : rng.bool(0.85) ? { maxAttempts: rng.bool(0.1) ? 1 + rng.int(MAX_BACKOFF_ATTEMPTS) : 1 + rng.int(6), backoffMs: rng.bool(0.6) ? rng.pick([1, 2, 3, 10, 500, 2000]) : undefined } : undefined
  const preAborted = rng.bool(0.08)
  const base: ResilienceCase = {
    steps, timeoutMs, retry, semantics,
    breaker: rng.bool(0.35) ? { failureThreshold: 1 + rng.int(3), resetAfterMs: rng.pick([1, 100, 5_000, 100_000]) } : undefined,
    bulkhead: rng.bool(0.4),
    rand: Array.from({ length: 1 + rng.int(4) }, () => rng.pick([0, 0.25, 0.5, 0.75, 0.999999])),
    preAborted,
    reason: rng.pick(["default", "string", "error", "domTimeout", "cancelled", "frameworkTimeout", "null"] as const),
    abortAt: undefined,
  }
  if (preAborted || rng.bool(0.3)) return base
  // Pick an abort instant that never coincides with another timer event, so ordering ties cannot make the model ambiguous.
  const events = new Set(simulate(base, undefined).events)
  const horizon = Math.max(...events) + 20
  let at = rng.bool(0.5) ? 1 + rng.int(horizon) : rng.pick([...events]) + rng.pick([-1, 1, 2])
  if (at < 1) at = 1
  while (events.has(at)) at++
  // Timers beyond 2^31-1 ms fire immediately (in Node and in the fake clock), so the harness's own abort timer must stay below that.
  if (at > 2_000_000_000) return base
  return { ...base, abortAt: at }
}

function* shrinkCase(c: ResilienceCase): Generator<ResilienceCase> {
  if (c.abortAt !== undefined) yield { ...c, abortAt: undefined }
  if (c.breaker) yield { ...c, breaker: undefined }
  if (c.bulkhead) yield { ...c, bulkhead: false }
  if (c.timeoutMs !== undefined) yield { ...c, timeoutMs: undefined }
  if (c.steps.length > 1) for (let i = 0; i < c.steps.length; i++) yield { ...c, steps: c.steps.filter((_, j) => j !== i) }
  if (c.retry && c.retry.maxAttempts > 1) yield { ...c, retry: { ...c.retry, maxAttempts: c.retry.maxAttempts - 1 } }
  if (c.rand.length > 1) yield { ...c, rand: [c.rand[0]!] }
  for (let i = 0; i < c.steps.length; i++) if (c.steps[i]!.honors) yield { ...c, steps: c.steps.map((s, j) => (j === i ? { ...s, honors: false } : s)) }
}

const describeCase = (c: ResilienceCase): string => JSON.stringify(c, (_k, v: unknown) => (v === Infinity ? "Infinity" : v))

describe("resilience executor ≡ discrete-event model", () => {
  it("attempt counts, outcomes, settle times, listener/timer/slot release and no unhandled rejections", async () => {
    await forAllAsync("resilience executor matches the event model", generateCase, async (c) => {
      const model = simulate(c, c.abortAt)
      if (model.tie) return
      await execute(c, c.abortAt, model)
    }, { runs: 250, shrink: shrinkCase, describe: describeCase })
  })

  it("an abort at any instant before completion rejects exactly at that instant", async () => {
    await forAllAsync("abort wins promptly at its own instant", (rng) => {
      const c = generateCase(rng)
      return { ...c, preAborted: false, abortAt: c.abortAt ?? 1 + rng.int(5_000) }
    }, async (c) => {
      const free = simulate({ ...c, abortAt: undefined }, undefined)
      const model = simulate(c, c.abortAt)
      if (model.tie) return
      // Completion strictly after the abort instant (or never) means the abort must win.
      const completesAt = free.result.kind === "pending" ? Infinity : free.result.at
      if (!(c.abortAt! < completesAt)) return
      await execute(c, c.abortAt, model)
    }, { runs: 120, shrink: shrinkCase, describe: describeCase })
  })
})

interface ConcurrentCase {
  maxConcurrent: number
  maxQueue: number
  breaker: { failureThreshold: number; resetAfterMs: number } | undefined
  calls: Array<{ startAt: number; steps: Step[]; timeoutMs: number | undefined; attempts: number; abortAt: number | undefined; reason: ReasonKind }>
}

function generateConcurrent(rng: Rng): ConcurrentCase {
  return {
    maxConcurrent: 1 + rng.int(3),
    maxQueue: rng.int(4),
    breaker: rng.bool(0.4) ? { failureThreshold: 1 + rng.int(3), resetAfterMs: rng.pick([1, 50, 1000]) } : undefined,
    calls: Array.from({ length: 2 + rng.int(6) }, () => {
      const timeoutMs = rng.bool(0.7) ? 1 + rng.int(300) : undefined
      return {
        startAt: rng.int(200),
        // A hung attempt always honours its signal here, so every call can be wound down by the final abort.
        steps: Array.from({ length: 1 + rng.int(4) }, () => { const step = generateStep(rng, 300); return step.kind === "hang" ? { ...step, honors: true } : step }),
        timeoutMs,
        attempts: 1 + rng.int(4),
        abortAt: rng.bool(0.3) ? rng.int(600) : undefined,
        reason: rng.pick(["default", "string", "cancelled", "domTimeout"] as const),
      }
    }),
  }
}

describe("resilience executor under concurrency", () => {
  it("never exceeds maxConcurrent in flight (timed-out work included), never queues past maxQueue, and releases every slot, timer and listener", async () => {
    await forAllAsync("resilience concurrent bulkhead and breaker", generateConcurrent, async (c) => {
      vi.useFakeTimers({ now: 0, toFake: ["setTimeout", "clearTimeout", "Date"] })
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
      process.on("unhandledRejection", onUnhandled)
      try {
        const bulkhead = createBulkhead(c.maxConcurrent, c.maxQueue)
        const breaker = c.breaker ? createCircuitBreaker(c.breaker, () => Date.now()) : undefined
        let inFlight = 0
        let peak = 0
        const signals = c.calls.map(() => new FakeSignal())
        const settledCalls: Array<{ ok: boolean } | undefined> = c.calls.map(() => undefined)
        c.calls.forEach((call, index) => {
          setTimeout(() => {
            let attemptIndex = 0
            const work = (attemptSignal: AbortSignal): Promise<number> => {
              const step = call.steps[Math.min(attemptIndex++, call.steps.length - 1)]!
              inFlight++
              peak = Math.max(peak, inFlight)
              return new Promise<number>((resolve, reject) => {
                let done = false
                const finish = (fn: () => void): void => { if (done) return; done = true; inFlight--; fn() }
                if (step.kind !== "hang") setTimeout(() => finish(() => (step.kind === "ok" ? resolve(1) : reject(makeError(step.err)))), step.d)
                if (step.honors) attemptSignal.addEventListener("abort", () => finish(() => reject(attemptSignal.reason)), { once: true })
              })
            }
            const policy: ResiliencePolicy = { retry: { maxAttempts: call.attempts, backoffMs: 20 }, bulkhead: { maxConcurrent: c.maxConcurrent, maxQueue: c.maxQueue }, ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}), ...(c.breaker ? { circuitBreaker: c.breaker } : {}) }
            void withResilience(policy, { kind: "read" }, work, { bulkhead, signal: signals[index]!.asSignal(), random: () => 0.5, ...(breaker ? { breaker } : {}) })
              .then(() => { settledCalls[index] = { ok: true } }, () => { settledCalls[index] = { ok: false } })
            expect(bulkhead.active, "active never exceeds capacity").toBeLessThanOrEqual(c.maxConcurrent)
            expect(bulkhead.queued, "queue never exceeds capacity").toBeLessThanOrEqual(c.maxQueue)
          }, call.startAt)
          if (call.abortAt !== undefined) setTimeout(() => signals[index]!.abort(makeReason(call.reason)), call.abortAt)
        })
        for (let guard = 0; guard < 20_000 && vi.getTimerCount() > 0; guard++) {
          await vi.advanceTimersToNextTimerAsync()
          expect(peak, "work in flight (including timed-out work still running) exceeded maxConcurrent").toBeLessThanOrEqual(c.maxConcurrent)
          expect(bulkhead.active).toBeLessThanOrEqual(c.maxConcurrent)
          expect(bulkhead.queued).toBeLessThanOrEqual(c.maxQueue)
        }
        // Wind everything down: abort whatever is still pending.
        signals.forEach((signal) => signal.abort(makeReason("default")))
        await vi.runAllTimersAsync()
        expect(settledCalls.every((entry) => entry !== undefined), "every call settles once all signals are aborted").toBe(true)
        expect(bulkhead.active).toBe(0)
        expect(bulkhead.queued).toBe(0)
        expect(inFlight).toBe(0)
        expect(signals.map((signal) => signal.liveListeners)).toEqual(signals.map(() => 0))
        expect(vi.getTimerCount()).toBe(0)
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(unhandled).toEqual([])
      } finally {
        process.off("unhandledRejection", onUnhandled)
        vi.useRealTimers()
      }
    }, { runs: 150, describe: (c) => JSON.stringify(c) })
  })
})

describe("backoff arithmetic", () => {
  it("delay stays in [base/2, base] with equal jitter, is monotone in the attempt number and never exceeds maxDelayMs", () => {
    forAll("backoff delay bounds", (rng) => ({
      initialDelayMs: rng.pick([0, 1, 2, 7, 100, 1000, 86_400_000]),
      backoffMultiplier: rng.pick([1, 1.5, 2, 3, 10, 2.718281828]),
      extra: rng.pick([0, 1, 5, 1_000, 100_000, MAX_BACKOFF_DELAY_MS]),
      jitter: rng.pick(["none", "equal"] as const),
      attempts: Array.from({ length: 6 }, () => 1 + rng.int(rng.bool(0.3) ? 100 : 8)),
      samples: Array.from({ length: 6 }, () => rng.pick([0, 0.1, 0.5, 0.999999])),
    }), (c) => {
      const maxDelayMs = Math.min(MAX_BACKOFF_DELAY_MS, c.initialDelayMs + c.extra)
      const policy: BackoffPolicy = validateBackoffPolicy({ maxAttempts: 100, initialDelayMs: c.initialDelayMs, backoffMultiplier: c.backoffMultiplier, maxDelayMs, jitter: c.jitter })
      c.attempts.forEach((n, i) => {
        const base = Math.min(maxDelayMs, c.initialDelayMs * c.backoffMultiplier ** (n - 1))
        const delay = computeBackoffDelayMs(policy, n, () => c.samples[i]!)
        expect(Number.isSafeInteger(delay) && delay >= 0 && delay <= maxDelayMs, `delay ${delay} for attempt ${n}`).toBe(true)
        if (c.jitter === "none") expect(delay).toBe(Math.floor(base))
        else {
          expect(delay).toBeGreaterThanOrEqual(Math.floor(base / 2))
          expect(delay).toBeLessThanOrEqual(Math.floor(base))
          expect(delay).toBe(Math.floor(base / 2 + (c.samples[i]! * base) / 2))
        }
      })
      // Without jitter the schedule is non-decreasing.
      let previous = -1
      for (let n = 1; n <= 100; n++) {
        const delay = computeBackoffDelayMs({ ...policy, jitter: "none" }, n)
        expect(delay).toBeGreaterThanOrEqual(previous)
        previous = delay
      }
    }, { runs: 150, describe: (c) => JSON.stringify(c) })
  })

  it("an out-of-contract random() sample falls back to a value inside the jitter band", () => {
    forAll("backoff survives bad random", (rng) => ({ sample: rng.pick([NaN, Infinity, -1, 1, 2, -0.0001] as const), init: 1 + rng.int(5000), n: 1 + rng.int(10) }), (c) => {
      const policy = validateBackoffPolicy({ maxAttempts: 100, initialDelayMs: c.init, backoffMultiplier: 2, maxDelayMs: MAX_BACKOFF_DELAY_MS, jitter: "equal" })
      const base = Math.min(MAX_BACKOFF_DELAY_MS, c.init * 2 ** (c.n - 1))
      const delay = computeBackoffDelayMs(policy, c.n, () => c.sample)
      expect(delay).toBeGreaterThanOrEqual(Math.floor(base / 2))
      expect(delay).toBeLessThanOrEqual(Math.floor(base))
    }, { runs: 60, describe: (c) => JSON.stringify(c) })
  })
})

// ------------------------------------------------------------ policy validation oracle

interface PolicyDraft { policy: Record<string, unknown>; semantics: Record<string, unknown> }

function oracleValid(d: PolicyDraft): boolean {
  const p = d.policy as { timeoutMs?: unknown; retry?: { maxAttempts?: unknown; backoffMs?: unknown }; circuitBreaker?: { failureThreshold?: unknown; resetAfterMs?: unknown }; bulkhead?: { maxConcurrent?: unknown; maxQueue?: unknown } }
  const posInt = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v > 0
  if (d.semantics.kind !== "read" && d.semantics.kind !== "idempotent-mutation" && d.semantics.kind !== "non-idempotent-mutation") return false
  if (p.timeoutMs !== undefined && !(posInt(p.timeoutMs) && (p.timeoutMs as number) <= MAX_BACKOFF_DELAY_MS)) return false
  if (p.retry !== undefined) {
    if (!posInt(p.retry.maxAttempts) || (p.retry.maxAttempts as number) > MAX_BACKOFF_ATTEMPTS) return false
    if (p.retry.backoffMs !== undefined && !posInt(p.retry.backoffMs)) return false
  }
  if (p.circuitBreaker !== undefined && !(posInt(p.circuitBreaker.failureThreshold) && posInt(p.circuitBreaker.resetAfterMs))) return false
  if (p.bulkhead !== undefined) {
    if (!posInt(p.bulkhead.maxConcurrent)) return false
    if (p.bulkhead.maxQueue !== undefined && !(typeof p.bulkhead.maxQueue === "number" && Number.isSafeInteger(p.bulkhead.maxQueue) && p.bulkhead.maxQueue >= 0)) return false
  }
  if (d.semantics.kind === "idempotent-mutation" && !(typeof d.semantics.idempotencyKey === "string" && d.semantics.idempotencyKey.trim().length > 0)) return false
  if (d.semantics.kind === "non-idempotent-mutation" && ((p.retry?.maxAttempts as number | undefined) ?? 1) > 1) return false
  return true
}

function generatePolicyDraft(rng: Rng): PolicyDraft {
  const num = (): unknown => rng.pick([1, 2, 3, 100, 101, 0, -1, 1.5, NaN, Infinity, MAX_BACKOFF_DELAY_MS, MAX_BACKOFF_DELAY_MS + 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "3"])
  const maybe = (make: () => unknown): { v?: unknown } => (rng.bool(0.5) ? {} : { v: make() })
  const policy: Record<string, unknown> = {}
  const t = maybe(num); if ("v" in t) policy.timeoutMs = t.v
  if (rng.bool(0.6)) { const retry: Record<string, unknown> = {}; if (rng.bool(0.9)) retry.maxAttempts = num(); const b = maybe(num); if ("v" in b) retry.backoffMs = b.v; policy.retry = retry }
  if (rng.bool(0.4)) { const cb: Record<string, unknown> = {}; if (rng.bool(0.9)) cb.failureThreshold = num(); if (rng.bool(0.9)) cb.resetAfterMs = num(); policy.circuitBreaker = cb }
  if (rng.bool(0.4)) { const bh: Record<string, unknown> = {}; if (rng.bool(0.9)) bh.maxConcurrent = num(); const q = maybe(num); if ("v" in q) bh.maxQueue = q.v; policy.bulkhead = bh }
  const kind = rng.pick(["read", "idempotent-mutation", "non-idempotent-mutation", "read", "bogus"] as const)
  const semantics: Record<string, unknown> = { kind }
  if (kind === "idempotent-mutation") semantics.idempotencyKey = rng.pick(["k", "", "   ", 5, undefined])
  return { policy, semantics }
}

describe("resilience policy validation", () => {
  it("validateResiliencePolicy and withResilience agree with an independent validity oracle", async () => {
    await forAllAsync("resilience policy validity", generatePolicyDraft, async (d) => {
      const valid = oracleValid(d)
      let threw: unknown
      try { validateResiliencePolicy(d.policy as ResiliencePolicy, d.semantics as unknown as ExternalCallSemantics) } catch (error) { threw = error }
      if (valid) expect(threw, "valid policy was rejected").toBeUndefined()
      else expect(threw, "invalid policy was accepted").toBeInstanceOf(ConfigurationError)
      // The executor must reject an invalid policy before doing any work.
      let calls = 0
      const needsBreaker = (d.policy as { circuitBreaker?: unknown }).circuitBreaker !== undefined
      const needsBulkhead = (d.policy as { bulkhead?: unknown }).bulkhead !== undefined
      const runtime = {
        ...(needsBreaker && valid ? { breaker: createCircuitBreaker({ failureThreshold: 1, resetAfterMs: 1 }) } : {}),
        ...(needsBulkhead && valid ? { bulkhead: createBulkhead(1, 0) } : {}),
      }
      const outcome = await withResilience(d.policy as ResiliencePolicy, d.semantics as unknown as ExternalCallSemantics, async () => { calls++; return "ok" }, runtime).then(() => "ok", (error: unknown) => error)
      if (valid) { expect(outcome).toBe("ok"); expect(calls).toBe(1) }
      else { expect(outcome).toBeInstanceOf(ConfigurationError); expect(calls).toBe(0) }
    }, { runs: 400, describe: (d) => JSON.stringify(d, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)) })
  })

  it("validateBackoffPolicy accepts exactly the documented bounds", () => {
    forAll("backoff policy validity", (rng) => {
      const pick = (good: unknown[], bad: unknown[]): unknown => (rng.bool(0.25) ? rng.pick(bad) : rng.pick(good))
      const initialDelayMs = pick([0, 1, 100, MAX_BACKOFF_DELAY_MS], [-1, 1.5, NaN, MAX_BACKOFF_DELAY_MS + 1, "5", null, undefined])
      return {
        maxAttempts: pick([1, 3, MAX_BACKOFF_ATTEMPTS], [0, -1, 1.5, MAX_BACKOFF_ATTEMPTS + 1, NaN, "3", undefined]),
        initialDelayMs,
        backoffMultiplier: pick([1, 1.5, 2, 10], [0.99, 0, -1, 10.01, NaN, Infinity, "2", undefined]),
        maxDelayMs: pick([0, 1, 100, 1000, MAX_BACKOFF_DELAY_MS], [-1, 1.5, NaN, MAX_BACKOFF_DELAY_MS + 1, undefined, "9"]),
        jitter: pick(["none", "equal"], ["full", "", null, undefined]),
      }
    }, (draft) => {
      const int = (v: unknown, lo: number, hi: number): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi
      const valid = int(draft.maxAttempts, 1, MAX_BACKOFF_ATTEMPTS) && int(draft.initialDelayMs, 0, MAX_BACKOFF_DELAY_MS)
        && int(draft.maxDelayMs, typeof draft.initialDelayMs === "number" ? draft.initialDelayMs : 0, MAX_BACKOFF_DELAY_MS) && typeof draft.initialDelayMs === "number"
        && typeof draft.backoffMultiplier === "number" && draft.backoffMultiplier >= 1 && draft.backoffMultiplier <= 10 && (draft.jitter === "none" || draft.jitter === "equal")
      let thrown: unknown
      try { validateBackoffPolicy(draft as unknown as BackoffPolicy) } catch (error) { thrown = error }
      if (valid) expect(thrown).toBeUndefined()
      else expect(thrown).toBeInstanceOf(ConfigurationError)
    }, { runs: 300, describe: (d) => JSON.stringify(d, (_k, v: unknown) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v === undefined ? "<undefined>" : v)) })
  })

  it("validateResiliencePolicy returns a frozen snapshot that retained input mutation cannot change", () => {
    forAll("resilience policy snapshot", (rng) => ({ timeoutMs: 1 + rng.int(1000), attempts: 1 + rng.int(5), threshold: 1 + rng.int(5), concurrent: 1 + rng.int(5) }), (c) => {
      const input = { timeoutMs: c.timeoutMs, retry: { maxAttempts: c.attempts }, circuitBreaker: { failureThreshold: c.threshold, resetAfterMs: 5 }, bulkhead: { maxConcurrent: c.concurrent } }
      const out = validateResiliencePolicy(input, { kind: "read" })
      input.retry.maxAttempts = 99; input.circuitBreaker.failureThreshold = 99; input.bulkhead.maxConcurrent = 99; input.timeoutMs = 99
      expect(out.retry?.maxAttempts).toBe(c.attempts)
      expect(out.circuitBreaker?.failureThreshold).toBe(c.threshold)
      expect(out.bulkhead?.maxConcurrent).toBe(c.concurrent)
      expect(out.timeoutMs).toBe(c.timeoutMs)
      expect([Object.isFrozen(out), Object.isFrozen(out.retry), Object.isFrozen(out.circuitBreaker), Object.isFrozen(out.bulkhead)]).toEqual([true, true, true, true])
    }, { runs: 60 })
  })
})

// ------------------------------------------------------------ circuit breaker

type BreakerOp =
  | { op: "advance"; ms: number }
  | { op: "admit" }
  | { op: "complete"; which: number; outcome: "success" | "failure" | "cancelled" }

describe("circuit breaker ≡ reference state machine", () => {
  it("admission, generations and stale completions match a brute-force model", () => {
    forAll("circuit breaker model", (rng) => ({
      threshold: 1 + rng.int(3),
      reset: rng.pick([1, 5, 50]),
      ops: Array.from({ length: 5 + rng.int(40) }, (): BreakerOp => rng.pick<BreakerOp>([
        { op: "advance", ms: rng.pick([0, 1, 4, 5, 6, 49, 50, 51]) },
        { op: "admit" }, { op: "admit" },
        { op: "complete", which: rng.int(8), outcome: rng.pick(["success", "failure", "failure", "cancelled"] as const) },
        { op: "complete", which: rng.int(8), outcome: rng.pick(["success", "failure", "failure", "cancelled"] as const) },
      ])),
    }), (c) => {
      let now = 0
      const breaker = createCircuitBreaker({ failureThreshold: c.threshold, resetAfterMs: c.reset }, () => now)
      // Model: status plus, per admission, the epoch it was admitted in. An epoch changes on every status transition.
      let status: "closed" | "open" | "half_open" = "closed"
      let fails = 0
      let openedAt = 0
      let trial = false
      let epoch = 0
      const admitted: { complete: (o: "success" | "failure" | "cancelled") => void; epoch: number; done: boolean }[] = []
      for (const op of c.ops) {
        if (op.op === "advance") now += op.ms
        else if (op.op === "admit") {
          let expectOpen = false
          if (status === "open") { if (now - openedAt >= c.reset) { status = "half_open"; trial = true; epoch++ } else expectOpen = true }
          else if (status === "half_open") { if (trial) expectOpen = true; else trial = true }
          if (expectOpen) expect(() => breaker.admit()).toThrow(UnavailableError)
          else admitted.push({ complete: breaker.admit(), epoch, done: false })
        } else if (admitted.length > 0) {
          const entry = admitted[op.which % admitted.length]!
          entry.complete(op.outcome)
          if (entry.done) { /* second completion is ignored */ } else {
            entry.done = true
            if (entry.epoch === epoch) {
              if (op.outcome === "success") { if (status !== "closed") epoch++; status = "closed"; fails = 0; trial = false }
              else if (op.outcome === "failure") {
                if (status === "half_open") { status = "open"; fails++; openedAt = now; trial = false; epoch++ }
                else if (fails + 1 >= c.threshold) { status = "open"; fails++; openedAt = now; trial = false; epoch++ }
                else fails++
              } else if (status === "half_open") trial = false
            }
          }
        }
        expect({ status: breaker.state.status, fails: breaker.state.consecutiveFailures, trial: breaker.state.trialInFlight }, JSON.stringify(op)).toEqual({ status, fails, trial })
      }
    }, { runs: 300, describe: (c) => JSON.stringify(c) })
  })
})

// ------------------------------------------------------------ bulkhead

describe("bulkhead ≡ FIFO slot model", () => {
  it("active/queued counts, FIFO hand-off, rejection and abort-while-queued match the model", async () => {
    await forAllAsync("bulkhead model", (rng) => ({
      maxConcurrent: 1 + rng.int(3),
      maxQueue: rng.int(4),
      ops: Array.from({ length: 4 + rng.int(30) }, () => ({ op: rng.pick(["acquire", "acquire", "acquireSignal", "release", "abort"] as const), which: rng.int(10) })),
    }), async (c) => {
      const bulkhead = createBulkhead(c.maxConcurrent, c.maxQueue)
      let active = 0
      const queue: number[] = []
      const holders = new Map<number, () => void>()
      const states = new Map<number, "granted" | "queued" | "rejected" | "aborted">()
      const controllers = new Map<number, AbortController>()
      const outcomes = new Map<number, Promise<void>>()
      let id = 0
      for (const op of c.ops) {
        if (op.op === "acquire" || op.op === "acquireSignal") {
          const me = id++
          const controller = op.op === "acquireSignal" ? new AbortController() : undefined
          if (controller) controllers.set(me, controller)
          if (active < c.maxConcurrent) { active++; states.set(me, "granted") }
          else if (queue.length >= c.maxQueue) states.set(me, "rejected")
          else { queue.push(me); states.set(me, "queued") }
          const promise = bulkhead.acquire(controller?.signal)
          outcomes.set(me, promise.then((release) => { holders.set(me, release) }, () => undefined))
        } else if (op.op === "release") {
          await Promise.resolve()
          const granted = [...holders.keys()].filter((key) => states.get(key) === "granted")
          if (granted.length > 0) {
            const key = granted[op.which % granted.length]!
            holders.get(key)!()
            holders.delete(key)
            states.set(key, "rejected") // consumed
            const next = queue.shift()
            if (next !== undefined) states.set(next, "granted")
            else active--
          }
        } else {
          const queued = queue.filter((key) => controllers.has(key))
          if (queued.length > 0) {
            const key = queued[op.which % queued.length]!
            controllers.get(key)!.abort()
            queue.splice(queue.indexOf(key), 1)
            states.set(key, "aborted")
          }
        }
        await Promise.resolve()
        await Promise.resolve()
        expect({ active: bulkhead.active, queued: bulkhead.queued }, JSON.stringify(op)).toEqual({ active, queued: queue.length })
        expect(bulkhead.active).toBeLessThanOrEqual(c.maxConcurrent)
        // Every promise that has been granted must have delivered a release function.
        for (const [key, state] of states) if (state === "granted" && !holders.has(key)) { await outcomes.get(key); expect(holders.has(key)).toBe(true) }
      }
    }, { runs: 200, describe: (c) => JSON.stringify(c) })
  })
})

