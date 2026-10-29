import { afterEach, describe, expect, it, vi } from "vitest"
import { CancelledError, ConfigurationError, TimeoutError, UnavailableError } from "../../domain/errors"
import { MAX_BACKOFF_DELAY_MS, validateBackoffPolicy, computeBackoffDelayMs, type BackoffPolicy } from "../backoff"
import {
  admitCircuit,
  CLOSED_CIRCUIT,
  createBulkhead,
  createCircuitBreaker,
  recordCircuitFailure,
  recordCircuitSuccess,
  releaseCircuitAdmission,
  withResilience,
  type CircuitBreakerState,
} from "../executor"

const policy = { failureThreshold: 2, resetAfterMs: 100 }
const state = (patch: Partial<CircuitBreakerState>): CircuitBreakerState => ({ ...CLOSED_CIRCUIT, ...patch })
const message = (thunk: () => unknown): string => {
  try {
    thunk()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("expected throw")
}

describe("circuit state machine exact transitions", () => {
  it("does not reopen an open circuit without openedAt, and reopens exactly at resetAfterMs", () => {
    const noStamp = state({ status: "open", openedAt: null, generation: 3 })
    expect(admitCircuit(noStamp, policy, 1_000_000)).toEqual({ allowed: false, state: noStamp })
    const open = state({ status: "open", openedAt: 1_000, consecutiveFailures: 2, generation: 3 })
    expect(admitCircuit(open, policy, 1_099).allowed).toBe(false)
    const probe = admitCircuit(open, policy, 1_100)
    expect(probe.allowed).toBe(true)
    expect(probe.state).toEqual({ status: "half_open", consecutiveFailures: 2, openedAt: 1_000, trialInFlight: true, generation: 4 })
  })

  it("treats an invalid generation as 0 when advancing", () => {
    for (const generation of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 60]) {
      const probe = admitCircuit(state({ status: "open", openedAt: 0, generation }), policy, 500)
      expect(probe.state.generation).toBe(1)
    }
    expect(admitCircuit(state({ status: "open", openedAt: 0, generation: 0 }), policy, 500).state.generation).toBe(1)
    expect(admitCircuit(state({ status: "open", openedAt: 0, generation: 7 }), policy, 500).state.generation).toBe(8)
  })

  it("keeps the same state object for a clean closed success and resets a dirty closed state without a transition", () => {
    expect(recordCircuitSuccess(CLOSED_CIRCUIT)).toBe(CLOSED_CIRCUIT)
    const dirty = state({ consecutiveFailures: 1, generation: 5 })
    expect(recordCircuitSuccess(dirty)).toEqual({ status: "closed", consecutiveFailures: 0, openedAt: null, trialInFlight: false, generation: 5 })
    const odd = state({ openedAt: 7, generation: 5 })
    expect(recordCircuitSuccess(odd)).toEqual({ status: "closed", consecutiveFailures: 0, openedAt: null, trialInFlight: false, generation: 5 })
    const stuck = state({ trialInFlight: true, generation: 5 })
    expect(recordCircuitSuccess(stuck)).toEqual({ status: "closed", consecutiveFailures: 0, openedAt: null, trialInFlight: false, generation: 5 })
  })

  it("closes a half-open circuit on success with a new generation, ignoring stale results", () => {
    const half = state({ status: "half_open", trialInFlight: true, consecutiveFailures: 2, openedAt: 10, generation: 4 })
    expect(recordCircuitSuccess(half, 3)).toBe(half)
    expect(recordCircuitSuccess(half, 4)).toEqual({ status: "closed", consecutiveFailures: 0, openedAt: null, trialInFlight: false, generation: 5 })
  })

  it("re-opens a failed half-open probe and counts failures to the threshold exactly", () => {
    const half = state({ status: "half_open", trialInFlight: true, consecutiveFailures: 2, openedAt: 10, generation: 4 })
    expect(recordCircuitFailure(half, policy, 99, 3)).toBe(half)
    expect(recordCircuitFailure(half, policy, 99, 4)).toEqual({ status: "open", consecutiveFailures: 3, openedAt: 99, trialInFlight: false, generation: 5 })
    const one = recordCircuitFailure(CLOSED_CIRCUIT, policy, 50)
    expect(one).toEqual({ ...CLOSED_CIRCUIT, consecutiveFailures: 1 })
    expect(recordCircuitFailure(one, policy, 60)).toEqual({ status: "open", consecutiveFailures: 2, openedAt: 60, trialInFlight: false, generation: 1 })
  })

  it("releases only a current half-open probe", () => {
    const half = state({ status: "half_open", trialInFlight: true, generation: 2 })
    expect(releaseCircuitAdmission(half, 2)).toEqual({ ...half, trialInFlight: false })
    expect(releaseCircuitAdmission(half, 1)).toBe(half)
    expect(releaseCircuitAdmission(CLOSED_CIRCUIT, 0)).toBe(CLOSED_CIRCUIT)
    const open = state({ status: "open", openedAt: 1, trialInFlight: true })
    expect(releaseCircuitAdmission(open, 0)).toBe(open)
    const idle = state({ status: "half_open", trialInFlight: false, generation: 2 })
    expect(releaseCircuitAdmission(idle, 2)).toBe(idle)
  })

  it("the breaker rejects with the exact message and validates its policy", () => {
    let now = 0
    const breaker = createCircuitBreaker({ failureThreshold: 1, resetAfterMs: 50 }, () => now)
    breaker.admit()("failure")
    expect(message(() => breaker.admit())).toBe("Circuit breaker is open")
    expect(() => breaker.admit()).toThrow(UnavailableError)
    expect(message(() => createCircuitBreaker({ failureThreshold: 0, resetAfterMs: 1 }))).toBe("circuitBreaker.failureThreshold must be a positive safe integer")
    now = 50
    const done = breaker.admit()
    done("cancelled")
    done("success")
    expect(breaker.state.status).toBe("half_open")
    expect(breaker.state.trialInFlight).toBe(false)
  })
})

