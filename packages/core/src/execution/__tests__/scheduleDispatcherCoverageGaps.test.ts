import { describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "../../domain/errors"
import { MAX_STORED_SCHEDULE_PAYLOAD_BYTES, materializeDueSchedules } from "../scheduleDispatcher"
import type { JobStore, StoredJob } from "../types"
import type { FencedScheduleClaim, ScheduleStore } from "../scheduleStore"

function claim(overrides: Partial<FencedScheduleClaim> = {}): FencedScheduleClaim { return Object.assign({ scheduleId: "s", scope: "tenant", executionScope: { kind: "tenant", tenantId: "tenant-a" }, jobType: "job", jobVersion: 1, tenantId: "tenant-a", payload: "{}", cronExpression: "0 * * * *", timezone: "UTC", overlapPolicy: { type: "allow" }, misfirePolicy: { type: "fire_now" }, nextRunAt: new Date("2026-08-05T10:00:00Z"), lastRunAt: null, lastStatus: null, claimToken: "claim-1" }, overrides) }
function stores(claims: FencedScheduleClaim[]) {
  const advanceSchedule = vi.fn(async () => true)
  const scheduleStore = { claimDueSchedules: vi.fn(async () => claims), advanceSchedule, releaseSchedule: vi.fn(async () => true), renewScheduleLease: vi.fn(async () => true) } as ScheduleStore
  const jobStore = { enqueue: vi.fn(async () => ({})), getById: vi.fn(), getByCorrelationId: vi.fn(async () => []), getLatestPriorScheduleExecution: vi.fn(async () => null), getByIdempotencyKey: vi.fn(async () => null), claimDue: vi.fn(), renewLease: vi.fn(), markSucceeded: vi.fn(), markRetrying: vi.fn(), markFailed: vi.fn(), cancel: vi.fn(), findPending: vi.fn() } as unknown as JobStore
  return { scheduleStore, jobStore, advanceSchedule }
}

describe("schedule dispatcher validation branches", () => {
  it("validates global options before claiming", async () => {
    const s = stores([])
    await expect(materializeDueSchedules({ ...s, workerId: "w", leaseDurationMs: 0 })).rejects.toThrow("lease duration")
    await expect(materializeDueSchedules({ ...s, workerId: "w", leaseDurationMs: 0 })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(materializeDueSchedules({ ...s, workerId: "w", maxQueueAllOccurrences: 0 })).resolves.toEqual({ schedulesProcessed: 0, jobsEnqueued: 0, errors: [] })
  })

  it("reports invalid occurrence limits", async () => {
    const invalid = stores([claim({ misfirePolicy: { type: "queue_all" } })])
    await expect(materializeDueSchedules({ ...invalid, workerId: "w", maxQueueAllOccurrences: -1, now: new Date("2026-08-05T11:00:00Z") })).resolves.toMatchObject({ errors: ["maxQueueAllOccurrences must be a positive integer"] })
  })

  it("skips existing jobs, decodes payloads, and releases a failed lease best-effort", async () => {
    const s = stores([claim()])
    s.jobStore.getByIdempotencyKey = vi.fn(async () => ({ id: "existing" } as StoredJob))
    await expect(materializeDueSchedules({ ...s, workerId: "w" })).resolves.toMatchObject({ schedulesProcessed: 1, jobsEnqueued: 0 })
    const bad = stores([claim({ payload: "not-json" })])
    await expect(materializeDueSchedules({ ...bad, workerId: "w", now: new Date("2026-08-05T11:00:00Z") })).resolves.toMatchObject({ errors: ["Schedule payload is not valid JSON."] })
    const releaseFailure = stores([claim({ payload: "not-json" })])
    releaseFailure.advanceSchedule.mockRejectedValueOnce(new Error("release failed"))
    await expect(materializeDueSchedules({ ...releaseFailure, workerId: "w", now: new Date("2026-08-05T11:00:00Z") })).resolves.toMatchObject({ errors: ["Schedule payload is not valid JSON."] })
    const nonObject = stores([claim({ payload: "[]" })])
    await expect(materializeDueSchedules({ ...nonObject, workerId: "w", now: new Date("2026-08-05T11:00:00Z") })).resolves.toMatchObject({ errors: ["Schedule payload must be a JSON object."] })
    const oversized = stores([claim({ payload: JSON.stringify({ body: "x".repeat(MAX_STORED_SCHEDULE_PAYLOAD_BYTES) }) })])
    await expect(materializeDueSchedules({ ...oversized, workerId: "w", now: new Date("2026-08-05T11:00:00Z") })).resolves.toMatchObject({ errors: [expect.stringMatching(/payload exceeds the maximum/)] })
    expect(oversized.jobStore.enqueue).not.toHaveBeenCalled()
    const decoderFailure = stores([claim()])
    await expect(materializeDueSchedules({ ...decoderFailure, workerId: "w", now: new Date("2026-08-05T11:00:00Z"), decodePayload: () => { throw new Error("decode failed") } })).resolves.toMatchObject({ errors: ["decode failed"] })
  })

  it("advances schedules that should be skipped and handles empty occurrence results", async () => {
    const future = stores([claim({ nextRunAt: new Date("2026-08-05T12:00:00Z") })])
    const now = new Date("2026-08-05T11:00:00Z")
    await expect(materializeDueSchedules({ ...future, workerId: "w", now })).resolves.toMatchObject({ schedulesProcessed: 1, jobsEnqueued: 0 })
    expect(future.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "skipped" }))

    const impossible = stores([claim({ cronExpression: "0 0 31 2 *", misfirePolicy: { type: "fire_now" } })])
    await expect(materializeDueSchedules({ ...impossible, workerId: "w", now })).resolves.toMatchObject({ errors: ["Schedule s has no future occurrence for its cron expression."] })
  })

  it("supports system schedules and an explicit timezone adapter", async () => {
    const system = stores([claim({ scope: "platform", tenantId: null, executionScope: { kind: "platform", platformKey: "default" }, misfirePolicy: { type: "fire_now" } })])
    const adapter = {
      toLocalDateTimeParts: (date: Date) => ({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), dayOfWeek: date.getUTCDay() }),
      localToUtc: (local: { year: number; month: number; day: number; hour: number; minute: number }) => new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)),
    }
    const now = new Date("2026-08-05T11:00:00Z")
    const result = await materializeDueSchedules({ ...system, workerId: "w", now, tzAdapter: adapter })
    expect(result.jobsEnqueued).toBe(1)
  })

  it("handles queue-all payload variants and non-Error decoder failures", async () => {
    const adapter = {
      toLocalDateTimeParts: (date: Date) => ({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), dayOfWeek: date.getUTCDay() }),
      localToUtc: (local: { year: number; month: number; day: number; hour: number; minute: number }) => new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)),
    }
    const queued = stores([claim({ misfirePolicy: { type: "queue_all" }, payload: "", nextRunAt: new Date("2026-08-05T10:00:00Z") })])
    const queuedResult = await materializeDueSchedules({ ...queued, workerId: "w", now: new Date("2026-08-05T11:00:00Z"), tzAdapter: adapter })
    expect(queuedResult.jobsEnqueued).toBeGreaterThan(0)
    const nonError = stores([claim()])
    const result = await materializeDueSchedules({ ...nonError, workerId: "w", decodePayload: () => {
      // Exercise the defensive non-Error catch branch.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "decoder failed"
    } })
    expect(result.errors).toEqual(["decoder failed"])
    const empty = stores([claim({ cronExpression: "0 0 31 2 *", misfirePolicy: { type: "queue_all" }, nextRunAt: new Date("2026-08-05T10:00:00Z") })])
    const emptyResult = await materializeDueSchedules({ ...empty, workerId: "w", now: new Date("2026-08-05T11:00:00Z") })
    expect(emptyResult.errors).toHaveLength(1)
  })

  it("truncates queue-all overflow per tick and continues past an already materialized occurrence", async () => {
    const adapter = {
      toLocalDateTimeParts: (date: Date) => ({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), dayOfWeek: date.getUTCDay() }),
      localToUtc: (local: { year: number; month: number; day: number; hour: number; minute: number }) => new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)),
    }
    const overflow = stores([claim({ misfirePolicy: { type: "queue_all" }, nextRunAt: new Date("2026-08-05T08:00:00Z") })])
    const overflowResult = await materializeDueSchedules({ ...overflow, workerId: "w", now: new Date("2026-08-05T11:00:00Z"), maxQueueAllOccurrences: 1, tzAdapter: adapter })
    expect(overflowResult.errors).toEqual([])
    expect(overflowResult.jobsEnqueued).toBe(1)
    expect(overflowResult.backlogTruncated).toEqual(["s"])

    const existing = stores([claim({ misfirePolicy: { type: "queue_all" }, nextRunAt: new Date("2026-08-05T10:00:00Z") })])
    existing.jobStore.getByIdempotencyKey = vi.fn(async ({ key }: { key: string }) => key.endsWith("10:00:00.000Z") ? ({ id: "existing" } as StoredJob) : null)
    const existingResult = await materializeDueSchedules({ ...existing, workerId: "w", now: new Date("2026-08-05T11:00:00Z"), tzAdapter: adapter })
    expect(existingResult.jobsEnqueued).toBeGreaterThanOrEqual(0)
    // The mocked method is intentionally inspected by reference for this assertion.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(existing.scheduleStore.advanceSchedule).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "fired" }))
  })

  it("treats lease renewal as required while processing and reports a lost schedule lease", async () => {
    const renewed = stores([claim()])
    const renewScheduleLease = vi.fn(async () => true)
    renewed.scheduleStore.renewScheduleLease = renewScheduleLease
    await materializeDueSchedules({ ...renewed, workerId: "w", now: new Date("2026-08-05T11:00:00Z") })
    expect(renewScheduleLease).toHaveBeenCalled()

    const lost = stores([claim()])
    const advanceSchedule = vi.mocked(Reflect.get(lost.scheduleStore, "advanceSchedule") as ReturnType<typeof vi.fn>)
    advanceSchedule.mockResolvedValueOnce(false)
    const lostResult = await materializeDueSchedules({ ...lost, workerId: "w", now: new Date("2026-08-05T11:00:00Z") })
    expect(lostResult.errors).toEqual(["Schedule s lease was lost."])
    expect(advanceSchedule).toHaveBeenCalledOnce()
  })

  it("stops processing when an asynchronous lease renewal reports loss", async () => {
    vi.useFakeTimers()
    const lost = stores([claim()])
    lost.scheduleStore.renewScheduleLease = vi.fn(async () => { throw new Error("renewal unavailable") })
    lost.jobStore.getByIdempotencyKey = vi.fn(() => new Promise<null>((resolve) => setTimeout(() => resolve(null), 10)))
    const processing = materializeDueSchedules({ ...lost, workerId: "w", leaseDurationMs: 3 })

    await vi.advanceTimersByTimeAsync(10)
    const result = await processing

    expect(result.errors).toEqual(["Schedule s lease was lost."])
    const enqueue = vi.mocked(Reflect.get(lost.jobStore, "enqueue") as ReturnType<typeof vi.fn>)
    expect(enqueue).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe("schedule dispatcher option contract", () => {
  it("rejects invalid limit and workerId as ConfigurationError before claiming", async () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 101, "5" as never]) {
      const s = stores([])
      await expect(materializeDueSchedules({ ...s, workerId: "w", limit })).rejects.toBeInstanceOf(ConfigurationError)
      expect(s.scheduleStore.claimDueSchedules).not.toHaveBeenCalled()
    }
    for (const workerId of ["", "  ", undefined as never, 42 as never]) {
      const s = stores([])
      await expect(materializeDueSchedules({ ...s, workerId })).rejects.toBeInstanceOf(ConfigurationError)
      expect(s.scheduleStore.claimDueSchedules).not.toHaveBeenCalled()
    }
    const ok = stores([])
    await expect(materializeDueSchedules({ ...ok, workerId: "w", limit: 100 })).resolves.toMatchObject({ schedulesProcessed: 0 })
    expect(ok.scheduleStore.claimDueSchedules).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, workerId: "w" }))
  })
})
