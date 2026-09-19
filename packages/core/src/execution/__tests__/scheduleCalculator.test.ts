import { describe, expect, it } from "vitest"
import {
  computeScheduleOccurrences,
  createIntlCronTimezoneAdapter,
  getNextOccurrence,
  matchesCron,
  parseCronExpression,
  shouldFireSchedule,
} from "../scheduleCalculator"

const adapter = createIntlCronTimezoneAdapter()

describe("schedule calculator", () => {
  it.each([
    ["queued", "skip"],
    ["running", "skip"],
    ["completed", "fire"],
  ] as const)("uses prior job execution status %s for skip overlap", (priorExecutionStatus, expected) => {
    expect(shouldFireSchedule({
      schedule: {
        cronExpression: "* * * * *", timezone: "UTC", enabled: true,
        misfirePolicy: { type: "fire_now" }, overlapPolicy: { type: "skip" },
        nextRunAt: new Date("2026-08-01T10:00:00Z"), lastRunAt: null, lastStatus: "running",
      },
      now: new Date("2026-08-01T10:01:00Z"),
      priorExecutionStatus,
    })).toBe(expected)
  })
  it("rejects zero steps, reversed ranges, and out-of-range values", () => {
    for (const expression of ["*/0 * * * *", "5-1 * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8"]) {
      expect(() => parseCronExpression(expression)).toThrow()
    }
    expect(parseCronExpression("0 0 * * 7").daysOfWeek.has(0)).toBe(true)
    expect(() => parseCronExpression("* * * *")).toThrow("exactly 5 fields")
    expect(parseCronExpression("1-3/2 1/2 1-2 1-2 1-2").minutes).toEqual(new Set([1, 3]))
  })

  it("evaluates cron day matching branches", () => {
    const date = new Date(2026, 7, 3, 9)
    const dayOfWeek = date.getDay()
    expect(matchesCron(date, parseCronExpression("0 9 3 8 *"))).toBe(true)
    expect(matchesCron(date, parseCronExpression(`0 9 2 8 ${dayOfWeek}`))).toBe(true)
    expect(matchesCron(date, parseCronExpression(`0 9 3 8 ${(dayOfWeek + 1) % 7}`))).toBe(true)
    expect(matchesCron(date, parseCronExpression(`0 9 2 8 ${(dayOfWeek + 1) % 7}`))).toBe(false)
    expect(matchesCron(date, parseCronExpression("0 9 3 7 *"))).toBe(false)
    expect(matchesCron(date, parseCronExpression("0 9 * 8 *"))).toBe(true)
    expect(matchesCron(date, parseCronExpression("0 8 * 8 *"))).toBe(false)
  })

  it("rejects invalid timezones through the injected calendar adapter", () => {
    expect(() => getNextOccurrence("0 0 * * *", new Date("2026-01-01T00:00:00Z"), "Not/AZone", adapter)).toThrow("Invalid timezone")
  })

  it("uses UTC when no timezone adapter is supplied", () => {
    const next = getNextOccurrence("30 9 * * *", new Date("2026-07-23T09:00:00Z"))
    expect(next?.toISOString()).toBe("2026-07-23T09:30:00.000Z")
  })

  it("uses the supplied timezone when no timezone adapter is injected", () => {
    const next = getNextOccurrence("30 9 * * *", new Date("2026-07-23T12:00:00Z"), "America/New_York")
    expect(next?.toISOString()).toBe("2026-07-23T13:30:00.000Z")
  })

  it("skips invalid month-end and leap-day calendar dates", () => {
    expect(getNextOccurrence("0 0 31 2 *", new Date("2026-01-01T00:00:00Z"))).toBeNull()
    expect(getNextOccurrence("0 0 29 2 *", new Date("2025-01-01T00:00:00Z"))?.toISOString()).toBe("2028-02-29T00:00:00.000Z")
    expect(getNextOccurrence("0 0 31 * *", new Date("2026-04-01T00:00:00Z"))?.toISOString()).toBe("2026-05-31T00:00:00.000Z")
  })

  it("supports cron's OR rule for day of month and day of week", () => {
    const next = getNextOccurrence("0 9 1 * 1", new Date("2026-06-02T10:00:00Z"))
    expect(next?.toISOString()).toBe("2026-06-08T09:00:00.000Z")
  })

  it("retains DOM wildcard semantics for stepped wildcards", () => {
    const cron = parseCronExpression("0 9 */2 * 1")
    expect(cron.daysOfMonthWildcard).toBe(true)
    expect(getNextOccurrence("0 9 */2 * 1", new Date("2026-06-02T10:00:00Z"))?.toISOString()).toBe("2026-06-08T09:00:00.000Z")
  })

  it("retains DOW wildcard semantics for stepped wildcards", () => {
    const cron = parseCronExpression("0 9 1 * */2")
    expect(cron.daysOfWeekWildcard).toBe(true)
    expect(getNextOccurrence("0 9 1 * */2", new Date("2026-06-01T10:00:00Z"))?.toISOString()).toBe("2026-07-01T09:00:00.000Z")
  })

  it("returns no occurrences for maxCount zero", () => {
    expect(computeScheduleOccurrences({
      schedule: { cronExpression: "* * * * *", enabled: true, nextRunAt: new Date("2026-01-01T00:00:00Z") },
      now: new Date("2026-01-01T01:00:00Z"), maxCount: 0,
    })).toEqual([])
  })

  it("skips a spring-forward gap and disambiguates the fall-back overlap", () => {
    const gap = getNextOccurrence("30 2 * * *", new Date("2026-03-08T06:00:00Z"), "America/New_York", adapter)
    expect(gap?.toISOString()).toBe("2026-03-09T06:30:00.000Z")

    const beforeFallBack = new Date("2026-11-01T04:00:00Z")
    const earlier = getNextOccurrence("30 1 * * *", beforeFallBack, "America/New_York", adapter, { disambiguation: "earlier" })
    const later = getNextOccurrence("30 1 * * *", beforeFallBack, "America/New_York", adapter, { disambiguation: "later" })
    expect(earlier?.toISOString()).toBe("2026-11-01T05:30:00.000Z")
    expect(later?.toISOString()).toBe("2026-11-01T06:30:00.000Z")
  })

  it("does not materialize a spring-forward gap as an occurrence", () => {
    const occurrences = computeScheduleOccurrences({
      schedule: {
        cronExpression: "30 2 * * *",
        enabled: true,
        nextRunAt: new Date("2026-03-07T07:30:00Z"),
      },
      now: new Date("2026-03-09T07:00:00Z"),
      maxCount: 5,
      timezone: "America/New_York",
      tzAdapter: adapter,
    })

    expect(occurrences.map((occurrence) => occurrence.toISOString())).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ])
  })

  it("uses the supplied timezone for repeated occurrences without an injected adapter", () => {
    const occurrences = computeScheduleOccurrences({
      schedule: {
        cronExpression: "30 9 * * *",
        enabled: true,
        nextRunAt: new Date("2026-07-23T13:30:00Z"),
      },
      now: new Date("2026-07-25T14:00:00Z"),
      maxCount: 5,
      timezone: "America/New_York",
    })

    expect(occurrences.map((occurrence) => occurrence.toISOString())).toEqual([
      "2026-07-23T13:30:00.000Z",
      "2026-07-24T13:30:00.000Z",
      "2026-07-25T13:30:00.000Z",
    ])
  })

  it("rejects an ambiguous local time when requested", () => {
    expect(() => getNextOccurrence("30 1 * * *", new Date("2026-11-01T04:00:00Z"), "America/New_York", adapter, { disambiguation: "reject" })).toThrow()
  })
})
