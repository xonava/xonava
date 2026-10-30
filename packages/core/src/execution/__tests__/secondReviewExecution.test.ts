import { afterEach, describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "../../domain"
import { dispatchDueJobs, type DispatcherConfig } from "../dispatcher"
import { createJobRegistry } from "../jobRegistry"
import { computeNextAttemptAt, DEFAULT_MAX_RETRY_DELAY_MS, getNextRetryDelay } from "../retryPolicy"
import { materializeDueSchedules } from "../scheduleDispatcher"
import type { FencedScheduleClaim, ScheduleStore } from "../scheduleStore"
import { MAX_TIMER_DELAY_MS } from "../types"
import type { JobDefinition, JobStore, StoredJob } from "../types"

const TOO_LONG = MAX_TIMER_DELAY_MS + 1

function makeJob(): StoredJob {
  return {
    id: "job-1", jobType: "test", jobVersion: 1, tenantId: null, executionScope: { kind: "system", systemKey: "framework" }, scope: "system",
    payload: "{}", status: "pending", priority: 0, attemptsCompleted: 0, currentAttempt: 1, maxAttempts: 3, runAt: new Date(), nextAttemptAt: null,
    partitionKey: null, leaseOwner: "worker-1", leaseExpiresAt: new Date(Date.now() + 1_000), claimToken: "claim-1", idempotencyKey: null,
    fingerprint: "fp", correlationId: null, lastError: null, resultPayload: null, metadata: null, createdAt: new Date(), startedAt: new Date(), completedAt: null,
  }
}

function makeJobStore(job: StoredJob): JobStore {
  return {
    enqueue: vi.fn(), getById: vi.fn(), getByCorrelationId: vi.fn(), getLatestPriorScheduleExecution: vi.fn(), getByIdempotencyKey: vi.fn(),
    claimDue: vi.fn(async () => [job]), renewLease: vi.fn(async () => true), markSucceeded: vi.fn(async () => ({ applied: true as const })),
    markRetrying: vi.fn(async () => ({ applied: true as const })), markFailed: vi.fn(async () => ({ applied: true as const })), cancel: vi.fn(), findPending: vi.fn(),
  }
}

function definition(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    type: "test", version: 1, scope: "system", maxAttempts: 3, retryDelayMs: 0, retryBackoffMultiplier: 1,
    decodePayload: (input) => input as Record<string, unknown>, execute: async () => ({ success: true }), ...overrides,
  }
}

function dispatcherConfig(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  const registry = createJobRegistry()
  registry.register(definition())
  return { store: makeJobStore(makeJob()), registry, workerId: "worker-1", leaseDurationMs: 1_000, claimLimit: 1, requester: { scope: "system" }, ...overrides }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("timer delay bounds", () => {
  it("exports the platform timer ceiling", () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647)
  })

  it("rejects job definitions whose timeout exceeds the timer ceiling", () => {
    expect(() => createJobRegistry().register(definition({ timeoutMs: TOO_LONG }))).toThrow(ConfigurationError)
    expect(() => createJobRegistry().register(definition({ timeoutMs: MAX_TIMER_DELAY_MS }))).not.toThrow()
  })

  it("rejects dispatcher lease, timeout and grace durations above the timer ceiling", async () => {
    await expect(dispatchDueJobs(dispatcherConfig({ leaseDurationMs: TOO_LONG }))).rejects.toThrow(ConfigurationError)
    await expect(dispatchDueJobs(dispatcherConfig({ timeoutPolicy: { mode: "cooperative", timeoutMs: TOO_LONG, cancellationGraceMs: 0 } }))).rejects.toThrow(ConfigurationError)
    await expect(dispatchDueJobs(dispatcherConfig({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: TOO_LONG } }))).rejects.toThrow(ConfigurationError)
  })

  it("rejects schedule lease durations above the timer ceiling", async () => {
    const scheduleStore: ScheduleStore = { claimDueSchedules: vi.fn(async () => []), advanceSchedule: vi.fn(), releaseSchedule: vi.fn(), renewScheduleLease: vi.fn() }
    await expect(materializeDueSchedules({ scheduleStore, jobStore: makeJobStore(makeJob()), workerId: "w", leaseDurationMs: TOO_LONG })).rejects.toThrow(ConfigurationError)
    expect(scheduleStore.claimDueSchedules).not.toHaveBeenCalled()
  })
})

