import { afterEach, describe, expect, it, vi } from "vitest"
import type { JobDefinition, JobExecution, JobResult, JobTransitionResult } from "../types"
import { deferred, fakeClock, flush, runOnce, type FakeClock, type StoreMocks } from "./executionMutationHarness"

const never = (): Promise<JobResult> => new Promise<JobResult>(() => undefined)
const claim = { jobId: "job-1", workerId: "w1", claimToken: "claim-secret" }

afterEach(() => { vi.useRealTimers() })

function timerIndex(clock: FakeClock, ms: number): number {
  return clock.timers.findIndex((timer) => timer.ms === ms && !timer.cleared)
}

describe("re-fence before execution", () => {
  it("asks the store to extend the lease by the lease duration, guarded by a half-lease deadline", async () => {
    const clock = fakeClock()
    const execute = vi.fn(async (): Promise<JobResult> => ({ success: true }))
    const run = await runOnce({ config: { clock }, definition: { execute } })
    expect(run.mocks.renewLease.mock.calls).toStrictEqual([[{ ...claim, extendByMs: 900 }]])
    expect(clock.timers[0]?.ms).toBe(450)
    expect(clock.timers[0]?.cleared).toBe(true)
    expect(clock.cleared).toContain(clock.timers[0]?.handle)
    expect(execute).toHaveBeenCalledOnce()
  })

  it("never uses a re-fence deadline below one millisecond and rounds half-leases down", async () => {
    const tiny = fakeClock()
    await runOnce({ config: { clock: tiny, leaseDurationMs: 1 } })
    expect(tiny.timers[0]?.ms).toBe(1)
    const odd = fakeClock()
    await runOnce({ config: { clock: odd, leaseDurationMs: 5 } })
    expect(odd.timers[0]?.ms).toBe(2)
  })

  it("does not run a job whose re-fence was rejected", async () => {
    const execute = vi.fn(async (): Promise<JobResult> => ({ success: true }))
    const run = await runOnce({ definition: { execute }, prepare: (mocks) => mocks.renewLease.mockResolvedValue(false) })
    expect(execute).not.toHaveBeenCalled()
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
    expect(run.rec.find("Job lease re-fence rejected")).toEqual([{ severity: "warn", message: "Job lease re-fence rejected", jobId: "job-1", workerId: "w1", claimToken: "[REDACTED]" }])
  })

  it("does not run a job whose re-fence threw", async () => {
    const execute = vi.fn(async (): Promise<JobResult> => ({ success: true }))
    const run = await runOnce({ definition: { execute }, prepare: (mocks) => mocks.renewLease.mockRejectedValue(new Error("renew exploded")) })
    expect(execute).not.toHaveBeenCalled()
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "renew exploded", action: "lease_lost" }])
    expect(run.rec.find("Job lease re-fence threw")).toEqual([{ severity: "warn", message: "Job lease re-fence threw", jobId: "job-1", workerId: "w1", error: "renew exploded" }])
  })

  it("gives up on a re-fence that does not answer within half a lease", async () => {
    const clock = fakeClock()
    const pending = runOnce({ config: { clock }, prepare: (mocks) => mocks.renewLease.mockReturnValue(new Promise<boolean>(() => undefined)) })
    await flush()
    clock.fire(timerIndex(clock, 450))
    const run = await pending
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease renewal timed out", action: "lease_lost" }])
  })

  it("falls back to a global timer for the re-fence deadline when the clock has none, and clears it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const clock = fakeClock({ timers: false })
    let finished = false
    const pending = runOnce({ config: { clock, leaseDurationMs: 10 }, prepare: (mocks) => mocks.renewLease.mockReturnValue(new Promise<boolean>(() => undefined)) }).then((run) => { finished = true; return run })
    await flush()
    await vi.advanceTimersByTimeAsync(4)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const run = await pending
    expect(run.result.errors[0]?.error).toBe("Job lease renewal timed out")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears the global timers of a normal run when the clock has none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const run = await runOnce({ config: { clock: fakeClock({ timers: false }) } })
    expect(run.result.succeeded).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("execution deadline and cancellation grace", () => {
  it("prefers the policy timeout, then the definition timeout, then the lease duration", async () => {
    const policy = fakeClock()
    await runOnce({ config: { clock: policy, timeoutPolicy: { mode: "cooperative", timeoutMs: 111, cancellationGraceMs: 5 } }, definition: { timeoutMs: 222 } })
    expect(policy.timers.map((timer) => timer.ms)).toEqual([450, 111])
    const definition = fakeClock()
    await runOnce({ config: { clock: definition }, definition: { timeoutMs: 222 } })
    expect(definition.timers.map((timer) => timer.ms)).toEqual([450, 222])
    const lease = fakeClock()
    await runOnce({ config: { clock: lease } })
    expect(lease.timers.map((timer) => timer.ms)).toEqual([450, 900])
    expect(lease.timers.every((timer) => timer.cleared)).toBe(true)
  })

  it("sets the deadline of the context from the effective timeout", async () => {
    let deadline: number | undefined
    let startedAt: Date | undefined
    await runOnce({ config: { timeoutPolicy: { mode: "cooperative", timeoutMs: 321, cancellationGraceMs: 5 } }, definition: { execute: async (execution) => { deadline = execution.deadline; startedAt = execution.startedAt; return { success: true } } } })
    expect(deadline).toBe((startedAt as Date).getTime() + 321)
  })

  it("does not wait for the cancellation grace after an ordinary failure", async () => {
    const clock = fakeClock()
    const run = await runOnce({ config: { clock }, definition: { execute: async () => { throw new Error("plain") } } })
    expect(run.result.retried).toBe(1)
    expect(clock.timers.map((timer) => timer.ms)).toEqual([450, 900])
  })

  it("reports an execution that ignores cancellation as stalled and fences its late effects off", async () => {
    const clock = fakeClock()
    let context: JobExecution | undefined
    const pending = runOnce({
      config: { clock, timeoutPolicy: { mode: "cooperative", timeoutMs: 777, cancellationGraceMs: 55 } },
      definition: { execute: (execution) => { context = execution; return never() } },
    })
    await flush()
    clock.fire(timerIndex(clock, 777))
    await flush()
    const graceTimer = timerIndex(clock, 55)
    expect(graceTimer).toBeGreaterThanOrEqual(0)
    clock.fire(graceTimer)
    const run = await pending
    expect(run.result).toMatchObject({ stalled: 1, retried: 0, leaseLost: 0 })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job job-1 did not stop within the 55ms cancellation grace period.", action: "stalled" }])
    expect(run.rec.find("Job stalled")).toEqual([{ severity: "error", message: "Job stalled", jobId: "job-1", jobType: "job", error: "Job job-1 did not stop within the 55ms cancellation grace period." }])
    expect((context?.signal?.reason as Error).message).toBe("Job job-1 timed out after 777ms")
    expect(run.mocks.markRetrying).not.toHaveBeenCalled()
    expect(run.mocks.markFailed).not.toHaveBeenCalled()
    expect(clock.timers.filter((timer) => timer.ms === 55).every((timer) => timer.cleared)).toBe(true)
    expect(clock.timers.find((timer) => timer.ms === 777)?.cleared).toBe(true)
    // The abandoned execution can neither pass the fence nor keep the lease alive.
    const renewals = run.mocks.renewLease.mock.calls.length
    await expect((context as JobExecution).fencedEffect.execute({ effectName: "late", idempotencyKey: "k", fn: async () => 1 })).rejects.toMatchObject({ message: "Job lease was lost: the claim is no longer active" })
    expect(run.mocks.renewLease.mock.calls.length).toBe(renewals)
  })

  it("waits at least one millisecond for a zero cancellation grace", async () => {
    const clock = fakeClock()
    const pending = runOnce({ config: { clock, timeoutPolicy: { mode: "cooperative", timeoutMs: 777, cancellationGraceMs: 0 } }, definition: { execute: never } })
    await flush()
    clock.fire(timerIndex(clock, 777))
    await flush()
    const graceTimer = timerIndex(clock, 1)
    expect(graceTimer).toBeGreaterThanOrEqual(0)
    clock.fire(graceTimer)
    const run = await pending
    expect(run.result.stalled).toBe(1)
    expect(run.result.errors[0]?.error).toBe("Job job-1 did not stop within the 0ms cancellation grace period.")
  })

  it("uses the lease duration as the default cancellation grace", async () => {
    const clock = fakeClock()
    const pending = runOnce({ config: { clock, leaseDurationMs: 640 }, definition: { execute: never } })
    await flush()
    clock.fire(timerIndex(clock, 640))
    await flush()
    const sameDuration = clock.timers.flatMap((timer, index) => (timer.ms === 640 ? [index] : []))
    expect(sameDuration).toHaveLength(2)
    clock.fire(sameDuration[1] as number)
    const run = await pending
    expect(run.result.errors[0]?.error).toBe("Job job-1 did not stop within the 640ms cancellation grace period.")
  })

  it("retries a timed-out execution that stops within the grace period, and clears the grace timer", async () => {
    const clock = fakeClock()
    const pending = runOnce({
      config: { clock, timeoutPolicy: { mode: "cooperative", timeoutMs: 777, cancellationGraceMs: 55 } },
      definition: { execute: (execution) => new Promise<JobResult>((resolve) => { execution.signal?.addEventListener("abort", () => { setImmediate(() => resolve({ success: false, error: new Error("late") })) }) }) },
    })
    await flush()
    clock.fire(timerIndex(clock, 777))
    const run = await pending
    expect(run.result).toMatchObject({ retried: 1, stalled: 0 })
    expect(run.result.errors[0]?.error).toBe("Job job-1 timed out after 777ms")
    const grace = clock.timers.filter((timer) => timer.ms === 55)
    expect(grace).toHaveLength(1)
    expect(grace[0]?.cleared).toBe(true)
    expect(clock.cleared).toContain(grace[0]?.handle)
  })

  it("keeps the global timers of a stalled execution exact when the clock has none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const clock = fakeClock({ timers: false })
    let finished = false
    const pending = runOnce({ config: { clock, leaseDurationMs: 1000, timeoutPolicy: { mode: "cooperative", timeoutMs: 100, cancellationGraceMs: 50 } }, definition: { execute: never } }).then((run) => { finished = true; return run })
    await flush()
    await vi.advanceTimersByTimeAsync(99)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    await vi.advanceTimersByTimeAsync(49)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const run = await pending
    expect(run.result.stalled).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears the global grace timer of a timed-out execution that settles when the clock has none", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const clock = fakeClock({ timers: false })
    const pending = runOnce({
      config: { clock, leaseDurationMs: 1000, timeoutPolicy: { mode: "cooperative", timeoutMs: 100, cancellationGraceMs: 50 } },
      definition: { execute: (execution) => new Promise<JobResult>((resolve) => { execution.signal?.addEventListener("abort", () => { setImmediate(() => resolve({ success: false, error: new Error("late") })) }) }) },
    })
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    await flush()
    const run = await pending
    expect(run.result.retried).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not leave an unhandled rejection when the deadline passes while a synchronous failure is recorded", async () => {
    const clock = fakeClock()
    const gate = deferred<JobTransitionResult>()
    const execute = ((): never => { throw new Error("sync failure") }) as unknown as JobDefinition["execute"]
    const pending = runOnce({ config: { clock }, definition: { execute }, prepare: (mocks) => mocks.markRetrying.mockReturnValue(gate.promise) })
    await flush()
    clock.fire(timerIndex(clock, 900))
    await flush()
    gate.resolve({ applied: true })
    const run = await pending
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "sync failure", action: "retry" }])
  })
})

