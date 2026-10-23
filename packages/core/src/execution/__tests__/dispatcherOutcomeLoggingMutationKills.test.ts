import { describe, expect, it, vi } from "vitest"
import { dispatchDueJobs } from "../dispatcher"
import { createJobRegistry } from "../jobRegistry"
import type { JobExecution } from "../types"
import { baseConfig, definition, fakeClock, makeStore, NOW, runOnce, storedJob, type RunOutcome } from "./executionMutationHarness"

const jobFields = { jobId: "job-1", jobType: "job" }

function warnings(run: RunOutcome, message: string) { return run.rec.find(message).map((record) => ({ ...record })) }

describe("dispatch tick logging", () => {
  it("logs an empty tick with its counts, worker and the clock reading", async () => {
    const run = await runOnce({ jobs: [], noDefinition: true })
    expect(run.result).toEqual({ claimed: 0, succeeded: 0, failed: 0, retried: 0, deadLettered: 0, leaseLost: 0, stalled: 0, errors: [] })
    expect(run.rec.records()).toEqual([
      { severity: "info", message: "Dispatch claimed jobs", workerId: "w1", claimed: 0, claimLimit: 5 },
      { severity: "debug", message: "No jobs to dispatch", workerId: "w1" },
      { severity: "info", message: "Dispatch batch completed", workerId: "w1", claimed: 0, succeeded: 0, failed: 0, retried: 0, deadLettered: 0, leaseLost: 0, stalled: 0 },
    ])
    expect(run.rec.events.every((event) => event.name === "execution.dispatch")).toBe(true)
    expect(run.rec.events.every((event) => event.timestamp.getTime() === NOW.getTime())).toBe(true)
  })

  it("does not log the empty-tick message when a job was claimed", async () => {
    const run = await runOnce()
    expect(run.rec.find("No jobs to dispatch")).toEqual([])
    expect(run.rec.find("Dispatch claimed jobs")).toEqual([{ severity: "info", message: "Dispatch claimed jobs", workerId: "w1", claimed: 1, claimLimit: 5 }])
  })

  it("logs a plain success at debug level only and sends the exact completion", async () => {
    const run = await runOnce({ job: { currentAttempt: 2 } })
    expect(run.result).toMatchObject({ succeeded: 1, errors: [] })
    expect(run.rec.records().filter((record) => record.severity !== "info" || record.message !== "Dispatch claimed jobs")[0]).toEqual({ severity: "debug", message: "Job succeeded", ...jobFields, attempt: 2 })
    expect(run.rec.records().filter((record) => record.severity === "warn" || record.severity === "error")).toEqual([])
    expect(run.mocks.markSucceeded.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", attempt: 2 }]])
    expect(run.rec.find("Dispatch batch completed")).toEqual([{ severity: "info", message: "Dispatch batch completed", workerId: "w1", claimed: 1, succeeded: 1, failed: 0, retried: 0, deadLettered: 0, leaseLost: 0, stalled: 0 }])
  })

  it("persists the handler result data with the completion", async () => {
    const run = await runOnce({ definition: { execute: async () => ({ success: true, data: { total: 3 } }) } })
    expect(run.mocks.markSucceeded.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", attempt: 1, result: { total: 3 } }]])
  })

  it("surfaces a history error of a successful completion at warn level", async () => {
    const run = await runOnce({ prepare: (mocks) => mocks.markSucceeded.mockResolvedValue({ applied: true, historyError: "audit write failed" }) })
    expect(run.result.succeeded).toBe(1)
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "audit write failed", action: "failed" }])
    expect(warnings(run, "Job succeeded but history failed")).toEqual([{ severity: "warn", message: "Job succeeded but history failed", jobId: "job-1", historyError: "audit write failed" }])
    expect(warnings(run, "Job succeeded with history error")).toEqual([{ severity: "warn", message: "Job succeeded with history error", ...jobFields, error: "audit write failed" }])
    expect(run.rec.find("Job succeeded")).toEqual([])
  })

  it("reports a completion the store did not apply as a lost lease", async () => {
    const run = await runOnce({ prepare: (mocks) => mocks.markSucceeded.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }) })
    expect(run.result).toMatchObject({ leaseLost: 1, succeeded: 0 })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
    expect(warnings(run, "Job markSucceeded not applied; lease lost")).toEqual([{ severity: "warn", message: "Job markSucceeded not applied; lease lost", jobId: "job-1", claimToken: "[REDACTED]", reason: "LEASE_LOST" }])
    expect(warnings(run, "Job lease lost")).toEqual([{ severity: "warn", message: "Job lease lost", ...jobFields, claimToken: "[REDACTED]", error: "Job lease was lost" }])
  })

  it("reports a completion that throws as a lost lease with the store message", async () => {
    const run = await runOnce({ prepare: (mocks) => mocks.markSucceeded.mockRejectedValue(new Error("db gone")) })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "db gone", action: "lease_lost" }])
    expect(run.rec.find("Job markSucceeded threw")).toEqual([{ severity: "error", message: "Job markSucceeded threw", jobId: "job-1", error: "db gone", claimToken: "[REDACTED]" }])
  })

  it("fails permanently, once, a result that cannot be serialised", async () => {
    const run = await runOnce({ definition: { execute: async () => ({ success: true, data: { big: 1n as never } }) } })
    expect(run.mocks.markSucceeded).not.toHaveBeenCalled()
    expect(run.result.deadLettered).toBe(1)
    expect(run.result.errors[0]?.error).toMatch(/^Job result is not JSON-serializable: .*BigInt/)
    expect(run.mocks.markRetrying).not.toHaveBeenCalled()
  })
})

