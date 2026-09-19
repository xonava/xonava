import { afterEach, describe, expect, it, vi } from "vitest"
import { dispatchDueJobs } from "../dispatcher"
import { createJobRegistry } from "../jobRegistry"
import type { DispatcherClock } from "../dispatcher"
import { CancelledJobError, PermanentJobError } from "../types"
import type { JobDefinition, JobStore, StoredJob } from "../types"
import { RetryablePersistenceError } from "../../domain"

function makeJob(): StoredJob {
  return {
    id: "job-1",
    jobType: "test",
    jobVersion: 1,
    tenantId: null,
    executionScope: { kind: "system", systemKey: "framework" },
    scope: "system",
    payload: "{}",
    status: "pending",
    priority: 0,
    attemptsCompleted: 0,
    currentAttempt: 1,
    maxAttempts: 3,
    runAt: new Date(),
    nextAttemptAt: null,
    partitionKey: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date(Date.now() + 1_000),
    claimToken: "claim-1",
    idempotencyKey: null,
    fingerprint: "fp",
    correlationId: null,
    lastError: null,
    resultPayload: null,
    metadata: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
  }
}

function makeStore(job: StoredJob, markRetrying: JobStore["markRetrying"]): {
  store: JobStore
  markSucceeded: ReturnType<typeof vi.fn>
  markFailed: ReturnType<typeof vi.fn>
  markRetrying: JobStore["markRetrying"]
  renewLease: ReturnType<typeof vi.fn>
} {
  const markSucceeded = vi.fn(async () => ({ applied: true as const }))
  const markFailed = vi.fn(async () => ({ applied: true as const }))
  const renewLease = vi.fn(async () => true)
  return {
    store: {
      enqueue: vi.fn(),
      getById: vi.fn(),
      getByCorrelationId: vi.fn(),
      getLatestPriorScheduleExecution: vi.fn(),
      getByIdempotencyKey: vi.fn(),
      claimDue: vi.fn(async () => [job]),
      renewLease,
      markSucceeded,
      markRetrying,
      markFailed,
      cancel: vi.fn(),
      findPending: vi.fn(),
    },
    markSucceeded,
    markRetrying,
    markFailed,
    renewLease,
  }
}