describe("heartbeat", () => {
  async function started(options: { lease?: number; execute?: JobDefinition["execute"]; prepare?: (mocks: StoreMocks) => void; grace?: number } = {}) {
    const clock = fakeClock()
    let mocks!: StoreMocks
    let context!: JobExecution
    const gate = deferred<JobResult>()
    const pending = runOnce({
      config: { clock, ...(options.lease === undefined ? {} : { leaseDurationMs: options.lease }), timeoutPolicy: { mode: "cooperative", cancellationGraceMs: options.grace ?? 55 } },
      definition: { execute: options.execute ?? ((execution) => { context = execution; return gate.promise }) },
      prepare: (m) => { mocks = m; options.prepare?.(m) },
    })
    await flush()
    return { clock, pending, gate, mocks: () => mocks, context: () => context }
  }

  it("sleeps a third of the lease and renews with the full lease duration on every tick", async () => {
    const h = await started()
    expect(h.clock.sleeps.map((sleep) => sleep.ms)).toEqual([300])
    h.clock.sleeps[0]?.resolve()
    await flush()
    expect(h.mocks().renewLease.mock.calls).toStrictEqual([[{ ...claim, extendByMs: 900 }], [{ ...claim, extendByMs: 900 }]])
    expect(h.clock.sleeps.map((sleep) => sleep.ms)).toEqual([300, 300])
    h.gate.resolve({ success: true })
    const run = await h.pending
    expect(run.result.succeeded).toBe(1)
    expect(h.clock.sleeps.every((sleep) => sleep.signal?.aborted === true)).toBe(true)
    expect(run.rec.find("Job heartbeat lease renewal failed")).toEqual([])
    expect(run.rec.find("Job heartbeat sleep failed; treating as lease lost")).toEqual([])
  })

  it("never sleeps less than one millisecond", async () => {
    const h = await started({ lease: 2 })
    expect(h.clock.sleeps[0]?.ms).toBe(1)
    h.gate.resolve({ success: true })
    await h.pending
  })

  it("does not renew after the job has finished, even if the sleep ends late", async () => {
    const h = await started()
    h.gate.resolve({ success: true })
    const run = await h.pending
    h.clock.sleeps[0]?.resolve()
    await flush()
    expect(run.mocks.renewLease).toHaveBeenCalledTimes(1)
    expect(run.rec.records().filter((record) => record.severity === "warn" || record.severity === "error")).toEqual([])
  })

  it("treats a refused heartbeat renewal as a lost lease: aborts, waits out the grace, fences the handler", async () => {
    let captured: JobExecution | undefined
    const h = await started({ execute: (execution) => { captured = execution; return never() }, prepare: (m) => m.renewLease.mockResolvedValueOnce(true).mockResolvedValueOnce(false) })
    h.clock.sleeps[0]?.resolve()
    await flush()
    const graceTimer = timerIndex(h.clock, 55)
    expect(graceTimer).toBeGreaterThanOrEqual(0)
    h.clock.fire(graceTimer)
    const run = await h.pending
    expect(run.result).toMatchObject({ leaseLost: 1, retried: 0, stalled: 0 })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
    expect(run.mocks.markRetrying).not.toHaveBeenCalled()
    expect(run.mocks.markFailed).not.toHaveBeenCalled()
    expect(run.mocks.markSucceeded).not.toHaveBeenCalled()
    expect(run.rec.find("Job heartbeat lease renewal failed")).toEqual([{ severity: "warn", message: "Job heartbeat lease renewal failed", jobId: "job-1", error: "Job lease was lost", claimToken: "[REDACTED]" }])
    expect(run.rec.find("Job lease lost")).toHaveLength(1)
    const renewals = run.mocks.renewLease.mock.calls.length
    expect(renewals).toBe(2)
    expect(captured?.signal?.aborted).toBe(true)
    expect((captured?.signal?.reason as Error).message).toBe("Job lease was lost")
    await expect((captured as JobExecution).fencedEffect.execute({ effectName: "late", idempotencyKey: "k", fn: async () => 1 })).rejects.toMatchObject({ message: "Job lease was lost" })
    expect(run.mocks.renewLease.mock.calls.length).toBe(renewals)
    expect(h.clock.timers.find((timer) => timer.ms === 55)?.cleared).toBe(true)
  })

  it("aborts with a fresh error when the renewal failure is not an Error", async () => {
    let captured: JobExecution | undefined
    const h = await started({ execute: (execution) => { captured = execution; return never() }, prepare: (m) => m.renewLease.mockResolvedValueOnce(true).mockRejectedValueOnce("raw failure") })
    h.clock.sleeps[0]?.resolve()
    await flush()
    h.clock.fire(timerIndex(h.clock, 55))
    const run = await h.pending
    expect(run.result.leaseLost).toBe(1)
    expect((captured?.signal?.reason as Error).message).toBe("Job lease was lost")
    expect(run.rec.find("Job heartbeat lease renewal failed")).toEqual([{ severity: "warn", message: "Job heartbeat lease renewal failed", jobId: "job-1", error: "raw failure", claimToken: "[REDACTED]" }])
  })

  it("aborts with the renewal error itself when the store failed with an Error", async () => {
    let captured: JobExecution | undefined
    const failure = new Error("store unreachable")
    const h = await started({ execute: (execution) => { captured = execution; return never() }, prepare: (m) => m.renewLease.mockResolvedValueOnce(true).mockRejectedValueOnce(failure) })
    h.clock.sleeps[0]?.resolve()
    await flush()
    h.clock.fire(timerIndex(h.clock, 55))
    await h.pending
    expect(captured?.signal?.reason).toBe(failure)
  })

  it("treats a failing heartbeat sleep as a lost lease", async () => {
    let captured: JobExecution | undefined
    const h = await started({ execute: (execution) => { captured = execution; return never() } })
    h.clock.sleeps[0]?.reject(new Error("timer broke"))
    await flush()
    h.clock.fire(timerIndex(h.clock, 55))
    const run = await h.pending
    expect(run.result).toMatchObject({ leaseLost: 1 })
    expect(run.rec.find("Job heartbeat sleep failed; treating as lease lost")).toEqual([{ severity: "warn", message: "Job heartbeat sleep failed; treating as lease lost", jobId: "job-1", error: "timer broke" }])
    expect((captured?.signal?.reason as Error).message).toBe("Job lease renewal failed")
    expect(run.mocks.renewLease).toHaveBeenCalledTimes(1)
  })

  it("does not complete a successful execution once the lease was lost while its last renewal was in flight", async () => {
    const renewal = deferred<boolean>()
    const clock = fakeClock()
    let mocks!: StoreMocks
    const pending = runOnce({
      config: { clock, timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 55 } },
      definition: { execute: async (execution) => { void execution.fencedEffect.execute({ effectName: "e", idempotencyKey: "k", fn: async () => 1 }).catch(() => undefined); return { success: true } } },
      prepare: (m) => { mocks = m; m.renewLease.mockResolvedValueOnce(true).mockReturnValueOnce(renewal.promise) },
    })
    await flush()
    expect(mocks.renewLease).toHaveBeenCalledTimes(2)
    clock.sleeps[0]?.reject(new Error("timer broke"))
    await flush()
    renewal.resolve(true)
    const run = await pending
    expect(mocks.markSucceeded).not.toHaveBeenCalled()
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
    const grace = clock.timers.filter((timer) => timer.ms === 55)
    expect(grace).toHaveLength(1)
    expect(grace[0]?.cleared).toBe(true)
  })

  it("waits for a renewal that already started before completing the job", async () => {
    const renewal = deferred<boolean>()
    let mocks!: StoreMocks
    const pending = runOnce({
      definition: { execute: async (execution) => { void execution.fencedEffect.execute({ effectName: "e", idempotencyKey: "k", fn: async () => 1 }).catch(() => undefined); return { success: true } } },
      prepare: (m) => { mocks = m; m.renewLease.mockResolvedValueOnce(true).mockReturnValueOnce(renewal.promise) },
    })
    await flush()
    expect(mocks.markSucceeded).not.toHaveBeenCalled()
    renewal.resolve(true)
    const run = await pending
    expect(run.result.succeeded).toBe(1)
  })

  it("shares one renewal between concurrent fences", async () => {
    const renewal = deferred<boolean>()
    let mocks!: StoreMocks
    const pending = runOnce({
      definition: {
        execute: async (execution) => {
          const fences = [1, 2, 3].map((n) => execution.fencedEffect.execute({ effectName: "e", idempotencyKey: `k${n}`, fn: async () => n }))
          await flush()
          renewal.resolve(true)
          return { success: true, data: { results: await Promise.all(fences) } }
        },
      },
      prepare: (m) => { mocks = m; m.renewLease.mockResolvedValueOnce(true).mockReturnValueOnce(renewal.promise) },
    })
    const run = await pending
    expect(run.mocks.markSucceeded.mock.calls[0]?.[0].result).toEqual({ results: [1, 2, 3] })
    expect(mocks.renewLease).toHaveBeenCalledTimes(2)
  })

  it("allows a fresh fence after the previous renewal completed", async () => {
    let mocks!: StoreMocks
    const run = await runOnce({
      definition: {
        execute: async (execution) => {
          await execution.fencedEffect.execute({ effectName: "e", idempotencyKey: "k1", fn: async () => 1 })
          await execution.fencedEffect.execute({ effectName: "e", idempotencyKey: "k2", fn: async () => 2 })
          return { success: true }
        },
      },
      prepare: (m) => { mocks = m },
    })
    expect(run.result.succeeded).toBe(1)
    expect(mocks.renewLease).toHaveBeenCalledTimes(3)
  })
})