describe("retry backoff bounds", () => {
  const policy = { maxAttempts: 100, delayMs: 1_000, backoffMultiplier: 2 }

  it("caps uncapped exponential backoff at 24 hours by default", () => {
    expect(DEFAULT_MAX_RETRY_DELAY_MS).toBe(24 * 60 * 60 * 1000)
    expect(getNextRetryDelay({ policy, attempt: 44 })).toBe(DEFAULT_MAX_RETRY_DELAY_MS)
    expect(getNextRetryDelay({ policy, attempt: 99 })).toBe(DEFAULT_MAX_RETRY_DELAY_MS)
    expect(getNextRetryDelay({ policy, attempt: 3 })).toBe(4_000)
    const next = computeNextAttemptAt({ policy, attempt: 44, now: new Date(0) })
    expect(next?.getTime()).toBe(DEFAULT_MAX_RETRY_DELAY_MS)
  })

  it("never overflows to a non-finite delay even with huge multipliers", () => {
    const huge = { maxAttempts: 2_000, delayMs: 1, backoffMultiplier: 1e10 }
    expect(getNextRetryDelay({ policy: huge, attempt: 1_500 })).toBe(DEFAULT_MAX_RETRY_DELAY_MS)
    expect(Number.isFinite(getNextRetryDelay({ policy: { ...huge, maxDelayMs: Number.MAX_VALUE }, attempt: 1_500 }))).toBe(true)
  })

  it("always returns a valid Date for the next attempt", () => {
    const next = computeNextAttemptAt({ policy: { ...policy, maxDelayMs: Number.MAX_VALUE }, attempt: 99, now: new Date("2026-01-01T00:00:00Z") })
    expect(next).not.toBeNull()
    expect(Number.isNaN(next!.getTime())).toBe(false)
  })

  it("keeps an explicit base delay above the default cap", () => {
    const longBase = { maxAttempts: 5, delayMs: 2 * DEFAULT_MAX_RETRY_DELAY_MS, backoffMultiplier: 2 }
    expect(getNextRetryDelay({ policy: longBase, attempt: 1 })).toBe(2 * DEFAULT_MAX_RETRY_DELAY_MS)
    expect(getNextRetryDelay({ policy: longBase, attempt: 3 })).toBe(2 * DEFAULT_MAX_RETRY_DELAY_MS)
  })

  it("hands the dispatcher a valid nextAttemptAt at high attempt numbers", async () => {
    const job = { ...makeJob(), attemptsCompleted: 43, currentAttempt: 44, maxAttempts: 100 }
    const store = makeJobStore(job)
    const registry = createJobRegistry()
    registry.register(definition({ maxAttempts: 100, retryDelayMs: 1_000, retryBackoffMultiplier: 2, execute: async () => ({ success: false, error: new Error("boom") }) }))
    const result = await dispatchDueJobs({ store, registry, workerId: "worker-1", leaseDurationMs: 1_000, claimLimit: 1, requester: { scope: "system" } })
    expect(result.retried).toBe(1)
    const [[args]] = vi.mocked(store.markRetrying).mock.calls as unknown as [[{ nextAttemptAt: Date }]]
    expect(Number.isNaN(args.nextAttemptAt.getTime())).toBe(false)
  })
})

describe("heartbeat timer cleanup", () => {
  it("leaves no live timers after a job finishes with the default clock", async () => {
    vi.useFakeTimers()
    const result = await dispatchDueJobs(dispatcherConfig({ leaseDurationMs: 30_000 }))
    expect(result.succeeded).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("queue_all backlog draining", () => {
  function scheduleHarness(initialNextRunAt: Date) {
    let nextRunAt = initialNextRunAt
    const claim = (): FencedScheduleClaim => ({
      scheduleId: "schedule-1", scope: "platform", executionScope: { kind: "platform", platformKey: "default" }, jobType: "test.job", jobVersion: 1,
      tenantId: null, payload: "{}", cronExpression: "0 * * * *", timezone: "UTC", overlapPolicy: { type: "allow" }, misfirePolicy: { type: "queue_all" },
      nextRunAt, lastRunAt: null, lastStatus: null, claimToken: "claim-1",
    })
    const advances: { nextRunAt: Date | null; lastStatus: string }[] = []
    const scheduleStore: ScheduleStore = {
      claimDueSchedules: vi.fn(async ({ now }) => (nextRunAt <= now ? [claim()] : [])),
      advanceSchedule: vi.fn(async (args) => {
        advances.push({ nextRunAt: args.nextRunAt, lastStatus: args.lastStatus })
        if (args.nextRunAt) nextRunAt = args.nextRunAt
        return true
      }),
      releaseSchedule: vi.fn(async () => true),
      renewScheduleLease: vi.fn(async () => true),
    }
    const runAts: string[] = []
    const jobStore = makeJobStore(makeJob())
    vi.mocked(jobStore.getByIdempotencyKey).mockResolvedValue(null)
    vi.mocked(jobStore.getLatestPriorScheduleExecution).mockResolvedValue(null)
    vi.mocked(jobStore.enqueue).mockImplementation(async ({ job }) => {
      runAts.push((job.runAt as Date).toISOString())
      return makeJob()
    })
    return { scheduleStore, jobStore, runAts, advances, current: () => nextRunAt }
  }

  it("enqueues the oldest N occurrences per tick and drains the backlog over later ticks", async () => {
    const harness = scheduleHarness(new Date("2026-08-01T05:00:00Z"))
    const now = new Date("2026-08-01T10:30:00Z")
    const tick = () => materializeDueSchedules({ scheduleStore: harness.scheduleStore, jobStore: harness.jobStore, workerId: "w", now, maxQueueAllOccurrences: 2 })

    const first = await tick()
    expect(first.errors).toEqual([])
    expect(first.jobsEnqueued).toBe(2)
    expect(first.backlogTruncated).toEqual(["schedule-1"])
    expect(harness.current().toISOString()).toBe("2026-08-01T07:00:00.000Z")

    const second = await tick()
    expect(second.jobsEnqueued).toBe(2)
    expect(second.backlogTruncated).toEqual(["schedule-1"])

    const third = await tick()
    expect(third.jobsEnqueued).toBe(2)
    expect(third.backlogTruncated).toBeUndefined()
    expect(harness.current().toISOString()).toBe("2026-08-01T11:00:00.000Z")

    expect(harness.runAts).toEqual(["05", "06", "07", "08", "09", "10"].map((hour) => `2026-08-01T${hour}:00:00.000Z`))
    expect(harness.advances.every((advance) => advance.lastStatus === "fired")).toBe(true)
    expect((await tick()).jobsEnqueued).toBe(0)
  })
})