describe("failure handling", () => {
  const permanent = (message: string) => Object.assign(new Error(message), { kind: "permanent" as const })
  const cancelled = (message: string) => Object.assign(new Error(message), { kind: "cancelled" as const })

  it("dead-letters a permanent failure and logs it as failed", async () => {
    const run = await runOnce({ definition: { execute: async () => ({ success: false, error: permanent("fatal") }) }, job: { attemptsCompleted: 1, currentAttempt: 2 } })
    expect(run.result).toMatchObject({ deadLettered: 1, failed: 0 })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "fatal", action: "dead_letter" }])
    expect(run.mocks.markFailed.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", error: "fatal", status: "dead_letter", attempt: 2 }]])
    expect(run.rec.find("Job failed")).toEqual([{ severity: "error", message: "Job failed", ...jobFields, kind: "dead_letter", error: "fatal" }])
  })

  it("records a cancelled job as failed with the cancelled status", async () => {
    const run = await runOnce({ definition: { execute: async () => ({ success: false, error: cancelled("stopped by user") }) }, job: { attemptsCompleted: 2, currentAttempt: 3 } })
    expect(run.result).toMatchObject({ failed: 1, deadLettered: 0 })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "stopped by user", action: "failed" }])
    expect(run.mocks.markFailed.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", error: "stopped by user", status: "cancelled", attempt: 3 }]])
    expect(run.rec.find("Job failed")).toEqual([{ severity: "error", message: "Job failed", ...jobFields, kind: "failed", error: "stopped by user" }])
    expect(run.rec.find("Job cancelled transition not applied")).toEqual([])
  })

  it("reports an unapplied cancellation as a lost lease with the store's reason", async () => {
    const run = await runOnce({
      definition: { execute: async () => ({ success: false, error: cancelled("stopped") }) },
      prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }),
    })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
    expect(run.rec.find("Job cancelled transition not applied")).toEqual([{ severity: "warn", message: "Job cancelled transition not applied", jobId: "job-1", error: "Job lease was lost", claimToken: "[REDACTED]" }])
  })

  it("retries a retryable failure with the backoff of the attempt, at the dispatcher clock", async () => {
    const first = await runOnce({ definition: { execute: async () => ({ success: false, error: new Error("boom") }) } })
    expect(first.result).toMatchObject({ retried: 1 })
    expect(first.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "boom", action: "retry" }])
    expect(first.mocks.markRetrying.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", nextAttemptAt: new Date(NOW.getTime() + 100), error: "boom", attempt: 1 }]])
    expect(first.rec.find("Job will retry")).toEqual([{ severity: "info", message: "Job will retry", ...jobFields, attempt: 1, nextAttemptAt: new Date(NOW.getTime() + 100).toISOString() }])

    const second = await runOnce({ definition: { execute: async () => ({ success: false, error: new Error("boom") }) }, job: { attemptsCompleted: 1, currentAttempt: 2 } })
    expect(second.mocks.markRetrying.mock.calls[0]?.[0]).toMatchObject({ nextAttemptAt: new Date(NOW.getTime() + 200), attempt: 2 })
  })

  it("does not treat a retry with an empty message as a success or an error", async () => {
    const run = await runOnce({ definition: { execute: async () => { throw new Error("") } } })
    expect(run.result).toMatchObject({ retried: 1, succeeded: 0, errors: [] })
    expect(run.rec.find("Job succeeded")).toEqual([])
    expect(run.rec.find("Job succeeded with history error")).toEqual([])
    expect(run.rec.find("Job failed")).toEqual([])
    expect(run.rec.find("Job lease lost")).toEqual([])
    expect(run.rec.find("Job retried with history error")).toEqual([])
  })

  it("logs a retry history error in both places, and only when the text mentions history", async () => {
    const execute = async () => { throw new Error("boom") }
    const withHistory = await runOnce({ definition: { execute }, prepare: (mocks) => mocks.markRetrying.mockResolvedValue({ applied: true, historyError: "history store down" }) })
    expect(withHistory.result.retried).toBe(1)
    expect(withHistory.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "history store down", action: "retry" }])
    expect(warnings(withHistory, "Job retry history error")).toEqual([{ severity: "warn", message: "Job retry history error", jobId: "job-1", historyError: "history store down" }])
    expect(warnings(withHistory, "Job retried with history error")).toEqual([{ severity: "warn", message: "Job retried with history error", jobId: "job-1", error: "history store down" }])
    expect(withHistory.rec.find("Job will retry")).toEqual([])

    const without = await runOnce({ definition: { execute }, prepare: (mocks) => mocks.markRetrying.mockResolvedValue({ applied: true, historyError: "audit write failed" }) })
    expect(warnings(without, "Job retry history error")).toHaveLength(1)
    expect(without.rec.find("Job retried with history error")).toEqual([])
    const plain = await runOnce({ definition: { execute } })
    expect(plain.rec.find("Job retried with history error")).toEqual([])
  })

  it("skips the onRetry hook when the retry history could not be persisted", async () => {
    const onRetry = vi.fn(async () => undefined)
    await runOnce({ definition: { execute: async () => { throw new Error("boom") }, onRetry }, prepare: (mocks) => mocks.markRetrying.mockResolvedValue({ applied: true, historyError: "h" }) })
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("reports a retry the store did not apply as a lost lease", async () => {
    const run = await runOnce({ definition: { execute: async () => { throw new Error("boom") } }, prepare: (mocks) => mocks.markRetrying.mockResolvedValue({ applied: false, reason: "INVALID_STATE" }) })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "boom", action: "lease_lost" }])
    expect(run.rec.find("Job markRetrying not applied; lease lost")).toEqual([{ severity: "warn", message: "Job markRetrying not applied; lease lost", jobId: "job-1", claimToken: "[REDACTED]", reason: "INVALID_STATE" }])
    expect(run.rec.find("Job will retry")).toEqual([])
  })

  it("reports a retry that throws as a lost lease", async () => {
    const run = await runOnce({ definition: { execute: async () => { throw new Error("boom") } }, prepare: (mocks) => mocks.markRetrying.mockRejectedValue(new Error("retry write failed")) })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "retry write failed", action: "lease_lost" }])
    expect(run.rec.find("Job markRetrying threw")).toEqual([{ severity: "error", message: "Job markRetrying threw", jobId: "job-1", error: "retry write failed", claimToken: "[REDACTED]" }])
  })

  it("runs onRetry after the transition with the transition token, once the claim is fenced off", async () => {
    let seen: JobExecution | undefined
    let fenced = ""
    let hookError: Error | undefined
    const onRetry = async (execution: JobExecution, error: Error): Promise<void> => {
      seen = execution
      hookError = error
      try {
        await execution.fencedEffect.execute({ effectName: "late", idempotencyKey: "k", fn: async () => "ran" })
        fenced = "allowed"
      } catch (fenceError) {
        fenced = (fenceError as Error).message
      }
    }
    const run = await runOnce({
      definition: { execute: async () => { throw new Error("boom") }, onRetry },
      prepare: (mocks) => mocks.markRetrying.mockResolvedValue({ applied: true, transitionToken: "tok-1" }),
    })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "boom", action: "retry" }])
    expect(seen?.transitionToken).toBe("tok-1")
    expect(hookError?.message).toBe("boom")
    expect(fenced).toBe("Job lease was lost: the claim is no longer active")
  })

  it("leaves the transition token off the context when the store gave none", async () => {
    let hasToken = true
    const onRetry = async (execution: JobExecution): Promise<void> => { hasToken = "transitionToken" in execution }
    await runOnce({ definition: { execute: async () => { throw new Error("boom") }, onRetry } })
    expect(hasToken).toBe(false)
  })

  it("keeps a retry that succeeded when the onRetry hook fails, and reports the hook failure", async () => {
    const run = await runOnce({ definition: { execute: async () => { throw new Error("boom") }, onRetry: async () => { throw new Error("hook broke") } } })
    expect(run.result.retried).toBe(1)
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "boom; onRetry hook failed: hook broke", action: "retry" }])
    expect(run.rec.find("onRetry hook failed")).toEqual([{ severity: "error", message: "onRetry hook failed", jobId: "job-1", error: "hook broke" }])
  })

  it("does not run a missing onRetry hook", async () => {
    const run = await runOnce({ definition: { execute: async () => { throw new Error("boom") } } })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "boom", action: "retry" }])
    expect(run.rec.find("onRetry hook failed")).toEqual([])
  })

  it("dead-letters when the attempt budget is spent, after the transition and with the token", async () => {
    let seen: JobExecution | undefined
    let fenced = ""
    const onMaxRetriesExceeded = async (execution: JobExecution, error: Error): Promise<void> => {
      seen = execution
      expect(error.message).toBe("boom")
      try {
        await execution.fencedEffect.execute({ effectName: "late", idempotencyKey: "k", fn: async () => "ran" })
        fenced = "allowed"
      } catch (fenceError) {
        fenced = (fenceError as Error).message
      }
    }
    const run = await runOnce({
      definition: { execute: async () => { throw new Error("boom") }, onMaxRetriesExceeded },
      job: { maxAttempts: 1 },
      prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: true, transitionToken: "tok-2" }),
    })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "boom", action: "dead_letter" }])
    expect(run.mocks.markFailed.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", error: "boom", status: "dead_letter", attempt: 1 }]])
    expect(seen?.transitionToken).toBe("tok-2")
    expect(fenced).toBe("Job lease was lost: the claim is no longer active")
  })

  it("leaves the token off the context of onMaxRetriesExceeded when the store gave none", async () => {
    let hasToken = true
    const onMaxRetriesExceeded = async (execution: JobExecution): Promise<void> => { hasToken = "transitionToken" in execution }
    await runOnce({ definition: { execute: async () => { throw new Error("boom") }, onMaxRetriesExceeded }, job: { maxAttempts: 1 } })
    expect(hasToken).toBe(false)
  })

  it("reports a failing onMaxRetriesExceeded hook without losing the dead-letter", async () => {
    const run = await runOnce({
      definition: { execute: async () => { throw new Error("boom") }, onMaxRetriesExceeded: async () => { throw new Error("hook broke") } },
      job: { maxAttempts: 1 },
    })
    expect(run.result.deadLettered).toBe(1)
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "boom; onMaxRetriesExceeded hook failed: hook broke", action: "dead_letter" }])
    expect(run.rec.find("onMaxRetriesExceeded hook failed")).toEqual([{ severity: "error", message: "onMaxRetriesExceeded hook failed", jobId: "job-1", error: "hook broke" }])
  })

  it("appends a dead-letter history error to the failure and skips the hook", async () => {
    const onMaxRetriesExceeded = vi.fn(async () => undefined)
    const run = await runOnce({
      definition: { execute: async () => { throw new Error("boom") }, onMaxRetriesExceeded },
      job: { maxAttempts: 1 },
      prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: true, historyError: "history lost" }),
    })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "boom; history lost", action: "dead_letter" }])
    expect(warnings(run, "Job dead_letter history error")).toEqual([{ severity: "warn", message: "Job dead_letter history error", jobId: "job-1", historyError: "history lost" }])
    expect(onMaxRetriesExceeded).not.toHaveBeenCalled()
  })

  it("does not log a dead-letter history error when there is none", async () => {
    const run = await runOnce({ definition: { execute: async () => { throw new Error("boom") } }, job: { maxAttempts: 1 } })
    expect(run.rec.find("Job dead_letter history error")).toEqual([])
  })

  it("reports a dead-letter the store did not apply, or that throws, as a lost lease", async () => {
    const notApplied = await runOnce({
      definition: { execute: async () => { throw new Error("boom") } },
      job: { maxAttempts: 1 },
      prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "INVALID_STATE" }),
    })
    expect(notApplied.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "boom", action: "lease_lost" }])
    expect(notApplied.rec.find("Job markFailed not applied; lease lost")).toEqual([{ severity: "warn", message: "Job markFailed not applied; lease lost", jobId: "job-1", claimToken: "[REDACTED]", reason: "INVALID_STATE" }])

    const thrown = await runOnce({
      definition: { execute: async () => { throw new Error("boom") } },
      job: { maxAttempts: 1 },
      prepare: (mocks) => mocks.markFailed.mockRejectedValue(new Error("fail write failed")),
    })
    expect(thrown.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "fail write failed", action: "lease_lost" }])
    expect(thrown.rec.find("Job markFailed threw")).toEqual([{ severity: "error", message: "Job markFailed threw", jobId: "job-1", error: "fail write failed", claimToken: "[REDACTED]" }])
  })

  it("bounds an over-long failure text before it reaches the store", async () => {
    const long = "e".repeat(40_000)
    const run = await runOnce({ definition: { execute: async () => { throw new Error(long) } }, job: { maxAttempts: 1 } })
    const stored = run.mocks.markFailed.mock.calls[0]?.[0].error ?? ""
    expect(new TextEncoder().encode(stored).byteLength).toBe(16 * 1024)
    expect(stored.endsWith("... [truncated]")).toBe(true)
    const retry = await runOnce({ definition: { execute: async () => { throw new Error(long) } } })
    expect(retry.mocks.markRetrying.mock.calls[0]?.[0].error).toBe(stored)
  })
})

