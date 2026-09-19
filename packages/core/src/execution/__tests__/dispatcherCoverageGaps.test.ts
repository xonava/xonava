import { describe, expect, it, vi } from "vitest"
import { decodeJobPayload, dispatchDueJobs } from "../dispatcher"
import { createJobRegistry } from "../jobRegistry"
import { InvalidJobPayloadError, MalformedJobPayloadError } from "../types"
import type { JobDefinition, JobExecution, JobStore, StoredJob } from "../types"

function job(): StoredJob { return { id: "j", jobType: "job", jobVersion: 1, tenantId: null, scope: "system", executionScope: { kind: "system", systemKey: "framework" }, payload: "{}", status: "pending", priority: 0, attemptsCompleted: 0, currentAttempt: 1, maxAttempts: 1, runAt: new Date(), nextAttemptAt: null, leaseOwner: "w", leaseExpiresAt: new Date(), claimToken: "claim-1", idempotencyKey: null, fingerprint: "fp", correlationId: null, lastError: null, resultPayload: null, metadata: null, partitionKey: null, createdAt: new Date(), startedAt: new Date(), completedAt: null } }
function setup(execute: JobDefinition["execute"], definition: Partial<JobDefinition> = {}) {
  const stored = job()
  const markFailed = vi.fn(async () => ({ applied: true as const }))
  const store: JobStore = { enqueue: vi.fn(), getById: vi.fn(), getByCorrelationId: vi.fn(), getLatestPriorScheduleExecution: vi.fn(), getByIdempotencyKey: vi.fn(), claimDue: vi.fn(async () => [stored]), renewLease: vi.fn(async () => true), markSucceeded: vi.fn(async () => ({ applied: true as const })), markRetrying: vi.fn(async () => ({ applied: true as const })), markFailed, cancel: vi.fn(), findPending: vi.fn() }
  const registry = createJobRegistry()
  registry.register({ type: "job", version: 1, scope: "system", maxAttempts: 1, retryDelayMs: 0, retryBackoffMultiplier: 1, decodePayload: (input) => input as Record<string, unknown>, execute, ...definition })
  return { stored, store, registry, markFailed }
}

