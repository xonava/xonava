import { describe, expect, it, vi } from "vitest"
import { computeScheduleOccurrences, createIntlCronTimezoneAdapter, getNextOccurrence, parseCronExpression, shouldFireSchedule } from "../../execution/scheduleCalculator"
import { materializeDueSchedules } from "../../execution/scheduleDispatcher"
import { compileScheduleLifecycle } from "../../execution/scheduleLifecycle"
import type { FencedScheduleClaim, ScheduleStore } from "../../execution/scheduleStore"
import type { JobStore, StoredJob } from "../../execution/types"

/**
 * Deterministic regressions for bugs found by the schedule differential suites
 * (scheduleCalculator / scheduleDispatcher / scheduleLifecycle). Each case is the
 * minimal counterexample the property reported.
 */

describe("schedule regressions", () => {
  describe("cron day fields: only a field that STARTS with '*' is star-flagged", () => {
    it("treats `1,*` (not star-flagged) with OR semantics, like `*,1` is star-flagged", () => {
      expect(parseCronExpression("0 0 1,* * *").daysOfMonthWildcard).toBe(false)
      expect(parseCronExpression("0 0 * * 1,*").daysOfWeekWildcard).toBe(false)
      expect(parseCronExpression("0 0 *,1 * *").daysOfMonthWildcard).toBe(true)
      expect(parseCronExpression("0 0 * * *,1").daysOfWeekWildcard).toBe(true)
    })

    it("fires `0 0 1,*/10 * 1` on every Monday OR on its day-of-month set", () => {
      // 2026-06-08 is a Monday; under AND semantics the first match would be much later.
      expect(getNextOccurrence("0 0 1,*/10 * 1", new Date("2026-06-02T00:00:00Z"))?.toISOString()).toBe("2026-06-08T00:00:00.000Z")
    })
  })

  describe("disambiguation 'later' does not lose the repeated hour when the search starts inside its first pass", () => {
    it("returns the second 01:30 of the fall-back day when searching from 01:40 EDT", () => {
      // 2026-11-01 01:40 EDT == 05:40Z; 01:30 EST == 06:30Z is the later 01:30.
      const later = getNextOccurrence("30 1 * * *", new Date("2026-11-01T05:40:00Z"), "America/New_York", undefined, { disambiguation: "later" })
      expect(later?.toISOString()).toBe("2026-11-01T06:30:00.000Z")
    })

    it("fires every minute of the repeated hour at its second occurrence", () => {
      const options = { disambiguation: "later" as const }
      // First-pass minutes (05:00Z-05:59Z) are skipped; the second pass starts at 06:00Z.
      expect(getNextOccurrence("* * * * *", new Date("2026-11-01T05:45:00Z"), "America/New_York", undefined, options)?.toISOString()).toBe("2026-11-01T06:00:00.000Z")
      expect(getNextOccurrence("* * * * *", new Date("2026-11-01T06:00:00Z"), "America/New_York", undefined, options)?.toISOString()).toBe("2026-11-01T06:01:00.000Z")
    })

    it("keeps the default (earliest) behaviour unchanged", () => {
      expect(getNextOccurrence("30 1 * * *", new Date("2026-11-01T05:40:00Z"), "America/New_York")?.toISOString()).toBe("2026-11-02T06:30:00.000Z")
    })
  })

  describe("years 0-99 are not mapped to 1900-1999", () => {
    it("finds the next leap day from the year 1 (UTC and a fixed-offset zone) instead of 1904", () => {
      const start = new Date("0001-01-01T00:00:00.000Z")
      expect(getNextOccurrence("0 0 29 2 *", start)?.toISOString()).toBe("0004-02-29T00:00:00.000Z")
      expect(getNextOccurrence("0 0 29 2 *", start, "UTC")?.toISOString()).toBe("0004-02-29T00:00:00.000Z")
      expect(getNextOccurrence("0 0 29 2 *", start, "Etc/GMT-3")?.toISOString()).toBe("0004-02-28T21:00:00.000Z")
    })

    it("walks across the year 99 -> 100 boundary and the non-leap year 100", () => {
      expect(getNextOccurrence("30 23 31 12 *", new Date("0099-12-31T23:30:00.000Z"))?.toISOString()).toBe("0100-12-31T23:30:00.000Z")
      expect(getNextOccurrence("0 0 29 2 *", new Date("0096-03-01T00:00:00.000Z"))?.toISOString()).toBe("0104-02-29T00:00:00.000Z")
      expect(getNextOccurrence("0 0 1 1 *", new Date("0050-06-15T12:00:00.000Z"))?.toISOString()).toBe("0051-01-01T00:00:00.000Z")
    })

    it("computes the day of week and the due occurrences for early years", () => {
      // 0001-01-01 is a Monday (proleptic Gregorian).
      expect(getNextOccurrence("0 0 * * 1", new Date("0001-01-01T00:00:00.000Z"))?.toISOString()).toBe("0001-01-08T00:00:00.000Z")
      const occurrences = computeScheduleOccurrences({ schedule: { cronExpression: "0 0 * * *", enabled: true, nextRunAt: new Date("0003-12-30T00:00:00.000Z") }, now: new Date("0004-01-02T00:00:00.000Z"), maxCount: 10 })
      expect(occurrences.map((date) => date.toISOString())).toEqual(["0003-12-30T00:00:00.000Z", "0003-12-31T00:00:00.000Z", "0004-01-01T00:00:00.000Z", "0004-01-02T00:00:00.000Z"])
    })
  })

  describe("Invalid Date inputs", () => {
    it("rejects an invalid search start instead of scanning for seconds (UTC) or leaking a RangeError (zones)", () => {
      expect(() => getNextOccurrence("* * * * *", new Date(Number.NaN))).toThrow(/valid Date/)
      expect(() => getNextOccurrence("* * * * *", new Date(Number.NaN), "America/New_York")).toThrow(/valid Date/)
    })

    it("does not report phantom due occurrences for an invalid window end", () => {
      expect(() => computeScheduleOccurrences({ schedule: { cronExpression: "* * * * *", enabled: true, nextRunAt: new Date("2026-01-01T00:00:00Z") }, now: new Date(Number.NaN), maxCount: 3 })).toThrow(/valid Date/)
    })

    it("does not decide to fire for an invalid now", () => {
      const schedule = { cronExpression: "* * * * *", timezone: "UTC", enabled: true, misfirePolicy: { type: "fire_now" as const }, overlapPolicy: { type: "allow" as const }, nextRunAt: new Date("2026-01-01T00:00:00Z"), lastRunAt: null, lastStatus: null }
      expect(() => shouldFireSchedule({ schedule, now: new Date(Number.NaN) })).toThrow(/valid Date/)
    })

    it("materializeDueSchedules rejects an invalid now before claiming", async () => {
      const claimDueSchedules = vi.fn(async () => [])
      const scheduleStore = { claimDueSchedules } as unknown as ScheduleStore
      await expect(materializeDueSchedules({ scheduleStore, jobStore: {} as JobStore, workerId: "w", now: new Date(Number.NaN) })).rejects.toThrow(/valid Date/)
      expect(claimDueSchedules).not.toHaveBeenCalled()
    })
  })

  describe("timezone adapter", () => {
    it("keeps rejecting an unknown zone on every call (failed constructions are not cached) and still serves valid zones", () => {
      const adapter = createIntlCronTimezoneAdapter()
      expect(() => adapter.toLocalDateTimeParts(new Date(0), "Mars/Olympus")).toThrow(/Invalid timezone/)
      expect(() => adapter.toLocalDateTimeParts(new Date(0), "Mars/Olympus")).toThrow(/Invalid timezone/)
      expect(adapter.toLocalDateTimeParts(new Date("2026-03-08T12:00:00Z"), "America/New_York")).toEqual({ year: 2026, month: 3, day: 8, hour: 8, minute: 0, dayOfWeek: 0 })
      expect(adapter.toLocalDateTimeParts(new Date("2026-03-08T12:00:00Z"), "Asia/Kolkata")).toEqual({ year: 2026, month: 3, day: 8, hour: 17, minute: 30, dayOfWeek: 0 })
    })
  })

  describe("maxQueueAllOccurrences at the safe-integer edge", () => {
    function claim(): FencedScheduleClaim {
      return {
        scheduleId: "s1", scope: "platform", executionScope: { kind: "platform", platformKey: "default" }, jobType: "test.job", jobVersion: 1, tenantId: null, payload: "{}",
        cronExpression: "*/5 * * * *", timezone: "UTC", overlapPolicy: { type: "allow" }, misfirePolicy: { type: "queue_all" },
        nextRunAt: new Date("2026-08-01T10:00:00Z"), lastRunAt: null, lastStatus: null, claimToken: "claim-1",
      }
    }

    it.each([Number.MAX_SAFE_INTEGER, 2 ** 53, 1e300])("treats %s as 'effectively unlimited' instead of failing on count overflow", async (cap) => {
      const enqueued: string[] = []
      const advance = vi.fn(async () => true)
      const scheduleStore: ScheduleStore = { claimDueSchedules: vi.fn(async () => [claim()]), advanceSchedule: advance, releaseSchedule: vi.fn(async () => true), renewScheduleLease: vi.fn(async () => true) }
      const jobStore = {
        getLatestPriorScheduleExecution: vi.fn(async () => null),
        getByIdempotencyKey: vi.fn(async () => null),
        enqueue: vi.fn(async ({ job }: Parameters<JobStore["enqueue"]>[0]) => {
          enqueued.push(job.idempotencyKey!)
          return { id: `job-${enqueued.length}` } as StoredJob
        }),
      } as unknown as JobStore
      const result = await materializeDueSchedules({ scheduleStore, jobStore, workerId: "w", now: new Date("2026-08-01T10:30:00Z"), maxQueueAllOccurrences: cap })
      expect(result.errors).toEqual([])
      expect(result.backlogTruncated).toBeUndefined()
      expect(enqueued).toHaveLength(7)
      expect(advance).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "fired", occurrencesFired: 7, nextRunAt: new Date("2026-08-01T10:35:00Z") }))
    })
  })

  describe("a crashed claim's lease marker is not execution state", () => {
    // Stores mark a claimed schedule lastStatus "running" as the lease marker and return the status observed BEFORE the
    // claim, so a reclaim after a worker crash observes "running" even though no job was ever enqueued.
    function reclaimed(overlap: "skip" | "allow" | "queue", misfire: "skip" | "fire_now" | "queue_all", lastStatus: string | null): FencedScheduleClaim {
      return {
        scheduleId: "s1", scope: "platform", executionScope: { kind: "platform", platformKey: "default" }, jobType: "test.job", jobVersion: 1, tenantId: null, payload: "{}",
        cronExpression: "*/5 * * * *", timezone: "UTC", overlapPolicy: { type: overlap }, misfirePolicy: { type: misfire },
        nextRunAt: new Date("2026-08-01T10:00:00Z"), lastRunAt: null, lastStatus, claimToken: "claim-2",
      }
    }
    function run(claim: FencedScheduleClaim, jobs: { prior?: Partial<StoredJob> | null; existing?: Partial<StoredJob> | null } = {}) {
      const advance = vi.fn(async () => true)
      const scheduleStore: ScheduleStore = { claimDueSchedules: vi.fn(async () => [claim]), advanceSchedule: advance, releaseSchedule: vi.fn(async () => true), renewScheduleLease: vi.fn(async () => true) }
      const enqueue = vi.fn(async ({ job }: Parameters<JobStore["enqueue"]>[0]) => ({ id: "job-new", idempotencyKey: job.idempotencyKey }) as StoredJob)
      const jobStore = {
        getLatestPriorScheduleExecution: vi.fn(async () => (jobs.prior ?? null) as StoredJob | null),
        getByIdempotencyKey: vi.fn(async () => (jobs.existing ?? null) as StoredJob | null),
        enqueue,
      } as unknown as JobStore
      const result = materializeDueSchedules({ scheduleStore, jobStore, workerId: "w", now: new Date("2026-08-01T10:00:30Z") })
      return { advance, enqueue, result }
    }

    it.each(["skip", "fire_now", "queue_all"] as const)("fires the due occurrence of an overlap-skip schedule reclaimed after a crash (misfire %s, no job exists)", async (misfire) => {
      const { advance, enqueue, result } = run(reclaimed("skip", misfire, "running"))
      expect((await result).errors).toEqual([])
      // Before the fix the leftover "running" marker made shouldFireSchedule skip the occurrence: nothing enqueued, advanced as "skipped".
      expect(enqueue).toHaveBeenCalledTimes(1)
      expect(advance).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "fired" }))
    })

    it("still skips when the prior-job lookup finds a pending, retrying or running job", async () => {
      for (const status of ["pending", "retrying", "running"] as const) {
        const { advance, enqueue, result } = run(reclaimed("skip", "fire_now", "running"), { prior: { status } })
        await result
        expect(enqueue).not.toHaveBeenCalled()
        expect(advance).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "skipped" }))
      }
    })

    it("after a crash that followed the enqueue, counts the existing job without enqueueing it twice", async () => {
      const { advance, enqueue, result } = run(reclaimed("skip", "fire_now", "running"), { existing: { status: "pending" } })
      await result
      expect(enqueue).not.toHaveBeenCalled()
      expect(advance).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "fired", occurrencesFired: 1 }))
    })

    it("shouldFireSchedule keeps its public fallback for direct callers", () => {
      const schedule = { cronExpression: "*/5 * * * *", timezone: "UTC", enabled: true, misfirePolicy: { type: "fire_now" as const }, overlapPolicy: { type: "skip" as const }, nextRunAt: new Date("2026-08-01T10:00:00Z"), lastRunAt: null, lastStatus: "running" }
      expect(shouldFireSchedule({ schedule, now: new Date("2026-08-01T10:00:30Z") })).toBe("skip")
    })
  })

  describe("calendar exclusion applies per occurrence in a queue_all backlog", () => {
    // */5 from 10:00, now 10:20 -> slots 10:00 10:05 10:10 10:15 10:20.
    function backlog(misfire: "queue_all" | "fire_now" | "skip", excludedSlots: string[]) {
      const claim: FencedScheduleClaim = {
        scheduleId: "s1", scope: "platform", executionScope: { kind: "platform", platformKey: "default" }, jobType: "test.job", jobVersion: 1, tenantId: null, payload: "{}",
        cronExpression: "*/5 * * * *", timezone: "UTC", overlapPolicy: { type: "allow" }, misfirePolicy: { type: misfire },
        nextRunAt: new Date("2026-08-01T10:00:00Z"), lastRunAt: null, lastStatus: null, claimToken: "claim-1",
        lifecycle: compileScheduleLifecycle({ calendarExclusionKey: "cal" }),
      }
      const advance = vi.fn(async () => true)
      const scheduleStore: ScheduleStore = { claimDueSchedules: vi.fn(async () => [claim]), advanceSchedule: advance, releaseSchedule: vi.fn(async () => true), renewScheduleLease: vi.fn(async () => true) }
      const enqueued: string[] = []
      const jobStore = {
        getLatestPriorScheduleExecution: vi.fn(async () => null),
        getByIdempotencyKey: vi.fn(async () => null),
        enqueue: vi.fn(async ({ job }: Parameters<JobStore["enqueue"]>[0]) => { enqueued.push(job.runAt!.toISOString()); return { id: `job-${enqueued.length}` } as StoredJob }),
      } as unknown as JobStore
      const calendarExclusionProvider = { isExcluded: async (_key: string, instant: Date) => excludedSlots.includes(instant.toISOString()) }
      const result = materializeDueSchedules({ scheduleStore, jobStore, workerId: "w", now: new Date("2026-08-01T10:20:00Z"), calendarExclusionProvider })
      return { advance, enqueued, result }
    }

    it("enqueues the non-excluded slots when the oldest slot is excluded", async () => {
      const { advance, enqueued, result } = backlog("queue_all", ["2026-08-01T10:00:00.000Z"])
      expect((await result).errors).toEqual([])
      expect(enqueued).toEqual(["2026-08-01T10:05:00.000Z", "2026-08-01T10:10:00.000Z", "2026-08-01T10:15:00.000Z", "2026-08-01T10:20:00.000Z"])
      expect(advance).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "fired", occurrencesFired: 4, nextRunAt: new Date("2026-08-01T10:25:00Z") }))
    })

    it("does not enqueue later excluded slots", async () => {
      const { advance, enqueued, result } = backlog("queue_all", ["2026-08-01T10:10:00.000Z", "2026-08-01T10:20:00.000Z"])
      await result
      expect(enqueued).toEqual(["2026-08-01T10:00:00.000Z", "2026-08-01T10:05:00.000Z", "2026-08-01T10:15:00.000Z"])
      expect(advance).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "fired", occurrencesFired: 3 }))
    })

    it("advances a fully excluded backlog as skipped, past its last slot", async () => {
      const all = ["10:00", "10:05", "10:10", "10:15", "10:20"].map((time) => `2026-08-01T${time}:00.000Z`)
      const { advance, enqueued, result } = backlog("queue_all", all)
      await result
      expect(enqueued).toEqual([])
      expect(advance).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "skipped", occurrencesFired: 0, nextRunAt: new Date("2026-08-01T10:25:00Z") }))
    })

    it.each(["fire_now", "skip"] as const)("still skips a single-run policy (%s) whose claimed slot is excluded", async (misfire) => {
      const { advance, enqueued, result } = backlog(misfire, ["2026-08-01T10:00:00.000Z"])
      await result
      expect(enqueued).toEqual([])
      expect(advance).toHaveBeenCalledWith(expect.objectContaining({ lastStatus: "skipped", nextRunAt: new Date("2026-08-01T10:25:00Z") }))
    })
  })

  describe("schedule lifecycle windows are strict ISO-8601", () => {
    it.each(["1", "2026", "foo 5", "March 7, 2026", "12/31/2026", "2026-02-30", "2026-02-30T00:00:00Z", "2026-03-07 10:00:00Z", "2026-03-07T10:00:00", "2026-03-07T24:00:00Z", "2026-03-07T10:00:00+25:00", " 2026-03-07"])("rejects %j", (text) => {
      expect(() => compileScheduleLifecycle({ effectiveFrom: text })).toThrow(/effectiveFrom must be an ISO timestamp/)
      expect(() => compileScheduleLifecycle({ effectiveUntil: text })).toThrow(/effectiveUntil must be an ISO timestamp/)
    })

    it.each(["2026-03-07", "2026-03-07T10:00Z", "2026-03-07T10:00:00Z", "2026-03-07T10:00:00.123Z", "2026-03-07T10:00:00+05:30", "2024-02-29T00:00:00Z"])("accepts %j", (text) => {
      expect(compileScheduleLifecycle({ effectiveFrom: text }).effectiveFrom).toBe(text)
    })
  })
})