describe("execution context handed to the handler", () => {
  async function capture(run: Parameters<typeof runOnce>[0]): Promise<{ context: JobExecution; run: RunOutcome }> {
    let context: JobExecution | undefined
    const outcome = await runOnce({
      ...run,
      definition: { ...run?.definition, execute: async (execution) => { context = execution; return { success: true } } },
    })
    return { context: context as JobExecution, run: outcome }
  }

  it("carries the job identity, scope, correlation, metadata and payload", async () => {
    const { context } = await capture({
      job: {
        id: "job-77", jobType: "job", jobVersion: 1, currentAttempt: 2, correlationId: "corr-1", metadata: { source: "api" },
        payload: '{"n":5}', executionScope: { kind: "tenant", tenantId: "tenant-9" }, scope: "tenant", tenantId: "tenant-9",
      },
      definition: { scope: "tenant" },
      config: { idGenerator: () => "exec-1" },
    })
    expect(context.executionId).toBe("exec-1")
    expect(context.jobId).toBe("job-77")
    expect(context.jobType).toBe("job")
    expect(context.jobVersion).toBe(1)
    expect(context.attempt).toBe(2)
    expect(context.tenantId).toBe("tenant-9")
    expect(context.executionScope).toEqual({ kind: "tenant", tenantId: "tenant-9" })
    expect(context.correlationId).toBe("corr-1")
    expect(context.metadata).toEqual({ source: "api" })
    expect(context.payload).toEqual({ n: 5 })
    expect(context.startedAt).toEqual(NOW)
    expect(context.deadline).toBe(NOW.getTime() + 900)
  })

  it("defaults the tenant, correlation and metadata, generates an id and passes the telemetry port", async () => {
    const { context, run } = await capture({})
    expect(context.tenantId).toBeNull()
    expect(context.correlationId).toBe("")
    expect(context.metadata).toEqual({})
    expect(context.executionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(context.telemetry).toBe(run.rec.port)
    expect(context.signal).toBeInstanceOf(AbortSignal)
    expect(context.signal?.aborted).toBe(false)
  })

  it("gives a platform job no tenant and omits the telemetry key without a port", async () => {
    let context: JobExecution | undefined
    const { store, mocks } = makeStore([storedJob({ executionScope: { kind: "platform", platformKey: "main" }, scope: "platform" })])
    const registry = createJobRegistry()
    registry.register(definition({ scope: "platform", execute: async (execution) => { context = execution; return { success: true } } }))
    await dispatchDueJobs(baseConfig(store, registry, { clock: fakeClock() }))
    expect(mocks.markSucceeded).toHaveBeenCalledOnce()
    expect(context?.tenantId).toBeNull()
    expect("telemetry" in (context as JobExecution)).toBe(false)
  })

  it("aborts the signal with the deadline error when the execution times out", async () => {
    const clock = fakeClock()
    let reason: unknown
    let release!: () => void
    const run = runOnce({
      config: { clock },
      definition: {
        execute: (execution) => new Promise((resolve) => {
          release = () => resolve({ success: true })
          execution.signal?.addEventListener("abort", () => { reason = execution.signal?.reason; setImmediate(() => resolve({ success: false, error: new Error("aborted") })) })
        }),
      },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const timeoutTimer = clock.timers.findIndex((timer) => timer.ms === 900 && !timer.cleared)
    expect(timeoutTimer).toBeGreaterThanOrEqual(0)
    clock.fire(timeoutTimer)
    const outcome = await run
    release()
    expect((reason as Error).message).toBe("Job job-1 timed out after 900ms")
    expect(outcome.result.errors[0]).toMatchObject({ error: "Job job-1 timed out after 900ms", action: "retry" })
  })
})

describe("fake clock sanity", () => {
  it("returns the configured start and advances by the step", () => {
    const clock = fakeClock({ step: 5 })
    expect(clock.now()).toEqual(NOW)
    expect(clock.now().getTime()).toBe(NOW.getTime() + 5)
  })
})
