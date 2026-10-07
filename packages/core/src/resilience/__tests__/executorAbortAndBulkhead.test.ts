import { afterEach, describe, expect, it, vi } from "vitest"
import { createBulkhead, withResilience } from "../executor"
import { CancelledError, TimeoutError, UnavailableError } from "../../domain/errors"

const domAbort = (): DOMException => new DOMException("This operation was aborted", "AbortError")
const hangs = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)))

describe("withResilience surfaces caller aborts as framework errors", () => {
  afterEach(() => vi.useRealTimers())

  it("maps an abort before the attempt to CancelledError", async () => {
    const controller = new AbortController(); controller.abort(domAbort())
    await expect(withResilience({}, { kind: "read" }, async () => 1, { signal: controller.signal })).rejects.toBeInstanceOf(CancelledError)
  })

  it("maps an abort during the attempt to CancelledError keeping the reason as cause", async () => {
    const controller = new AbortController()
    const reason = domAbort()
    const run = withResilience({ timeoutMs: 1_000 }, { kind: "read" }, hangs, { signal: controller.signal })
    controller.abort(reason)
    const error = await run.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CancelledError)
    expect((error as Error).cause).toBe(reason)
  })

  it("maps an AbortSignal.timeout-style reason to TimeoutError", async () => {
    const controller = new AbortController()
    const run = withResilience({}, { kind: "read" }, hangs, { signal: controller.signal })
    controller.abort(new DOMException("signal timed out", "TimeoutError"))
    await expect(run).rejects.toBeInstanceOf(TimeoutError)
  })

  it("maps an abort during backoff to CancelledError", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const run = withResilience({ retry: { maxAttempts: 5, backoffMs: 1_000 } }, { kind: "read" }, async () => { throw new Error("down") }, { signal: controller.signal })
    const assertion = expect(run).rejects.toBeInstanceOf(CancelledError)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(domAbort())
    await assertion
  })

  it("maps an abort while queued for the bulkhead to CancelledError", async () => {
    const bulkhead = createBulkhead(1, 1)
    const release = await bulkhead.acquire()
    const controller = new AbortController()
    const run = withResilience({ bulkhead: { maxConcurrent: 1, maxQueue: 1 } }, { kind: "read" }, async () => 1, { bulkhead, signal: controller.signal })
    controller.abort(domAbort())
    await expect(run).rejects.toBeInstanceOf(CancelledError)
    release()
    const pre = new AbortController(); pre.abort(domAbort())
    await expect(bulkhead.acquire(pre.signal)).rejects.toBeInstanceOf(CancelledError)
  })
})

describe("withResilience bulkhead accounting with timed-out work", () => {
  afterEach(() => vi.useRealTimers())

  it("keeps the slot until timed-out work that ignores its signal actually settles", async () => {
    vi.useFakeTimers()
    const bulkhead = createBulkhead(1, 0)
    const policy = { timeoutMs: 20, bulkhead: { maxConcurrent: 1, maxQueue: 0 } }
    let inFlight = 0; let peak = 0
    const ignoresAbort = async (): Promise<string> => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 200))
      inFlight--
      return "late"
    }
    const first = withResilience(policy, { kind: "read" }, ignoresAbort, { bulkhead })
    const firstAssertion = expect(first).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(20)
    await firstAssertion
    expect(bulkhead.active).toBe(1)
    await expect(withResilience(policy, { kind: "read" }, ignoresAbort, { bulkhead })).rejects.toBeInstanceOf(UnavailableError)
    await vi.advanceTimersByTimeAsync(180)
    expect(bulkhead.active).toBe(0)
    const third = withResilience({ bulkhead: { maxConcurrent: 1, maxQueue: 0 } }, { kind: "read" }, ignoresAbort, { bulkhead })
    await vi.advanceTimersByTimeAsync(200)
    await expect(third).resolves.toBe("late")
    expect(peak).toBe(1)
    expect(bulkhead.active).toBe(0)
  })

  it("releases a queued waiter only when timed-out rejected work settles, exactly once", async () => {
    vi.useFakeTimers()
    const bulkhead = createBulkhead(1, 1)
    const policy = { timeoutMs: 20, bulkhead: { maxConcurrent: 1, maxQueue: 1 } }
    const first = withResilience(policy, { kind: "read" }, () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late failure")), 200)), { bulkhead })
    const firstAssertion = expect(first).rejects.toBeInstanceOf(TimeoutError)
    await vi.advanceTimersByTimeAsync(20)
    await firstAssertion
    let started = false
    const second = withResilience(policy, { kind: "read" }, async () => { started = true; return 2 }, { bulkhead })
    await vi.advanceTimersByTimeAsync(100)
    expect(started).toBe(false)
    expect([bulkhead.active, bulkhead.queued]).toEqual([1, 1])
    await vi.advanceTimersByTimeAsync(100)
    await expect(second).resolves.toBe(2)
    expect([bulkhead.active, bulkhead.queued]).toEqual([0, 0])
  })
})
