import { describe, expect, it, vi } from "vitest"
import { materializeDueSchedules } from "../scheduleDispatcher"
import type { JobStore, StoredJob } from "../types"
import type { FencedScheduleClaim, ScheduleStore } from "../scheduleStore"

const now = new Date("2026-08-01T10:30:00Z")

function claim(overrides: Partial<FencedScheduleClaim> = {}): FencedScheduleClaim {
  return { scheduleId: "s1", scope: "platform", executionScope: { kind: "platform", platformKey: "default" }, jobType: "test.job", jobVersion: 1, tenantId: null, payload: "{}", cronExpression: "*/5 * * * *", timezone: "UTC", overlapPolicy: { type: "allow" }, misfirePolicy: { type: "fire_now" }, nextRunAt: new Date("2026-08-01T10:00:00Z"), lastRunAt: null, lastStatus: null, claimToken: "claim-1", ...overrides }
}

function stores(claims: FencedScheduleClaim[]) {
  const byKey = new Map<string, StoredJob>()
  const advanceSchedule = vi.fn<ScheduleStore["advanceSchedule"]>(async () => true)
  const scheduleStore: ScheduleStore = { claimDueSchedules: vi.fn(async () => claims), advanceSchedule, releaseSchedule: vi.fn(async () => true), renewScheduleLease: vi.fn(async () => true) }
  const enqueue = vi.fn<JobStore["enqueue"]>(async ({ job }) => {
    const stored = { id: `job-${byKey.size + 1}`, jobType: job.jobType, jobVersion: job.jobVersion, tenantId: null, executionScope: job.executionScope, scope: "platform", payload: "{}", status: "pending", priority: 0, attemptsCompleted: 0, currentAttempt: 0, runAt: job.runAt ?? now, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null, claimToken: null, idempotencyKey: job.idempotencyKey ?? null, fingerprint: "fp", correlationId: job.correlationId ?? null, lastError: null, resultPayload: null, metadata: null, partitionKey: null, createdAt: now, startedAt: null, completedAt: null } satisfies StoredJob
    byKey.set(job.idempotencyKey!, stored)
    return stored
  })
  const jobStore: JobStore = {
    enqueue, getById: vi.fn(), getByCorrelationId: vi.fn(async () => []), getLatestPriorScheduleExecution: vi.fn(async () => null),
    getByIdempotencyKey: vi.fn(async ({ key }) => byKey.get(key) ?? null), claimDue: vi.fn(), renewLease: vi.fn(), markSucceeded: vi.fn(), markRetrying: vi.fn(), markFailed: vi.fn(), cancel: vi.fn(), findPending: vi.fn(),
  }
  return { scheduleStore, jobStore, advanceSchedule, enqueue, byKey }
}

describe("misfire skip within its window", () => {
  it("fires at most one run instead of replaying every missed occurrence", async () => {
    const s = stores([claim({ misfirePolicy: { type: "skip" } })])
    const result = await materializeDueSchedules({ ...s, workerId: "w", now })
    expect(result.jobsEnqueued).toBe(1)
    expect(s.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "fired", nextRunAt: new Date("2026-08-01T10:35:00Z"), occurrencesFired: 1 }))
  })

  it("honours overlap skip for every misfire policy", async () => {
    for (const misfire of ["skip", "fire_now", "queue_all"] as const) {
      const s = stores([claim({ misfirePolicy: { type: misfire }, overlapPolicy: { type: "skip" } })])
      const result = await materializeDueSchedules({ ...s, workerId: "w", now })
      expect(result.jobsEnqueued).toBe(1)
    }
  })
})

describe("remainingOccurrences during catch-up", () => {
  it("never enqueues more occurrences than remain and reports how many fired", async () => {
    const s = stores([claim({ misfirePolicy: { type: "queue_all" }, lifecycle: { paused: false, remainingOccurrences: 2 } })])
    const result = await materializeDueSchedules({ ...s, workerId: "w", now })
    expect(result.jobsEnqueued).toBe(2)
    expect(s.enqueue.mock.calls.map(([args]) => args.job.runAt?.toISOString())).toEqual(["2026-08-01T10:00:00.000Z", "2026-08-01T10:05:00.000Z"])
    expect(s.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "fired", occurrencesFired: 2 }))
  })

  it("reports every enqueued occurrence of an uncapped catch-up", async () => {
    const s = stores([claim({ misfirePolicy: { type: "queue_all" } })])
    await materializeDueSchedules({ ...s, workerId: "w", now })
    expect(s.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ occurrencesFired: 7 }))
  })

  it("counts no occurrence when overlap declines the run", async () => {
    // The earlier occurrence is still running: reported by the prior-job lookup (a claim's lastStatus "running" is only the lease marker).
    const s = stores([claim({ overlapPolicy: { type: "skip" } })])
    vi.mocked(s.jobStore.getLatestPriorScheduleExecution).mockResolvedValue({ id: "earlier", status: "running" } as StoredJob)
    await materializeDueSchedules({ ...s, workerId: "w", now })
    expect(s.enqueue).not.toHaveBeenCalled()
    expect(s.advanceSchedule).toHaveBeenCalledWith(expect.not.objectContaining({ occurrencesFired: expect.any(Number) as number }))
  })
})

describe("failing schedules back off", () => {
  it("keeps the occurrence but defers the next claim with a capped exponential backoff", async () => {
    const first = stores([claim({ payload: "not-json" })])
    await expect(materializeDueSchedules({ ...first, workerId: "w", now })).resolves.toMatchObject({ errors: ["Schedule payload is not valid JSON."] })
    expect(first.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ nextRunAt: new Date("2026-08-01T10:00:00Z"), lastStatus: "failed", lastError: "Schedule payload is not valid JSON.", retryAt: new Date(now.getTime() + 5_000) }))

    // A repeat failure doubles the delay since the previous failure...
    const second = stores([claim({ payload: "not-json", lastStatus: "failed", lastRunAt: new Date(now.getTime() - 5_000) })])
    await materializeDueSchedules({ ...second, workerId: "w", now })
    expect(second.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ retryAt: new Date(now.getTime() + 10_000) }))

    // ...up to the configured ceiling.
    const capped = stores([claim({ payload: "not-json", lastStatus: "failed", lastRunAt: new Date(now.getTime() - 3_600_000) })])
    await materializeDueSchedules({ ...capped, workerId: "w", now, failureBackoff: { initialDelayMs: 1_000, maxDelayMs: 60_000 } })
    expect(capped.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ retryAt: new Date(now.getTime() + 60_000) }))
  })

  it("rejects an invalid failure backoff", async () => {
    const s = stores([])
    await expect(materializeDueSchedules({ ...s, workerId: "w", now, failureBackoff: { initialDelayMs: 0, maxDelayMs: 10 } })).rejects.toThrow(/failureBackoff/)
    await expect(materializeDueSchedules({ ...s, workerId: "w", now, failureBackoff: { initialDelayMs: 10, maxDelayMs: 5 } })).rejects.toThrow(/failureBackoff/)
  })
})