function makeConfig(
  store: JobStore,
  execute: JobDefinition["execute"],
  clock?: DispatcherClock,
  retryPolicy?: Partial<Pick<JobDefinition, "maxAttempts" | "retryDelayMs" | "retryBackoffMultiplier">>,
  scope: JobDefinition["scope"] = "system",
) {
  const registry = createJobRegistry()
  registry.register({
    type: "test",
    version: 1,
    scope,
    maxAttempts: retryPolicy?.maxAttempts ?? 3,
    retryDelayMs: retryPolicy?.retryDelayMs ?? 0,
    retryBackoffMultiplier: retryPolicy?.retryBackoffMultiplier ?? 1,
    timeoutMs: 5,
    decodePayload(input) {
      return input as Record<string, unknown>
    },
    execute,
  })
  return {
    store,
    registry,
    workerId: "worker-1",
    leaseDurationMs: 100,
    claimLimit: 1,
    requester: { scope: "system" as const },
    ...(clock ? { clock } : {}),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("dispatchDueJobs timeout handling", () => {
  it("dead-letters a tenant definition when the stored job has platform scope without running it", async () => {
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markFailed } = makeStore(job, markRetrying)
    const execute = vi.fn(async () => ({ success: true }))

    const result = await dispatchDueJobs(makeConfig(store, execute, undefined, undefined, "tenant"))

    expect(result.deadLettered).toBe(1)
    expect(result.retried).toBe(0)
    expect(execute).not.toHaveBeenCalled()
    expect(markRetrying).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledOnce()
    expect(result.errors[0]?.action).toBe("dead_letter")
    expect(result.errors[0]?.error).toContain("scope mismatch")
  })

  it("dead-letters a platform definition when the stored job has tenant scope before decoding its payload", async () => {
    const job = { ...makeJob(), tenantId: "tenant-1", scope: "tenant" as const, executionScope: { kind: "tenant" as const, tenantId: "tenant-1" }, payload: "not-json" }
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markFailed } = makeStore(job, markRetrying)
    const execute = vi.fn(async () => ({ success: true }))

    const result = await dispatchDueJobs(makeConfig(store, execute, undefined, undefined, "platform"))

    expect(result.deadLettered).toBe(1)
    expect(execute).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledOnce()
    expect(result.errors[0]?.error).toContain("scope mismatch")
  })

  it("preserves tenant requester execution for a tenant-scoped stored job", async () => {
    const job = { ...makeJob(), tenantId: "tenant-1", scope: "tenant" as const, executionScope: { kind: "tenant" as const, tenantId: "tenant-1" } }
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store } = makeStore(job, markRetrying)
    const execute = vi.fn(async () => ({ success: true }))

    const result = await dispatchDueJobs({
      ...makeConfig(store, execute, undefined, undefined, "tenant"),
      requester: { scope: "tenant", tenantId: "tenant-1", actorId: "actor-1" },
    })

    expect(result.succeeded).toBe(1)
    expect(execute).toHaveBeenCalledOnce()
  })

  it("executes jobs with the shared context contract", async () => {
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store } = makeStore(job, markRetrying)
    const startedAt = new Date(2_000)
    let execution!: Parameters<JobDefinition["execute"]>[0]
    const execute = vi.fn(async (context: Parameters<JobDefinition["execute"]>[0]) => {
      execution = context
      return { success: true }
    })

    const result = await dispatchDueJobs({
      ...makeConfig(store, execute, { now: () => startedAt, sleep: () => new Promise(() => {}) }),
    })

    expect(result.succeeded).toBe(1)
    expect(execution).toMatchObject({
      jobId: job.id,
      jobType: job.jobType,
      jobVersion: job.jobVersion,
      attempt: job.currentAttempt,
      startedAt,
      deadline: 2_005,
      metadata: {},
      payload: {},
    })
    expect(typeof execution.executionId).toBe("string")
    expect(execution.clock?.now()).toBe(startedAt)
    expect(execution.signal).toBeInstanceOf(AbortSignal)
  })

  it("aborts cooperatively before marking a timed-out job retrying", async () => {
    vi.useFakeTimers()
    const job = makeJob()
    let sideEffectFinished = false
    const markRetrying = vi.fn(async () => {
      expect(sideEffectFinished).toBe(true)
      return { applied: true as const }
    })
    const { store, markSucceeded } = makeStore(job, markRetrying)
    const execute = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      sideEffectFinished = true
      return { success: true }
    })

    const dispatch = dispatchDueJobs(makeConfig(store, execute, { now: () => new Date(0), sleep: () => new Promise(() => {}) }))
    await vi.advanceTimersByTimeAsync(5)
    const result = await dispatch

    expect(result.retried).toBe(1)
    expect(markRetrying.mock.calls).toHaveLength(1)
    expect(markSucceeded).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledOnce()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.action).toBe("retry")
    expect(result.errors[0]?.error).toContain("timed out")
  })

  it("does not complete a job that resolves after its timeout", async () => {
    vi.useFakeTimers()
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markSucceeded } = makeStore(job, markRetrying)
    let finishExecution!: () => void
    const executionFinished = new Promise<void>((resolve) => { finishExecution = resolve })
    const execute = vi.fn(async () => {
      await executionFinished
      return { success: true }
    })

    const dispatch = dispatchDueJobs(makeConfig(store, execute, { now: () => new Date(0), sleep: () => new Promise(() => {}) }))
    await vi.advanceTimersByTimeAsync(5)
    finishExecution()
    const result = await dispatch

    expect(result.retried).toBe(1)
    expect(markRetrying.mock.calls).toHaveLength(1)
    expect(markSucceeded).not.toHaveBeenCalled()
    expect(result.errors[0]?.action).toBe("retry")
  })

  it("reports lease loss when a heartbeat renewal is rejected", async () => {
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markSucceeded, renewLease } = makeStore(job, markRetrying)
    renewLease.mockResolvedValueOnce(true).mockResolvedValue(false)

    const execute = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      return { success: true }
    })
    let firstSleep = true
    const result = await dispatchDueJobs(makeConfig(store, execute, {
      now: () => new Date(1_000),
      sleep: async () => {
        if (firstSleep) {
          firstSleep = false
          return
        }
        await new Promise(() => {})
      },
    }))

    expect(result.leaseLost).toBe(1)
    expect(result.errors[0]?.action).toBe("lease_lost")
    expect(markSucceeded).not.toHaveBeenCalled()
    expect(markRetrying.mock.calls).toHaveLength(0)
  })

  it("waits for a non-cooperative execution to settle after lease loss", async () => {
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markSucceeded, renewLease } = makeStore(job, markRetrying)
    renewLease.mockResolvedValueOnce(true).mockResolvedValue(false)
    let releaseExecution!: () => void
    const executionFinished = new Promise<void>((resolve) => { releaseExecution = resolve })
    let executionSettled = false
    const execute = vi.fn(async () => {
      await executionFinished
      executionSettled = true
      return { success: true }
    })
    let firstSleep = true
    const dispatch = dispatchDueJobs(makeConfig(store, execute, {
      now: () => new Date(1_000),
      sleep: async () => {
        if (firstSleep) firstSleep = false
        else await new Promise(() => {})
      },
    }))

    await Promise.resolve()
    await Promise.resolve()
    expect(executionSettled).toBe(false)
    expect(markSucceeded).not.toHaveBeenCalled()

    releaseExecution()
    const result = await dispatch
    expect(result.leaseLost).toBe(1)
    expect(executionSettled).toBe(true)
    expect(markSucceeded).not.toHaveBeenCalled()
  })

  it("returns after the lease settlement bound when execution never settles", async () => {
    vi.useFakeTimers()
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markSucceeded, renewLease } = makeStore(job, markRetrying)
    renewLease.mockResolvedValue(false)
    const execute = vi.fn(async () => new Promise<never>(() => {}))
    let firstSleep = true
    const dispatch = dispatchDueJobs(makeConfig(store, execute, {
      now: () => new Date(1_000),
      sleep: async () => {
        if (firstSleep) firstSleep = false
        else await new Promise(() => {})
      },
    }))

    await vi.advanceTimersByTimeAsync(100)
    const result = await dispatch
    expect(result.leaseLost).toBe(1)
    expect(markSucceeded).not.toHaveBeenCalled()
  })

  it("records a completion failure and continues with other jobs", async () => {
    const firstJob = makeJob()
    const secondJob = { ...firstJob, id: "job-2" }
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markSucceeded } = makeStore(firstJob, markRetrying)
    store.claimDue = vi.fn(async () => [firstJob, secondJob])
    markSucceeded.mockRejectedValueOnce(new Error("completion unavailable"))

    const result = await dispatchDueJobs(makeConfig(store, vi.fn(async () => ({ success: true }))))

    expect(result.leaseLost).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(result.errors).toEqual([expect.objectContaining({ jobId: "job-1", action: "lease_lost", error: "completion unavailable" })])
  })

  it("records retry and failure transition errors without stopping the batch", async () => {
    const firstJob = makeJob()
    const secondJob = { ...firstJob, id: "job-2", attemptsCompleted: 2, currentAttempt: 3 }
    const thirdJob = { ...secondJob, id: "job-3" }
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markFailed } = makeStore(firstJob, markRetrying)
    store.claimDue = vi.fn(async () => [firstJob, secondJob, thirdJob])
    markRetrying.mockRejectedValueOnce(new Error("retry unavailable"))
    markFailed.mockRejectedValueOnce(new Error("failure unavailable"))
    const execute = vi.fn(async () => ({ success: false, data: { errorMessage: "still failing" } }))

    const result = await dispatchDueJobs(makeConfig(store, execute))

    expect(result.leaseLost).toBe(2)
    expect(result.deadLettered).toBe(1)
    expect(result.errors).toEqual([
      expect.objectContaining({ jobId: "job-1", action: "lease_lost", error: "retry unavailable" }),
      expect.objectContaining({ jobId: "job-2", action: "lease_lost", error: "failure unavailable" }),
      expect.objectContaining({ jobId: "job-3", action: "dead_letter", error: "still failing" }),
    ])
  })

  it("dead-letters an invalid retry policy without stopping the batch", async () => {
    const firstJob = { ...makeJob(), maxAttempts: 0 }
    const secondJob = { ...firstJob, id: "job-2", maxAttempts: 3 }
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markFailed, markSucceeded } = makeStore(firstJob, markRetrying)
    store.claimDue = vi.fn(async () => [firstJob, secondJob])
    const execute = vi.fn(async () => ({ success: true }))

    const result = await dispatchDueJobs(makeConfig(store, execute))

    expect(result.deadLettered).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(result.leaseLost).toBe(0)
    expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({
      status: "dead_letter",
      error: "Invalid retry policy: maxAttempts must be a finite integer >= 1",
    }))
    expect(markSucceeded).toHaveBeenCalledOnce()
    expect(result.errors).toEqual([
      expect.objectContaining({
        jobId: firstJob.id,
        action: "dead_letter",
        error: "Invalid retry policy: maxAttempts must be a finite integer >= 1",
      }),
    ])
  })

  it("preserves permanent and cancelled semantics with an invalid retry policy", async () => {
    const permanentJob = makeJob()
    const cancelledJob = { ...permanentJob, id: "job-2", maxAttempts: 3 }
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markFailed } = makeStore(permanentJob, markRetrying)
    store.claimDue = vi.fn(async () => [permanentJob, cancelledJob])
    const execute = vi.fn()
      .mockResolvedValueOnce({ success: false as const, error: new PermanentJobError("invalid input") })
      .mockResolvedValueOnce({ success: false as const, error: new CancelledJobError("cancelled by requester") })

    const result = await dispatchDueJobs(makeConfig(store, execute))

    expect(result.failed).toBe(1)
    expect(result.deadLettered).toBe(1)
    expect(markRetrying).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: "dead_letter", error: "invalid input" }))
    expect(markFailed).toHaveBeenNthCalledWith(2, expect.objectContaining({ status: "cancelled", error: "cancelled by requester" }))
  })

  it("renews the lease before completing a long-running job", async () => {
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markSucceeded, renewLease } = makeStore(job, markRetrying)
    let renewed!: () => void
    const renewalObserved = new Promise<void>((resolve) => { renewed = resolve })
    renewLease.mockImplementation(async () => {
      renewed()
      return true
    })

    const execute = vi.fn(async () => {
      await renewalObserved
      return { success: true }
    })
    let firstSleep = true
    const result = await dispatchDueJobs(makeConfig(store, execute, {
      now: () => new Date(2_000),
      sleep: async () => {
        if (firstSleep) {
          firstSleep = false
          return
        }
        await new Promise(() => {})
      },
    }))

    expect(result.succeeded).toBe(1)
    expect(renewLease.mock.calls).toHaveLength(2)
    expect(renewLease.mock.calls[0]?.[0]).toMatchObject({ jobId: job.id, workerId: "worker-1", claimToken: "claim-1" })
    expect(markSucceeded).toHaveBeenCalledOnce()
    expect(markSucceeded).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "claim-1" }))
  })

  it("dead-letters a retryable failure at maxAttempts", async () => {
    const job = { ...makeJob(), attemptsCompleted: 2, currentAttempt: 3 }
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markSucceeded, markFailed } = makeStore(job, markRetrying)
    const execute = vi.fn(async () => ({ success: false, data: { errorMessage: "still failing" } }))

    const result = await dispatchDueJobs(makeConfig(store, execute, { now: () => new Date(3_000), sleep: () => new Promise(() => {}) }))

    expect(result.deadLettered).toBe(1)
    expect(result.retried).toBe(0)
    expect(markRetrying).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({ status: "dead_letter", attempt: 3 }))
    expect(markSucceeded).not.toHaveBeenCalled()
  })

  it("retries a retryable persistence failure", async () => {
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markRetrying: retry } = makeStore(job, markRetrying)
    const execute = vi.fn(async () => {
      throw new RetryablePersistenceError("Deadlock detected — retry the operation", { postgresCode: "40P01" })
    })

    const result = await dispatchDueJobs(makeConfig(store, execute))

    expect(result.retried).toBe(1)
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ error: "Deadlock detected — retry the operation" }))
  })

  it("uses a stored maxAttempts override instead of the definition default", async () => {
    const job = { ...makeJob(), maxAttempts: 1 }
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markFailed } = makeStore(job, markRetrying)
    const execute = vi.fn(async () => ({ success: false, data: { errorMessage: "still failing" } }))

    const result = await dispatchDueJobs(makeConfig(store, execute))

    expect(result.deadLettered).toBe(1)
    expect(result.retried).toBe(0)
    expect(markRetrying).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({ status: "dead_letter", attempt: 1 }))
  })

  it("dead-letters invalid persisted maxAttempts and continues the batch", async () => {
    const invalidJob = { ...makeJob(), id: "invalid-job", maxAttempts: 0 }
    const validJob = { ...makeJob(), id: "valid-job" }
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markFailed, markSucceeded } = makeStore(invalidJob, markRetrying)
    store.claimDue = vi.fn(async () => [invalidJob, validJob])
    const execute = vi.fn(async () => ({ success: true }))

    const result = await dispatchDueJobs(makeConfig(store, execute))

    expect(result.deadLettered).toBe(1)
    expect(result.succeeded).toBe(1)
    expect(execute).toHaveBeenCalledOnce()
    expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "invalid-job",
      status: "dead_letter",
      attempt: 1,
    }))
    expect(markSucceeded).toHaveBeenCalledWith(expect.objectContaining({ jobId: "valid-job" }))
  })

  it("dead-letters a permanent failed result without retrying", async () => {
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markRetrying: retry, markFailed } = makeStore(job, markRetrying)
    const execute = vi.fn(async () => ({ success: false as const, error: new PermanentJobError("invalid input") }))

    const result = await dispatchDueJobs(makeConfig(store, execute))

    expect(result.deadLettered).toBe(1)
    expect(result.retried).toBe(0)
    expect(retry).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({ status: "dead_letter", error: "invalid input" }))
  })

  it("marks a cancelled failed result as cancelled without retrying", async () => {
    const job = makeJob()
    const markRetrying = vi.fn(async () => ({ applied: true as const }))
    const { store, markRetrying: retry, markFailed } = makeStore(job, markRetrying)
    const execute = vi.fn(async () => ({ success: false as const, error: new CancelledJobError("cancelled by requester") }))

    const result = await dispatchDueJobs(makeConfig(store, execute))

    expect(result.failed).toBe(1)
    expect(result.retried).toBe(0)
    expect(retry).not.toHaveBeenCalled()
    expect(markFailed).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled", error: "cancelled by requester" }))
  })
})