describe("dispatcher focused validation and result branches", () => {
  it("decodes object payloads and rejects malformed or invalid decoded values", () => {
    expect(decodeJobPayload<{ value: number }>("{\"value\":1}", (input) => input as { value: number })).toEqual({ value: 1 })
    expect(decodeJobPayload("{}")).toEqual({})
    expect(() => decodeJobPayload("bad")).toThrow(MalformedJobPayloadError)
    expect(() => decodeJobPayload("[]")).toThrow(MalformedJobPayloadError)
    expect(() => decodeJobPayload("{}", () => { throw new InvalidJobPayloadError("invalid") })).toThrow("invalid")
    expect(() => decodeJobPayload("{}", () => { throw new Error("schema") })).toThrow("schema")
    expect(() => decodeJobPayload("x".repeat(1_048_577))).toThrow(/exceeds the maximum/)
  })

  it("validates dispatcher options and handles unknown definitions and lease status", async () => {
    const empty = setup(async () => ({ success: true }))
    await expect(dispatchDueJobs({ store: empty.store, registry: empty.registry, workerId: " ", leaseDurationMs: 1, claimLimit: 1, requester: { scope: "system" } })).rejects.toThrow("workerId")
    await expect(dispatchDueJobs({ store: empty.store, registry: empty.registry, workerId: "w", leaseDurationMs: 1, claimLimit: 0, requester: { scope: "system" } })).rejects.toThrow("claimLimit")
    await expect(dispatchDueJobs({ store: empty.store, registry: empty.registry, workerId: "w", leaseDurationMs: 0, claimLimit: 1, requester: { scope: "system" } })).rejects.toThrow("leaseDuration")
    await expect(dispatchDueJobs({ store: empty.store, registry: empty.registry, workerId: "w", leaseDurationMs: 1, claimLimit: 1, requester: { scope: "system" }, timeoutPolicy: { mode: "cooperative", cancellationGraceMs: -1 } })).rejects.toThrow("cancellationGrace")
    await expect(dispatchDueJobs({ store: empty.store, registry: empty.registry, workerId: "w", leaseDurationMs: 1, claimLimit: 1, requester: { scope: "system" }, timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 0, timeoutMs: 0 } })).rejects.toThrow("timeoutMs")

    const unknown = setup(async () => ({ success: true }))
    unknown.stored.jobType = "missing"
    const unknownResult = await dispatchDueJobs({ store: unknown.store, registry: unknown.registry, workerId: "w", leaseDurationMs: 1, claimLimit: 1, requester: { scope: "system" } })
    expect(unknownResult.failed).toBe(1)

    ;(unknown.store.markFailed as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: false })
    const unknownLost = await dispatchDueJobs({ store: unknown.store, registry: unknown.registry, workerId: "w", leaseDurationMs: 1, claimLimit: 1, requester: { scope: "system" } })
    expect(unknownLost.leaseLost).toBe(1)
  })

  it("handles retry hooks, failed results, and unsuccessful completion status", async () => {
    const onRetry = vi.fn(async (context: JobExecution) => {
      expect(context.transitionToken).toBe("retry-transition")
      throw new Error("hook")
    })
    const retry = setup(async () => ({ success: false, error: new Error("try again") }), { maxAttempts: 2, onRetry })
    retry.stored.maxAttempts = 2
    ;(retry.store.markRetrying as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: true, transitionToken: "retry-transition" })
    const retryResult = await dispatchDueJobs({ store: retry.store, registry: retry.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(retryResult.retried).toBe(1)
    expect(onRetry).toHaveBeenCalledOnce()
    expect(retryResult.errors[0]?.error).toContain("onRetry hook failed")

    const failed = setup(async () => ({ success: false, data: { errorMessage: "failed" } }))
    const failedResult = await dispatchDueJobs({ store: failed.store, registry: failed.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(failedResult.deadLettered).toBe(1)
    ;(failed.store.markSucceeded as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: false })
    const success = setup(async () => ({ success: true, data: { ok: true } }))
    ;(success.store.markSucceeded as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: false })
    const statusResult = await dispatchDueJobs({ store: success.store, registry: success.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(statusResult.leaseLost).toBe(1)

    const maxHook = vi.fn(async (context: JobExecution) => {
      expect(context.transitionToken).toBe("max-transition")
      throw new Error("max hook")
    })
    const dead = setup(async () => ({ success: false, error: new Error("dead") }), { onMaxRetriesExceeded: maxHook })
    ;(dead.store.markFailed as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: true, transitionToken: "max-transition" })
    const deadResult = await dispatchDueJobs({ store: dead.store, registry: dead.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(deadResult.deadLettered).toBe(1)
    expect(maxHook).toHaveBeenCalledOnce()
    expect(deadResult.errors[0]?.error).toContain("onMaxRetriesExceeded hook failed")
  })

  it("dead-letters malformed jobs and reports failed state loss", async () => {
    const malformed = setup(async () => ({ success: true }))
    malformed.stored.payload = "not-json"
    const malformedResult = await dispatchDueJobs({ store: malformed.store, registry: malformed.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(malformedResult.deadLettered).toBe(1)

    const lost = setup(async () => ({ success: true }))
    ;(lost.store.markFailed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("failed transition"))
    lost.stored.payload = "not-json"
    const lostResult = await dispatchDueJobs({ store: lost.store, registry: lost.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(lostResult.leaseLost).toBe(1)
    expect(lostResult.errors[0]?.error).toBe("failed transition")

    const heartbeat = setup(async ({ signal }) => {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
      return { success: true }
    })
    const heartbeatResult = await dispatchDueJobs({
      store: heartbeat.store, registry: heartbeat.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" },
      clock: { now: () => new Date(), sleep: async () => { throw new Error("sleep failed") } },
    })
    expect(heartbeatResult.leaseLost).toBe(1)
  })

  it("reports lease loss when scope and retry-policy transitions cannot be applied", async () => {
    const scope = setup(async () => ({ success: true }))
    scope.stored.tenantId = "tenant-a"
    scope.stored.scope = "tenant"
    scope.stored.executionScope = { kind: "tenant", tenantId: "tenant-a" }
    ;(scope.store.markFailed as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: false })
    const scopeResult = await dispatchDueJobs({ store: scope.store, registry: scope.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(scopeResult.leaseLost).toBe(1)

    const policy = setup(async () => ({ success: true }))
    policy.stored.maxAttempts = 0
    ;(policy.store.markFailed as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: false })
    const policyResult = await dispatchDueJobs({ store: policy.store, registry: policy.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(policyResult.leaseLost).toBe(1)
  })

  it("reports lease loss when the immediate re-fence renewal fails", async () => {
    const lease = setup(async () => ({ success: true }))
    lease.store.renewLease = vi.fn(async () => { throw new Error("renewal failed") })

    const result = await dispatchDueJobs({ store: lease.store, registry: lease.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })

    expect(result).toMatchObject({ claimed: 1, leaseLost: 1, errors: [{ action: "lease_lost", error: "renewal failed" }] })
    expect(lease.registry.get("job", 1)).toBeDefined()
  })

  it("reports lease loss when the immediate re-fence is rejected", async () => {
    const lease = setup(async () => ({ success: true }))
    lease.store.renewLease = vi.fn(async () => false)

    const result = await dispatchDueJobs({ store: lease.store, registry: lease.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })

    expect(result.leaseLost).toBe(1)
    expect(result.errors[0]).toMatchObject({ action: "lease_lost", error: "Job lease was lost" })
  })

  it("does not execute a job whose lease has expired", async () => {
    const execute = vi.fn(async () => ({ success: true as const }))
    const expired = setup(execute)
    expired.stored.leaseExpiresAt = new Date(0)
    expired.store.renewLease = vi.fn(async () => false)

    const result = await dispatchDueJobs({ store: expired.store, registry: expired.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })

    expect(result.leaseLost).toBe(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it("does not execute a claim without a fencing token", async () => {
    const execute = vi.fn(async () => ({ success: true as const }))
    const missingToken = setup(execute)
    missingToken.stored.claimToken = null

    const result = await dispatchDueJobs({ store: missingToken.store, registry: missingToken.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })

    expect(result.leaseLost).toBe(1)
    expect(execute).not.toHaveBeenCalled()
    expect((missingToken.store.renewLease as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0)
  })

  it("enforces maxAttempts before decoding or executing the job", async () => {
    const execute = vi.fn(async () => ({ success: true as const }))
    const exhausted = setup(execute)
    exhausted.stored.currentAttempt = 2
    exhausted.stored.maxAttempts = 1
    exhausted.stored.payload = "not-json"
    const result = await dispatchDueJobs({ store: exhausted.store, registry: exhausted.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })

    expect(result.deadLettered).toBe(1)
    expect(execute).not.toHaveBeenCalled()
    expect(exhausted.markFailed).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "claim-1", attempt: 2, status: "dead_letter" }))
  })

  it("covers cancelled, non-retryable, and unsuccessful transition outcomes", async () => {
    const cancelled = setup(async () => ({ success: false, error: { kind: "cancelled", message: "cancelled" } as never }))
    const cancelledResult = await dispatchDueJobs({ store: cancelled.store, registry: cancelled.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(cancelledResult.failed).toBe(1)

    const retryNotApplied = setup(async () => ({ success: false, error: new Error("retry") }), { maxAttempts: 2 })
    retryNotApplied.stored.maxAttempts = 2
    ;(retryNotApplied.store.markRetrying as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: false })
    const retryResult = await dispatchDueJobs({ store: retryNotApplied.store, registry: retryNotApplied.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(retryResult.leaseLost).toBe(1)

    const failedNotApplied = setup(async () => ({ success: false, error: new Error("dead") }))
    ;(failedNotApplied.store.markFailed as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: false })
    const failedResult = await dispatchDueJobs({ store: failedNotApplied.store, registry: failedNotApplied.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(failedResult.leaseLost).toBe(1)

    const fallback = setup(async () => ({ success: false }))
    delete fallback.stored.maxAttempts
    const fallbackResult = await dispatchDueJobs({ store: fallback.store, registry: fallback.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(fallbackResult.deadLettered).toBe(1)
  })

  it("reports cancellation as lease loss when the cancelled transition is not applied", async () => {
    const cancelled = setup(async () => ({ success: false, error: { kind: "cancelled", message: "cancelled" } as never }))
    ;(cancelled.store.markFailed as ReturnType<typeof vi.fn>).mockResolvedValue({ applied: false })

    const result = await dispatchDueJobs({
      store: cancelled.store,
      registry: cancelled.registry,
      workerId: "w",
      leaseDurationMs: 10,
      claimLimit: 1,
      requester: { scope: "system" },
    })

    expect(result.leaseLost).toBe(1)
    expect(result.errors[0]).toMatchObject({ action: "lease_lost", error: "Job lease was lost" })
  })

  it("waits for an in-flight execution after heartbeat lease loss", async () => {
    vi.useFakeTimers()
    let releaseExecution!: () => void
    const lost = setup(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        releaseExecution = resolve
        signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      return { success: true }
    })
    lost.store.renewLease = vi.fn(async () => false)
    const dispatch = dispatchDueJobs({
      store: lost.store,
      registry: lost.registry,
      workerId: "w",
      leaseDurationMs: 10,
      claimLimit: 1,
      requester: { scope: "system" },
      timeoutPolicy: { mode: "cooperative", timeoutMs: 100, cancellationGraceMs: 10 },
    })

    await vi.advanceTimersByTimeAsync(5)
    releaseExecution?.()
    const result = await dispatch
    expect(result.leaseLost).toBe(1)
    vi.useRealTimers()
  })

  it("reports a stalled job when it ignores cooperative cancellation", async () => {
    vi.useFakeTimers()
    const stalled = setup(async () => new Promise<never>(() => {}), { timeoutMs: 5 })
    const dispatch = dispatchDueJobs({ store: stalled.store, registry: stalled.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" }, timeoutPolicy: { mode: "cooperative", timeoutMs: 5, cancellationGraceMs: 3 } })
    await vi.advanceTimersByTimeAsync(10)
    const result = await dispatch
    expect(result.stalled).toBe(1)
    expect(result.errors[0]?.action).toBe("stalled")
  })

  it("dead-letters permanent failures and retries without an optional hook", async () => {
    const permanent = setup(async () => ({ success: false, error: { kind: "permanent", message: "permanent" } as never }))
    const permanentResult = await dispatchDueJobs({ store: permanent.store, registry: permanent.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(permanentResult.deadLettered).toBe(1)

    const retry = setup(async () => ({ success: false, error: new Error("retry") }), { maxAttempts: 2 })
    retry.stored.maxAttempts = 2
    const retryResult = await dispatchDueJobs({ store: retry.store, registry: retry.registry, workerId: "w", leaseDurationMs: 10, claimLimit: 1, requester: { scope: "system" } })
    expect(retryResult.retried).toBe(1)
  })
})