describe("system clock", () => {
  it("renews the lease on real timers until the handler finishes, then leaves no timer behind", async () => {
    let mocks!: StoreMocks
    const waitFor = async (condition: () => boolean): Promise<void> => {
      const deadline = Date.now() + 5000
      while (!condition() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 5))
    }
    const run = await runOnce({
      systemClock: true,
      config: { leaseDurationMs: 60, timeoutPolicy: { mode: "cooperative", timeoutMs: 20_000, cancellationGraceMs: 100 } },
      definition: { execute: async () => { await waitFor(() => mocks.renewLease.mock.calls.length >= 3); return { success: true } } },
      prepare: (m) => { mocks = m },
    })
    expect(run.result.succeeded).toBe(1)
    expect(mocks.renewLease.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(run.rec.find("Job heartbeat lease renewal failed")).toEqual([])
  })

  it("times out a handler on the system clock and reports it as a retryable timeout", async () => {
    const run = await runOnce({
      systemClock: true,
      config: { leaseDurationMs: 40, timeoutPolicy: { mode: "cooperative", timeoutMs: 30, cancellationGraceMs: 200 } },
      definition: { execute: (execution) => new Promise<JobResult>((resolve) => { execution.signal?.addEventListener("abort", () => { setTimeout(() => resolve({ success: false, error: new Error("late") }), 5) }) }) },
    })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job job-1 timed out after 30ms", action: "retry" }])
  })

  it("reports a handler that outlives the system-clock grace period as stalled", async () => {
    const run = await runOnce({
      systemClock: true,
      config: { leaseDurationMs: 40, timeoutPolicy: { mode: "cooperative", timeoutMs: 20, cancellationGraceMs: 20 } },
      definition: { execute: never },
    })
    expect(run.result.stalled).toBe(1)
  })
})

describe("run outcome of a lost lease with an unresponsive handler", () => {
  it("returns lease_lost without completing when the execution never settles", async () => {
    const clock = fakeClock()
    const pending = runOnce({
      config: { clock, timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 55 } },
      definition: { execute: never },
      prepare: (mocks) => mocks.renewLease.mockResolvedValueOnce(true).mockResolvedValueOnce(false),
    })
    await flush()
    clock.sleeps[0]?.resolve()
    await flush()
    clock.fire(timerIndex(clock, 55))
    const run = await pending
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
  })
})
