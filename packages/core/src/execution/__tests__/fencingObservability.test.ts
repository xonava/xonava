import { describe, expect, it, vi } from "vitest"
import { dispatchDueJobs } from "../dispatcher"
import { createJobRegistry } from "../jobRegistry"
import { createExecutionContext } from "../executionContext"
import { materializeDueSchedules } from "../scheduleDispatcher"
import type { JobStore, StoredJob } from "../types"
import type { FencedScheduleClaim, ScheduleStore } from "../scheduleStore"
import { assertFencedScheduleClaim } from "../scheduleStore"

function makeStoredJob(overrides: Partial<StoredJob> = {}): StoredJob {
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
    leaseExpiresAt: new Date(Date.now() + 10_000),
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
    ...overrides,
  }
}

describe("P1-08 fencing + P2-04 observability", () => {
  it("assertFencedScheduleClaim validates token presence", () => {
    expect(() => assertFencedScheduleClaim("tok", "sched-1")).not.toThrow()
    expect(() => assertFencedScheduleClaim(null, "sched-1")).toThrow("no claim token")
    expect(() => assertFencedScheduleClaim("", "sched-1")).toThrow("no claim token")
    expect(() => assertFencedScheduleClaim("   ", "sched-1")).toThrow("no claim token")
  })

  it("dispatcher logs claimed count and batch completion", async () => {
    const job = makeStoredJob()
    const store: JobStore = {
      enqueue: vi.fn(), getById: vi.fn(), getByCorrelationId: vi.fn(), getLatestPriorScheduleExecution: vi.fn(), getByIdempotencyKey: vi.fn(),
      claimDue: vi.fn(async () => [job]), renewLease: vi.fn(async () => true),
      markSucceeded: vi.fn(async () => ({ applied: true })), markRetrying: vi.fn(), markFailed: vi.fn(), cancel: vi.fn(), findPending: vi.fn(),
    }
    const registry = createJobRegistry()
    registry.register({ type: "test", version: 1, scope: "system", maxAttempts: 3, retryDelayMs: 0, retryBackoffMultiplier: 1, decodePayload: (i) => i as Record<string, unknown>, execute: async () => ({ success: true }) })
    const emit = vi.fn()
    const result = await dispatchDueJobs({ store, registry, workerId: "worker-1", leaseDurationMs: 100, claimLimit: 1, requester: { scope: "system" }, telemetry: { emit } })
    expect(result.succeeded).toBe(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "execution.dispatch", attributes: expect.objectContaining({ message: "Dispatch claimed jobs", workerId: "worker-1", claimed: 1 }) }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "execution.dispatch", attributes: expect.objectContaining({ message: "Dispatch batch completed" }) }))
  })

  it("dispatcher warns when claimed job has no claim token (fencing)", async () => {
    const job = makeStoredJob({ claimToken: null })
    const store: JobStore = {
      enqueue: vi.fn(), getById: vi.fn(), getByCorrelationId: vi.fn(), getLatestPriorScheduleExecution: vi.fn(), getByIdempotencyKey: vi.fn(),
      claimDue: vi.fn(async () => [job]), renewLease: vi.fn(async () => true),
      markSucceeded: vi.fn(), markRetrying: vi.fn(), markFailed: vi.fn(), cancel: vi.fn(), findPending: vi.fn(),
    }
    const registry = createJobRegistry()
    registry.register({ type: "test", version: 1, scope: "system", maxAttempts: 3, retryDelayMs: 0, retryBackoffMultiplier: 1, decodePayload: (i) => i as Record<string, unknown>, execute: vi.fn(async () => ({ success: true })) })
    const emit = vi.fn()
    const result = await dispatchDueJobs({ store, registry, workerId: "worker-1", leaseDurationMs: 100, claimLimit: 1, requester: { scope: "system" }, telemetry: { emit } })
    expect(result.leaseLost).toBe(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ severity: "warn", attributes: expect.objectContaining({ message: "Claimed job missing claim token" }) }))
  })

  it("dispatcher warns on re-fence rejection (heartbeat leaseLost)", async () => {
    const job = makeStoredJob()
    const store: JobStore = {
      enqueue: vi.fn(), getById: vi.fn(), getByCorrelationId: vi.fn(), getLatestPriorScheduleExecution: vi.fn(), getByIdempotencyKey: vi.fn(),
      claimDue: vi.fn(async () => [job]), renewLease: vi.fn(async () => false),
      markSucceeded: vi.fn(), markRetrying: vi.fn(), markFailed: vi.fn(), cancel: vi.fn(), findPending: vi.fn(),
    }
    const registry = createJobRegistry()
    registry.register({ type: "test", version: 1, scope: "system", maxAttempts: 3, retryDelayMs: 0, retryBackoffMultiplier: 1, decodePayload: (i) => i as Record<string, unknown>, execute: vi.fn(async () => ({ success: true })) })
    const emit = vi.fn()
    const result = await dispatchDueJobs({ store, registry, workerId: "worker-1", leaseDurationMs: 100, claimLimit: 1, requester: { scope: "system" }, telemetry: { emit } })
    expect(result.leaseLost).toBe(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ severity: "warn", attributes: expect.objectContaining({ message: "Job lease re-fence rejected" }) }))
  })

  it("scheduleDispatcher double-fences enqueue and logs occurrence enqueue", async () => {
    const claim: FencedScheduleClaim = {
      scheduleId: "sched-1", scope: "platform", executionScope: { kind: "platform", platformKey: "default" }, jobType: "test.job", jobVersion: 1, tenantId: null, payload: "{}", cronExpression: "0 * * * *", timezone: "UTC", overlapPolicy: { type: "allow" }, misfirePolicy: { type: "fire_now" }, nextRunAt: new Date("2026-08-01T10:00:00Z"), lastRunAt: null, lastStatus: null, claimToken: "claim-1",
    }
    const renewScheduleLease = vi.fn(async () => true)
    const advanceSchedule = vi.fn(async () => true)
    const enqueue = vi.fn(async () => ({ id: "job-1" }))
    const scheduleStore: ScheduleStore = { claimDueSchedules: vi.fn(async () => [claim]), advanceSchedule, releaseSchedule: vi.fn(async () => true), renewScheduleLease }
    const jobStore = {
      enqueue, getById: vi.fn(), getByCorrelationId: vi.fn(), getLatestPriorScheduleExecution: vi.fn(async () => null),
      getByIdempotencyKey: vi.fn(async () => null), claimDue: vi.fn(), renewLease: vi.fn(), markSucceeded: vi.fn(), markRetrying: vi.fn(), markFailed: vi.fn(), cancel: vi.fn(), findPending: vi.fn(),
    } as unknown as JobStore
    const emit = vi.fn()
    const now = new Date("2026-08-01T10:30:00Z")
    const result = await materializeDueSchedules({ scheduleStore, jobStore, workerId: "worker-1", now, telemetry: { emit } })
    expect(result.jobsEnqueued).toBe(1)
    // assertHeld called at least: before getByIdempotencyKey, after, and before final advance => >=3
    expect(renewScheduleLease.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ attributes: expect.objectContaining({ message: "Schedules claimed" }) }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ attributes: expect.objectContaining({ message: "Enqueueing schedule occurrence" }) }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ attributes: expect.objectContaining({ message: "Schedule advanced" }) }))
  })

  it("scheduleDispatcher logs best-effort advance failure", async () => {
    const claim: FencedScheduleClaim = {
      scheduleId: "sched-2", scope: "platform", executionScope: { kind: "platform", platformKey: "default" }, jobType: "test.job", jobVersion: 1, tenantId: null, payload: "not-json", cronExpression: "0 * * * *", timezone: "UTC", overlapPolicy: { type: "allow" }, misfirePolicy: { type: "fire_now" }, nextRunAt: new Date("2026-08-01T10:00:00Z"), lastRunAt: null, lastStatus: null, claimToken: "claim-2",
    }
    const scheduleStore: ScheduleStore = {
      claimDueSchedules: vi.fn(async () => [claim]),
      advanceSchedule: vi.fn(async () => { throw new Error("best-effort failed") }),
      releaseSchedule: vi.fn(async () => true),
      renewScheduleLease: vi.fn(async () => true),
    }
    const jobStore = {
      enqueue: vi.fn(), getById: vi.fn(), getByCorrelationId: vi.fn(), getLatestPriorScheduleExecution: vi.fn(async () => null),
      getByIdempotencyKey: vi.fn(async () => null), claimDue: vi.fn(), renewLease: vi.fn(), markSucceeded: vi.fn(), markRetrying: vi.fn(), markFailed: vi.fn(), cancel: vi.fn(), findPending: vi.fn(),
    } as unknown as JobStore
    const emit = vi.fn()
    const result = await materializeDueSchedules({ scheduleStore, jobStore, workerId: "worker-1", now: new Date("2026-08-01T10:30:00Z"), telemetry: { emit } })
    expect(result.errors[0]).toContain("not valid JSON")
     expect(emit).toHaveBeenCalledWith(expect.objectContaining({ severity: "error", attributes: expect.objectContaining({ message: "Failed to mark schedule failed after processing error" }) }))
  })

  it("fencedEffect blocks on lease loss and logs", async () => {
    const assertLease = vi.fn(async () => { throw new Error("Job lease was lost") })
    const emit = vi.fn()
    const ctx = createExecutionContext({ jobId: "job-1", jobType: "test", jobVersion: 1, attempt: 1, tenantId: null, executionScope: { kind: "system", systemKey: "framework" }, correlationId: "c", startedAt: new Date(), telemetry: { emit }, assertLease })
    const fn = vi.fn(async () => "ok")
    if (!ctx.fencedEffect) throw new Error("Expected fenced effect")
    await expect(ctx.fencedEffect.execute({ effectName: "external-call", idempotencyKey: "k1", fn })).rejects.toThrow("Job lease was lost")
    expect(fn).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ severity: "warn" }))
  })

  it("fencedEffect logs success and failure of effect", async () => {
    const assertLease = vi.fn(async () => {})
    const emit = vi.fn()
    const ctx = createExecutionContext({ jobId: "job-1", jobType: "test", jobVersion: 1, attempt: 1, tenantId: null, executionScope: { kind: "system", systemKey: "framework" }, correlationId: "c", startedAt: new Date(), telemetry: { emit }, assertLease })
    await ctx.fencedEffect.execute({ effectName: "ok-effect", idempotencyKey: "ok-1", fn: async () => "done" })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "execution.fenced_effect.succeeded", severity: "debug" }))
    await expect(ctx.fencedEffect.execute({ effectName: "fail-effect", idempotencyKey: "fail-1", fn: async () => { throw new Error("boom") } })).rejects.toThrow("boom")
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "execution.fenced_effect.failed", severity: "error" }))
  })
})
