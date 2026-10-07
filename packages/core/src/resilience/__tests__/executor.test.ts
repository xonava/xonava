import { afterEach, describe, expect, it, vi } from "vitest"
import { admitCircuit, CLOSED_CIRCUIT, createBulkhead, createCircuitBreaker, recordCircuitFailure, recordCircuitSuccess, withResilience } from "../executor"
import { CancelledError, ConfigurationError, TimeoutError, UnavailableError, ValidationError } from "../../domain/errors"

const breakerPolicy = { failureThreshold: 2, resetAfterMs: 1_000 }

describe("circuit breaker state machine", () => {
  it("opens after consecutive failures, half-opens for one trial, and closes on success", () => {
    let state = recordCircuitFailure(CLOSED_CIRCUIT, breakerPolicy, 0)
    expect(state.status).toBe("closed")
    state = recordCircuitFailure(state, breakerPolicy, 10)
    expect(state).toMatchObject({ status: "open", openedAt: 10 })
    expect(admitCircuit(state, breakerPolicy, 500).allowed).toBe(false)
    const trial = admitCircuit(state, breakerPolicy, 1_010)
    expect(trial).toMatchObject({ allowed: true, state: { status: "half_open", trialInFlight: true } })
    expect(admitCircuit(trial.state, breakerPolicy, 1_011).allowed).toBe(false)
    expect(recordCircuitFailure(trial.state, breakerPolicy, 1_020)).toMatchObject({ status: "open", openedAt: 1_020 })
    expect(recordCircuitSuccess(trial.state)).toBe(CLOSED_CIRCUIT)
    expect(recordCircuitSuccess({ ...state, consecutiveFailures: 1, status: "closed" })).toBe(CLOSED_CIRCUIT)
  })

  it("an in-process breaker fails fast while open", () => {
    let now = 0
    const breaker = createCircuitBreaker(breakerPolicy, () => now)
    breaker.admit()("failure")
    const done = breaker.admit(); done("failure"); done("success")
    expect(breaker.state.status).toBe("open")
    expect(() => breaker.admit()).toThrow(UnavailableError)
    now = 1_000
    breaker.admit()("success")
    expect(breaker.state.status).toBe("closed")
    expect(() => createCircuitBreaker({ failureThreshold: 0, resetAfterMs: 1 })).toThrow(ConfigurationError)
  })
})

describe("bulkhead", () => {
  it("bounds concurrency, queues FIFO, and rejects beyond the queue", async () => {
    const bulkhead = createBulkhead(1, 1)
    const releaseA = await bulkhead.acquire()
    const b = bulkhead.acquire()
    await expect(bulkhead.acquire()).rejects.toBeInstanceOf(UnavailableError)
    expect([bulkhead.active, bulkhead.queued]).toEqual([1, 1])
    releaseA(); releaseA()
    const releaseB = await b
    expect([bulkhead.active, bulkhead.queued]).toEqual([1, 0])
    releaseB()
    expect(bulkhead.active).toBe(0)
  })

  it("removes an aborted waiter so it never holds a slot", async () => {
    const bulkhead = createBulkhead(1, 2)
    const release = await bulkhead.acquire()
    const controller = new AbortController()
    const waiting = bulkhead.acquire(controller.signal)
    controller.abort(new Error("client gone"))
    await expect(waiting).rejects.toThrow("client gone")
    expect(bulkhead.queued).toBe(0)
    release()
    expect(bulkhead.active).toBe(0)
    await expect(bulkhead.acquire(controller.signal)).rejects.toThrow("client gone")
  })
})

describe("withResilience", () => {
  afterEach(() => vi.useRealTimers())

  it("retries reads with jittered backoff until success", async () => {
    let calls = 0
    const result = await withResilience({ retry: { maxAttempts: 3, backoffMs: 1 } }, { kind: "read" }, async () => { calls++; if (calls < 3) throw new Error("flaky"); return "ok" }, { random: () => 0 })
    expect([result, calls]).toEqual(["ok", 3])
  })

  it("never retries non-idempotent mutations or permanent errors", async () => {
    await expect(withResilience({ retry: { maxAttempts: 3 } }, { kind: "non-idempotent-mutation" }, async () => 1)).rejects.toBeInstanceOf(ConfigurationError)
    let calls = 0
    await expect(withResilience({ retry: { maxAttempts: 3 } }, { kind: "idempotent-mutation", idempotencyKey: "k" }, async () => { calls++; throw new ValidationError("bad") })).rejects.toBeInstanceOf(ValidationError)
    expect(calls).toBe(1)
  })

  it("times out each attempt, aborts the work, and leaves no timers", async () => {
    vi.useFakeTimers()
    let aborted = false
    const run = withResilience({ timeoutMs: 100 }, { kind: "read" }, (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason) })))
    const assertion = expect(run).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops retrying when cancelled during backoff", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const run = withResilience({ retry: { maxAttempts: 5, backoffMs: 1_000 } }, { kind: "read" }, async () => { throw new Error("down") }, { signal: controller.signal })
    const assertion = expect(run).rejects.toBeInstanceOf(CancelledError)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new CancelledError())
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it("uses the shared breaker and bulkhead and always releases the slot", async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 1, resetAfterMs: 60_000 })
    const bulkhead = createBulkhead(1)
    const policy = { circuitBreaker: { failureThreshold: 1, resetAfterMs: 60_000 }, bulkhead: { maxConcurrent: 1 } }
    await expect(withResilience(policy, { kind: "read" }, async () => { throw new Error("down") }, { breaker, bulkhead })).rejects.toThrow("down")
    expect(bulkhead.active).toBe(0)
    const work = vi.fn(async () => 1)
    await expect(withResilience(policy, { kind: "read" }, work, { breaker, bulkhead })).rejects.toBeInstanceOf(UnavailableError)
    expect(work).not.toHaveBeenCalled()
    expect(bulkhead.active).toBe(0)
    await expect(withResilience(policy, { kind: "read" }, work)).rejects.toBeInstanceOf(ConfigurationError)
  })
})
