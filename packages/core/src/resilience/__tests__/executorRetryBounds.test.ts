import { afterEach, describe, expect, it, vi } from "vitest"
import { createBulkhead, withResilience } from "../executor"
import { DEFAULT_RETRY_BACKOFF_MS, validateResiliencePolicy } from "../resilience"
import { MAX_BACKOFF_ATTEMPTS } from "../backoff"
import { CancelledError, ConfigurationError, UnavailableError } from "../../domain/errors"

describe("retry under a bulkhead with timed-out work that ignores its signal", () => {
  afterEach(() => vi.useRealTimers())

  it("never runs a retry while the abandoned attempt still occupies the slot", async () => {
    vi.useFakeTimers()
    const bulkhead = createBulkhead(1, 0)
    let inFlight = 0
    let peak = 0
    let calls = 0
    const ignoresAbort = async (): Promise<string> => {
      calls++; inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      inFlight--
      return "late"
    }
    const run = withResilience({ timeoutMs: 20, retry: { maxAttempts: 4, backoffMs: 10 }, bulkhead: { maxConcurrent: 1 } }, { kind: "read" }, ignoresAbort, { bulkhead, random: () => 0 })
    const assertion = expect(run).rejects.toBeInstanceOf(UnavailableError)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect([calls, peak]).toEqual([1, 1])
    expect(bulkhead.active).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(bulkhead.active).toBe(0)
  })

  it("retries once a timed-out attempt honours its signal and settles", async () => {
    vi.useFakeTimers()
    const bulkhead = createBulkhead(1, 0)
    let calls = 0
    const work = (signal: AbortSignal): Promise<string> => {
      calls++
      if (calls > 1) return Promise.resolve("ok")
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
    }
    const run = withResilience({ timeoutMs: 20, retry: { maxAttempts: 2, backoffMs: 10 }, bulkhead: { maxConcurrent: 1 } }, { kind: "read" }, work, { bulkhead, random: () => 0 })
    await vi.advanceTimersByTimeAsync(50)
    await expect(run).resolves.toBe("ok")
    expect(calls).toBe(2)
    expect(bulkhead.active).toBe(0)
  })
})

describe("caller cancellation while work ignores its signal", () => {
  afterEach(() => vi.useRealTimers())

  it("rejects promptly instead of waiting for (and returning) the late result", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const run = withResilience({}, { kind: "read" }, () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 100)), { signal: controller.signal })
    const outcome = run.then((value) => ({ value }), (error: unknown) => ({ error }))
    await vi.advanceTimersByTimeAsync(10)
    controller.abort(new Error("caller gone"))
    await vi.advanceTimersByTimeAsync(0)
    const settled = await Promise.race([outcome, Promise.resolve("pending")])
    expect(settled).toMatchObject({ error: expect.any(CancelledError) })
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("also rejects promptly with a per-attempt timeout configured", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const run = withResilience({ timeoutMs: 1_000 }, { kind: "read" }, () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 100)), { signal: controller.signal })
    const outcome = run.then((value) => ({ value }), (error: unknown) => ({ error }))
    await vi.advanceTimersByTimeAsync(10)
    controller.abort(new Error("caller gone"))
    await vi.advanceTimersByTimeAsync(0)
    expect(await Promise.race([outcome, Promise.resolve("pending")])).toMatchObject({ error: expect.any(CancelledError) })
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("retry policy bounds", () => {
  afterEach(() => vi.useRealTimers())

  it("caps retry.maxAttempts at the shared backoff attempt limit", () => {
    expect(validateResiliencePolicy({ retry: { maxAttempts: MAX_BACKOFF_ATTEMPTS } }, { kind: "read" })).toBeDefined()
    expect(() => validateResiliencePolicy({ retry: { maxAttempts: MAX_BACKOFF_ATTEMPTS + 1 } }, { kind: "read" })).toThrow(ConfigurationError)
  })

  it("backs off by default when retries are configured without backoffMs", async () => {
    vi.useFakeTimers()
    let calls = 0
    const run = withResilience({ retry: { maxAttempts: 2 } }, { kind: "read" }, async () => { calls++; if (calls === 1) throw new Error("flaky"); return "ok" }, { random: () => 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(DEFAULT_RETRY_BACKOFF_MS)
    await expect(run).resolves.toBe("ok")
    expect(calls).toBe(2)
  })
})