describe("bulkhead exact outcomes", () => {
  it("validates its arguments with the policy messages", () => {
    expect(message(() => createBulkhead(0))).toBe("bulkhead.maxConcurrent must be a positive safe integer")
    expect(message(() => createBulkhead(1, -1))).toBe("bulkhead.maxQueue must be a non-negative safe integer")
    expect(() => createBulkhead(1)).not.toThrow()
  })

  it("rejects beyond the queue with the exact message and hands slots to waiters in order", async () => {
    const bulkhead = createBulkhead(1, 1)
    const first = await bulkhead.acquire()
    const waiting = bulkhead.acquire()
    const error = await bulkhead.acquire().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnavailableError)
    expect((error as Error).message).toBe("Bulkhead capacity exhausted")
    expect(bulkhead.queued).toBe(1)
    first()
    const second = await waiting
    expect(bulkhead.active).toBe(1)
    expect(bulkhead.queued).toBe(0)
    second()
    expect(bulkhead.active).toBe(0)
  })

  it("removes only the aborted waiter and still serves the others", async () => {
    const bulkhead = createBulkhead(1, 2)
    const held = await bulkhead.acquire()
    const controller = new AbortController()
    const aborted = bulkhead.acquire(controller.signal)
    const kept = bulkhead.acquire()
    expect(bulkhead.queued).toBe(2)
    controller.abort(new Error("stop"))
    await expect(aborted).rejects.toBeInstanceOf(CancelledError)
    expect(bulkhead.queued).toBe(1)
    held()
    const release = await kept
    expect(bulkhead.active).toBe(1)
    release()
    expect(bulkhead.active).toBe(0)
  })
})

