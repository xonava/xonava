import { describe, expect, it, vi } from "vitest"
import { materializeDueSchedules, type ScheduleRenewalClock } from "../scheduleDispatcher"
import type { JobStore } from "../types"
import type { FencedScheduleClaim, ScheduleStore } from "../scheduleStore"

function makeClaim(overrides: Partial<FencedScheduleClaim> = {}): FencedScheduleClaim {
  return {
    scheduleId: "schedule-1",
    scope: "platform",
    executionScope: { kind: "platform", platformKey: "default" },
    jobType: "test.job",
    jobVersion: 1,
    tenantId: null,
    payload: '{"source":"schedule"}',
    cronExpression: "0 * * * *",
    timezone: "UTC",
    overlapPolicy: { type: "allow" },
    misfirePolicy: { type: "fire_now" },
    nextRunAt: new Date("2026-08-01T10:00:00Z"),
    lastRunAt: null,
    lastStatus: null,
    claimToken: "claim-1",
    ...overrides,
  }
}

function makeStores(claims: FencedScheduleClaim[]) {
  const enqueued: Parameters<JobStore["enqueue"]>[0][] = []
  const storedByIdempotencyKey = new Map<string, Awaited<ReturnType<JobStore["enqueue"]>>>()
  const claimDueSchedules = vi.fn(async () => claims)
  const advanceSchedule = vi.fn(async () => true)
  const releaseSchedule = vi.fn(async () => true)
  const scheduleStore: ScheduleStore = {
    claimDueSchedules,
    advanceSchedule,
    releaseSchedule,
    renewScheduleLease: vi.fn(async () => true),
  }
  const enqueue = vi.fn<JobStore["enqueue"]>(async (args) => {
    enqueued.push(args)
    const existing = args.job.idempotencyKey ? storedByIdempotencyKey.get(args.job.idempotencyKey) : undefined
    if (existing) return existing
    const stored = { id: `job-${enqueued.length}`, ...args.job, scope: args.job.executionScope.kind, tenantId: args.job.executionScope.kind === "tenant" ? args.job.executionScope.tenantId : null, payload: JSON.stringify(args.job.payload), status: "pending" as const, priority: 0, attemptsCompleted: 0, currentAttempt: 1, maxAttempts: 3, runAt: args.job.runAt ?? new Date(), nextAttemptAt: null, partitionKey: args.job.partitionKey ?? null, leaseOwner: null, leaseExpiresAt: null, claimToken: null, idempotencyKey: args.job.idempotencyKey ?? null, fingerprint: "fp", correlationId: args.job.correlationId ?? null, lastError: null, resultPayload: null, metadata: null, createdAt: new Date(), startedAt: null, completedAt: null }
    if (args.job.idempotencyKey) storedByIdempotencyKey.set(args.job.idempotencyKey, stored)
    return stored
  })
  const getByIdempotencyKey = vi.fn<JobStore["getByIdempotencyKey"]>(async ({ key }) => storedByIdempotencyKey.get(key) ?? null)
  const getByCorrelationId = vi.fn<JobStore["getByCorrelationId"]>(async () => [])
  const getLatestPriorScheduleExecution = vi.fn<JobStore["getLatestPriorScheduleExecution"]>(async () => null)
  const jobStore: JobStore = {
    enqueue,
    getById: vi.fn(), getByCorrelationId, getLatestPriorScheduleExecution, getByIdempotencyKey, claimDue: vi.fn(), renewLease: vi.fn(),
    markSucceeded: vi.fn(), markRetrying: vi.fn(), markFailed: vi.fn(), cancel: vi.fn(), findPending: vi.fn(),
  }
  return { scheduleStore, jobStore, enqueued, claimDueSchedules, advanceSchedule, enqueue, getByIdempotencyKey, getByCorrelationId, getLatestPriorScheduleExecution }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

class ManualRenewalClock implements ScheduleRenewalClock {
  private nextHandle = 0
  private readonly timers = new Map<number, () => void>()
  private nowMs = Date.parse("2026-08-01T10:30:00.000Z")

  now(): Date {
    const value = new Date(this.nowMs)
    this.nowMs += 1
    return value
  }

  setTimeout(callback: () => void, _ms: number): unknown {
    const handle = ++this.nextHandle
    this.timers.set(handle, callback)
    return handle
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  fireNext(): boolean {
    const entry = this.timers.entries().next().value as [number, () => void] | undefined
    if (!entry) return false
    this.timers.delete(entry[0])
    entry[1]()
    return true
  }

  get activeTimers(): number {
    return this.timers.size
  }
}

describe("schedule dispatcher", () => {
  it("skips paused, exhausted, out-of-window, and calendar-excluded schedules", async () => {
    const now = new Date("2026-08-01T10:30:00Z")
    const claims = [
      makeClaim({ scheduleId: "paused", lifecycle: { paused: true } }),
      makeClaim({ scheduleId: "exhausted", lifecycle: { paused: false, remainingOccurrences: 0 } }),
      makeClaim({ scheduleId: "future", lifecycle: { paused: false, effectiveFrom: "2026-08-02T00:00:00Z" } }),
      makeClaim({ scheduleId: "holiday", lifecycle: { paused: false, calendarExclusionKey: "bank-holidays" } }),
    ]
    const stores = makeStores(claims)
    const isExcluded = vi.fn(async (key: string) => key === "bank-holidays")
    const result = await materializeDueSchedules({ ...stores, workerId: "worker-1", now, calendarExclusionProvider: { isExcluded } })
    expect(result).toMatchObject({ schedulesProcessed: 4, jobsEnqueued: 0, errors: [] })
    expect(stores.advanceSchedule).toHaveBeenCalledTimes(4)
    expect(isExcluded).toHaveBeenCalledOnce()
  })
  it("claims due schedules, enqueues the occurrence, and advances the schedule", async () => {
    const now = new Date("2026-08-01T10:30:00Z")
    const stores = makeStores([makeClaim()])

    const result = await materializeDueSchedules({ ...stores, workerId: "worker-1", now })

    expect(stores.claimDueSchedules).toHaveBeenCalledWith({ workerId: "worker-1", limit: 20, now, leaseDurationMs: 30_000 })
    expect(result).toMatchObject({ schedulesProcessed: 1, jobsEnqueued: 1, errors: [] })
    expect(stores.enqueued[0]?.job).toMatchObject({ jobType: "test.job", payload: { source: "schedule" }, runAt: now, idempotencyKey: "schedule:schedule-1:2026-08-01T10:00:00.000Z" })
    expect(stores.getByIdempotencyKey).toHaveBeenCalledWith({
      key: "schedule:schedule-1:2026-08-01T10:00:00.000Z",
      requester: { scope: "platform", actorId: "scheduler" },
    })
    expect(stores.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "fired", lastRunAt: now }))
  })

  it("advances fire_now from the current time rather than the missed occurrence", async () => {
    const stores = makeStores([makeClaim({ nextRunAt: new Date("2026-08-01T08:00:00Z") })])
    const now = new Date("2026-08-01T10:30:00Z")

    await materializeDueSchedules({ ...stores, workerId: "worker-1", now })

    expect(stores.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ nextRunAt: new Date("2026-08-01T11:00:00Z") }))
  })

  it("materializes every missed occurrence for queue_all", async () => {
    const stores = makeStores([makeClaim({ misfirePolicy: { type: "queue_all" }, nextRunAt: new Date("2026-08-01T08:00:00Z") })])

    const result = await materializeDueSchedules({ ...stores, workerId: "worker-1", now: new Date("2026-08-01T10:30:00Z") })

    expect(result.jobsEnqueued).toBe(3)
    expect(new Set(stores.enqueued.map(({ job }) => job.idempotencyKey)).size).toBe(3)
  })

  it("enqueues the oldest queue_all occurrences up to its limit and keeps the rest due", async () => {
    const claim = makeClaim({ misfirePolicy: { type: "queue_all" }, nextRunAt: new Date("2026-08-01T08:00:00Z") })
    const stores = makeStores([claim])

    const result = await materializeDueSchedules({
      ...stores,
      workerId: "worker-1",
      now: new Date("2026-08-01T10:30:00Z"),
      maxQueueAllOccurrences: 2,
    })

    expect(result.schedulesProcessed).toBe(1)
    expect(result.jobsEnqueued).toBe(2)
    expect(result.errors).toEqual([])
    expect(result.backlogTruncated).toEqual(["schedule-1"])
    expect(stores.enqueued.map(({ job }) => job.runAt?.toISOString())).toEqual(["2026-08-01T08:00:00.000Z", "2026-08-01T09:00:00.000Z"])
    // The oldest un-enqueued occurrence (10:00) is still due, so the next tick drains it.
    expect(stores.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ nextRunAt: new Date("2026-08-01T10:00:00Z"), lastStatus: "fired" }))
  })

  it("keeps the claimed occurrence when enqueue fails", async () => {
    const claim = makeClaim()
    const stores = makeStores([claim])
    stores.enqueue.mockRejectedValue(new Error("queue unavailable"))

    const result = await materializeDueSchedules({ ...stores, workerId: "worker-1", now: new Date("2026-08-01T10:30:00Z") })

    expect(result.schedulesProcessed).toBe(0)
    expect(result.errors).toEqual(["queue unavailable"])
    expect(stores.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ nextRunAt: claim.nextRunAt, lastStatus: "failed" }))
  })

  it("does not create duplicates when advancing fails after enqueue", async () => {
    const claim = makeClaim()
    const stores = makeStores([claim])
    stores.advanceSchedule.mockRejectedValueOnce(new Error("schedule store unavailable"))
    const now = new Date("2026-08-01T10:30:00Z")

    const first = await materializeDueSchedules({ ...stores, workerId: "worker-1", now })
    const second = await materializeDueSchedules({ ...stores, workerId: "worker-1", now })

    expect(first.errors).toEqual(["schedule store unavailable"])
    expect(second.errors).toEqual([])
    expect(stores.enqueue).toHaveBeenCalledTimes(1)
    expect(new Set(stores.enqueued.map(({ job }) => job.idempotencyKey)).size).toBe(1)
  })

  it("does not duplicate earlier queue_all occurrences after a later enqueue failure", async () => {
    const claim = makeClaim({ misfirePolicy: { type: "queue_all" }, nextRunAt: new Date("2026-08-01T08:00:00Z") })
    const stores = makeStores([claim])
    const enqueueNormally = stores.enqueue.getMockImplementation()
    stores.enqueue.mockImplementationOnce(async (args) => {
      if (!enqueueNormally) throw new Error("missing enqueue test implementation")
      const stored = await enqueueNormally(args)
      stores.enqueue.mockRejectedValueOnce(new Error("queue unavailable"))
      return stored
    })
    const now = new Date("2026-08-01T10:30:00Z")

    const first = await materializeDueSchedules({ ...stores, workerId: "worker-1", now })
    const second = await materializeDueSchedules({ ...stores, workerId: "worker-1", now })

    expect(first.errors).toEqual(["queue unavailable"])
    expect(second.errors).toEqual([])
    expect(stores.getByIdempotencyKey).toHaveBeenCalled()
    expect(new Set(stores.enqueued.map(({ job }) => job.idempotencyKey)).size).toBe(3)
  })

  it("uses the tenant idempotency scope when retrying a tenant schedule", async () => {
    const claim = makeClaim({ scope: "tenant", tenantId: "tenant-a", executionScope: { kind: "tenant", tenantId: "tenant-a" } })
    const stores = makeStores([claim])
    stores.advanceSchedule.mockRejectedValueOnce(new Error("schedule store unavailable"))
    const now = new Date("2026-08-01T10:30:00Z")

    const first = await materializeDueSchedules({ ...stores, workerId: "worker-1", now })
    const second = await materializeDueSchedules({ ...stores, workerId: "worker-1", now })

    expect(first.errors).toEqual(["schedule store unavailable"])
    expect(second.errors).toEqual([])
    expect(stores.getByIdempotencyKey).toHaveBeenCalledWith({
      key: "schedule:schedule-1:2026-08-01T10:00:00.000Z",
      requester: { scope: "tenant", tenantId: "tenant-a", actorId: "system" },
    })
    expect(stores.enqueue).toHaveBeenCalledTimes(1)
  })

  it("treats a false advance as lease loss and keeps counters truthful", async () => {
    const stores = makeStores([makeClaim()])
    stores.advanceSchedule.mockResolvedValue(false)

    const result = await materializeDueSchedules({ ...stores, workerId: "worker-1", now: new Date("2026-08-01T10:30:00Z") })

    expect(result).toMatchObject({ schedulesProcessed: 0, jobsEnqueued: 1 })
    expect(result.errors).toEqual(["Schedule schedule-1 lease was lost."])
    expect(stores.advanceSchedule).toHaveBeenCalledTimes(1)
  })

  it("propagates a claim token and renews a fenced claim while processing", async () => {
    vi.useFakeTimers()
    try {
      const stores = makeStores([makeClaim({ claimToken: "claim-1" })])
      const renewScheduleLease = vi.fn(async () => true)
      stores.scheduleStore.renewScheduleLease = renewScheduleLease
      let releaseLookup: (() => void) | undefined
      stores.getByIdempotencyKey.mockImplementation(async () => await new Promise<null>((resolve) => {
        releaseLookup = () => resolve(null)
      }))

      const work = materializeDueSchedules({
        ...stores,
        workerId: "worker-1",
        leaseDurationMs: 30,
        now: new Date("2026-08-01T10:30:00Z"),
      })
      await vi.advanceTimersByTimeAsync(11)
      releaseLookup?.()
      await work

      expect(renewScheduleLease).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: "schedule-1", workerId: "worker-1", claimToken: "claim-1" }))
      expect(stores.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "claim-1" }))
    } finally {
      vi.useRealTimers()
    }
  })

  it("serializes slow background renewal and makes assertHeld join it", async () => {
    const stores = makeStores([makeClaim()])
    const clock = new ManualRenewalClock()
    const prior = deferred<null>()
    const firstRenewal = deferred<boolean>()
    let activeRenewals = 0
    let maximumActiveRenewals = 0
    stores.getLatestPriorScheduleExecution.mockImplementationOnce(() => prior.promise)
    stores.scheduleStore.renewScheduleLease = vi.fn(async () => {
      activeRenewals += 1
      maximumActiveRenewals = Math.max(maximumActiveRenewals, activeRenewals)
      try {
        if (vi.mocked(stores.scheduleStore.renewScheduleLease).mock.calls.length === 1) {
          return await firstRenewal.promise
        }
        return true
      } finally {
        activeRenewals -= 1
      }
    })

    const work = materializeDueSchedules({
      ...stores,
      workerId: "worker-1",
      now: new Date("2026-08-01T10:30:00Z"),
      leaseDurationMs: 30,
      renewalClock: clock,
    })
    await vi.waitFor(() => expect(clock.activeTimers).toBe(1))

    expect(clock.fireNext()).toBe(true)
    await vi.waitFor(() => expect(stores.scheduleStore.renewScheduleLease).toHaveBeenCalledTimes(1))
    // Serialized scheduling: only the renewal's fail-closed deadline exists;
    // no next-interval timer is scheduled while renewal is pending.
    expect(clock.activeTimers).toBe(1)

    prior.resolve(null)
    await Promise.resolve()
    await Promise.resolve()
    // The first foreground fence joins the same pending store operation.
    expect(stores.scheduleStore.renewScheduleLease).toHaveBeenCalledTimes(1)

    firstRenewal.resolve(true)
    await expect(work).resolves.toMatchObject({ schedulesProcessed: 1, jobsEnqueued: 1, errors: [] })
    expect(maximumActiveRenewals).toBe(1)
    const renewalTimes = vi.mocked(stores.scheduleStore.renewScheduleLease).mock.calls.map(([request]) => request.now.getTime())
    expect(new Set(renewalTimes).size).toBe(renewalTimes.length)
    expect(clock.activeTimers).toBe(0)
  })

  it("permanently records a false background renewal as lease loss", async () => {
    const stores = makeStores([makeClaim()])
    const clock = new ManualRenewalClock()
    const prior = deferred<null>()
    stores.getLatestPriorScheduleExecution.mockImplementationOnce(() => prior.promise)
    stores.scheduleStore.renewScheduleLease = vi.fn(async () => false)

    const work = materializeDueSchedules({
      ...stores,
      workerId: "worker-1",
      now: new Date("2026-08-01T10:30:00Z"),
      leaseDurationMs: 30,
      renewalClock: clock,
    })
    await vi.waitFor(() => expect(clock.activeTimers).toBe(1))
    expect(clock.fireNext()).toBe(true)
    await vi.waitFor(() => expect(stores.scheduleStore.renewScheduleLease).toHaveBeenCalledOnce())

    prior.resolve(null)
    const result = await work

    expect(result.errors).toEqual(["Schedule schedule-1 lease was lost."])
    expect(stores.scheduleStore.renewScheduleLease).toHaveBeenCalledOnce()
    expect(stores.enqueue).not.toHaveBeenCalled()
    expect(stores.advanceSchedule).not.toHaveBeenCalled()
    expect(clock.activeTimers).toBe(0)
  })

  it("awaits an in-flight background renewal during shutdown", async () => {
    const stores = makeStores([makeClaim()])
    const clock = new ManualRenewalClock()
    const advance = deferred<boolean>()
    const backgroundRenewal = deferred<boolean>()
    stores.advanceSchedule.mockImplementationOnce(() => advance.promise)
    stores.scheduleStore.renewScheduleLease = vi.fn(async () => {
      if (vi.mocked(stores.scheduleStore.renewScheduleLease).mock.calls.length === 4) {
        return await backgroundRenewal.promise
      }
      return true
    })

    let settled = false
    const work = materializeDueSchedules({
      ...stores,
      workerId: "worker-1",
      now: new Date("2026-08-01T10:30:00Z"),
      leaseDurationMs: 30,
      renewalClock: clock,
    }).finally(() => { settled = true })
    await vi.waitFor(() => expect(stores.advanceSchedule).toHaveBeenCalled())
    expect(clock.fireNext()).toBe(true)
    await vi.waitFor(() => expect(stores.scheduleStore.renewScheduleLease).toHaveBeenCalledTimes(4))

    advance.resolve(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    backgroundRenewal.resolve(true)
    await expect(work).resolves.toMatchObject({ schedulesProcessed: 1, jobsEnqueued: 1, errors: [] })
    expect(clock.activeTimers).toBe(0)
  })

  it.each([
    ["allow", 1],
    ["queue", 1],
    ["skip", 0],
  ] as const)("applies overlap policy %s using the prior occurrence state", async (policy, expectedJobs) => {
    const stores = makeStores([makeClaim({ overlapPolicy: { type: policy }, lastStatus: "fired" })])
    stores.getLatestPriorScheduleExecution.mockResolvedValueOnce({
      id: "prior-job", jobType: "test.job", jobVersion: 1, tenantId: null, scope: "platform", executionScope: { kind: "platform", platformKey: "default" }, payload: "{}",
      status: "running", priority: 0, attemptsCompleted: 0, currentAttempt: 1, maxAttempts: 3,
      runAt: new Date("2026-08-01T09:00:00Z"), nextAttemptAt: null, partitionKey: null, leaseOwner: "worker-2", leaseExpiresAt: null,
      claimToken: "job-claim", idempotencyKey: "schedule:schedule-1:2026-08-01T09:00:00.000Z", fingerprint: "fp",
      correlationId: "sched:schedule-1", lastError: null, resultPayload: null, metadata: null, createdAt: new Date(), startedAt: null, completedAt: null,
    })

    const result = await materializeDueSchedules({
      ...stores,
      workerId: "worker-1",
      now: new Date("2026-08-01T10:30:00Z"),
    })

    expect(result.jobsEnqueued).toBe(expectedJobs)
    expect(stores.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "claim-1" }))
  })

  it("sets a schedule partition key for queue-overlap occurrences", async () => {
    const stores = makeStores([makeClaim({ overlapPolicy: { type: "queue" }, lastStatus: "fired" })])
    await materializeDueSchedules({ ...stores, workerId: "worker-1", now: new Date("2026-08-01T10:30:00Z") })
    expect(stores.enqueued).toHaveLength(1)
    expect(stores.enqueued[0]?.job.partitionKey).toBe("schedule:schedule-1")
  })

  it("does not set a partition key when overlap allows concurrency", async () => {
    const stores = makeStores([makeClaim({ overlapPolicy: { type: "allow" }, lastStatus: "fired" })])
    await materializeDueSchedules({ ...stores, workerId: "worker-1", now: new Date("2026-08-01T10:30:00Z") })
    expect(stores.enqueued[0]?.job.partitionKey).toBeUndefined()
  })

  it("does not let two fenced workers overlap a queued prior occurrence", async () => {
    const prior = {
      id: "prior-job", jobType: "test.job", jobVersion: 1, tenantId: null, scope: "platform" as const, executionScope: { kind: "platform" as const, platformKey: "default" }, payload: "{}",
      status: "pending" as const, priority: 0, attemptsCompleted: 0, currentAttempt: 1, maxAttempts: 3,
      runAt: new Date("2026-08-01T10:00:00Z"), nextAttemptAt: null, partitionKey: null, leaseOwner: null, leaseExpiresAt: null,
      claimToken: null, idempotencyKey: "schedule:schedule-1:2026-08-01T10:00:00.000Z", fingerprint: "fp",
      correlationId: "sched:schedule-1", lastError: null, resultPayload: null, metadata: null,
      createdAt: new Date(), startedAt: null, completedAt: null,
    }
    const worker1 = makeStores([makeClaim({ claimToken: "claim-1", lastStatus: "running", overlapPolicy: { type: "skip" } })])
    const worker2 = makeStores([makeClaim({ claimToken: "claim-2", lastStatus: "running", overlapPolicy: { type: "skip" } })])
    worker1.getLatestPriorScheduleExecution.mockResolvedValue(prior)
    worker2.getLatestPriorScheduleExecution.mockResolvedValue(prior)

    const [first, second] = await Promise.all([
      materializeDueSchedules({ ...worker1, workerId: "worker-1", now: new Date("2026-08-01T10:01:00Z") }),
      materializeDueSchedules({ ...worker2, workerId: "worker-2", now: new Date("2026-08-01T10:01:00Z") }),
    ])

    expect(first.jobsEnqueued + second.jobsEnqueued).toBe(0)
    expect(worker1.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "claim-1" }))
    expect(worker2.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ claimToken: "claim-2" }))
  })

  it("uses the true prior occurrence even when five newer correlation jobs exist", async () => {
    // The dispatcher delegates to the dedicated latest-prior primitive. Five
    // newer correlation jobs (the former top-5 list would have surfaced one of
    // them) cannot hide the real prior occurrence for overlap decisions.
    const prior = {
      id: "prior-job", jobType: "test.job", jobVersion: 1, tenantId: null, scope: "platform" as const, executionScope: { kind: "platform" as const, platformKey: "default" }, payload: "{}",
      status: "running" as const, priority: 0, attemptsCompleted: 0, currentAttempt: 1, maxAttempts: 3,
      runAt: new Date("2026-08-01T09:00:00Z"), nextAttemptAt: null, partitionKey: null, leaseOwner: "worker-2", leaseExpiresAt: null,
      claimToken: "job-claim", idempotencyKey: "schedule:schedule-1:2026-08-01T09:00:00.000Z", fingerprint: "fp",
      correlationId: "sched:schedule-1", lastError: null, resultPayload: null, metadata: null,
      createdAt: new Date(), startedAt: null, completedAt: null,
    }
    const stores = makeStores([makeClaim({ overlapPolicy: { type: "skip" }, lastStatus: "fired" })])
    stores.getLatestPriorScheduleExecution.mockResolvedValue(prior)

    const result = await materializeDueSchedules({ ...stores, workerId: "worker-1", now: new Date("2026-08-01T10:30:00Z") })

    expect(stores.getLatestPriorScheduleExecution).toHaveBeenCalledWith({
      scheduleId: "schedule-1",
      beforeOccurrence: new Date("2026-08-01T10:00:00Z"),
      requester: { scope: "platform", actorId: "scheduler" },
    })
    // The running prior occurrence causes the skip overlap policy to decline.
    expect(result.jobsEnqueued).toBe(0)
  })

})