describe("withResilience exact outcomes", () => {
  afterEach(() => vi.useRealTimers())

  it("requires shared instances for breaker and bulkhead policies", async () => {
    const work = async (): Promise<number> => 1
    const breakerError = await withResilience({ circuitBreaker: policy }, { kind: "read" }, work).catch((caught: unknown) => caught)
    expect(breakerError).toBeInstanceOf(ConfigurationError)
    expect((breakerError as Error).message).toBe("A circuit breaker policy requires a shared breaker instance")
    const bulkheadError = await withResilience({ bulkhead: { maxConcurrent: 1 } }, { kind: "read" }, work).catch((caught: unknown) => caught)
    expect(bulkheadError).toBeInstanceOf(ConfigurationError)
    expect((bulkheadError as Error).message).toBe("A bulkhead policy requires a shared bulkhead instance")
  })

  it("times out with the exact message and passes the raw abort reason to the work signal", async () => {
    vi.useFakeTimers()
    let seen: AbortSignal | undefined
    const run = withResilience({ timeoutMs: 50 }, { kind: "read" }, (signal) => { seen = signal; return new Promise<never>(() => undefined) })
    const caught = run.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    const error = await caught
    expect(error).toBeInstanceOf(TimeoutError)
    expect((error as Error).message).toBe("External call timed out")
    expect(seen?.reason).toBe(error)
  })

  it("gives the work the caller's raw abort reason", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const reason = new Error("raw")
    const run = withResilience({}, { kind: "read" }, (signal) => { seen = signal; return new Promise<never>(() => undefined) }, { signal: controller.signal })
    controller.abort(reason)
    await expect(run).rejects.toBeInstanceOf(CancelledError)
    expect(seen?.reason).toBe(reason)
  })

  it("reports the outcome to the breaker: failure, then cancelled when the caller aborted", async () => {
    const outcomes: string[] = []
    const breaker = { state: CLOSED_CIRCUIT, admit: () => (outcome: "success" | "failure" | "cancelled") => { outcomes.push(outcome) } }
    await expect(withResilience({}, { kind: "read" }, async () => { throw new Error("down") }, { breaker })).rejects.toThrow("down")
    await expect(withResilience({}, { kind: "read" }, async () => 1, { breaker })).resolves.toBe(1)
    const controller = new AbortController()
    const run = withResilience({}, { kind: "read" }, (signal) => new Promise<never>((_r, reject) => signal.addEventListener("abort", () => reject(new Error("x")))), { breaker, signal: controller.signal })
    controller.abort()
    await expect(run).rejects.toBeInstanceOf(CancelledError)
    expect(outcomes).toEqual(["failure", "success", "cancelled"])
  })

  it("refuses to retry while a timed-out attempt still holds the bulkhead slot", async () => {
    vi.useFakeTimers()
    const bulkhead = createBulkhead(1)
    const run = withResilience({ timeoutMs: 10, retry: { maxAttempts: 3, backoffMs: 5 }, bulkhead: { maxConcurrent: 1 } }, { kind: "read" }, () => new Promise<never>(() => undefined), { bulkhead, random: () => 0 })
    const caught = run.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1_000)
    const error = await caught
    expect(error).toBeInstanceOf(UnavailableError)
    expect((error as Error).message).toBe("A timed-out attempt is still running; retrying would exceed the bulkhead")
    expect((error as UnavailableError).details).toBeInstanceOf(TimeoutError)
  })

  it("caps every retry delay at the shared maximum even for a huge backoff", async () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, "setTimeout")
    let calls = 0
    const run = withResilience({ retry: { maxAttempts: 4, backoffMs: MAX_BACKOFF_DELAY_MS } }, { kind: "read" }, async () => { if (++calls < 4) throw new UnavailableError("again"); return "ok" }, { random: () => 0.999 })
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_DELAY_MS * 4)
    await expect(run).resolves.toBe("ok")
    const delays = spy.mock.calls.map((call) => Number(call[1])).filter((ms) => ms > 1_000)
    expect(delays).toHaveLength(3)
    for (const ms of delays) expect(ms).toBeLessThanOrEqual(MAX_BACKOFF_DELAY_MS)
    spy.mockRestore()
  })
})

describe("backoff validation exact messages", () => {
  const base: BackoffPolicy = { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 2, maxDelayMs: 100, jitter: "none" }
  it("labels every rejection", () => {
    expect(message(() => validateBackoffPolicy(null as never))).toBe("Backoff policy must be an object")
    expect(message(() => validateBackoffPolicy([] as never, "X"))).toBe("X must be an object")
    expect(message(() => validateBackoffPolicy({ ...base, maxAttempts: 0 }, "P"))).toMatch(/^P maxAttempts must be an integer from 1 to \d+$/)
    expect(message(() => validateBackoffPolicy({ ...base, initialDelayMs: -1 }, "P"))).toMatch(/^P initialDelayMs must be an integer from 0 to \d+$/)
    expect(message(() => validateBackoffPolicy({ ...base, maxDelayMs: 5 }, "P"))).toMatch(/^P maxDelayMs must be an integer from initialDelayMs to \d+$/)
    expect(message(() => validateBackoffPolicy({ ...base, backoffMultiplier: 11 }, "P"))).toBe("P backoffMultiplier must be a number from 1 to 10")
    expect(message(() => validateBackoffPolicy({ ...base, jitter: "full" as never }, "P"))).toBe('P jitter must be "none" or "equal"')
    expect(validateBackoffPolicy(base)).toEqual(base)
  })
  it("rejects a bad failed attempt and falls back to 0.5 for a bad random sample", () => {
    expect(message(() => computeBackoffDelayMs(base, 0))).toBe("Backoff attempt must be a positive integer")
    const equal = { ...base, jitter: "equal" as const }
    for (const sample of [Number.NaN, -0.1, 1, 2, Number.POSITIVE_INFINITY]) expect(computeBackoffDelayMs(equal, 1, () => sample)).toBe(computeBackoffDelayMs(equal, 1, () => 0.5))
    expect(computeBackoffDelayMs(equal, 1, () => 0)).not.toBe(computeBackoffDelayMs(equal, 1, () => 0.5))
  })
})
