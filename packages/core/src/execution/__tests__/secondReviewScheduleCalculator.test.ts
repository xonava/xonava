import { describe, expect, it } from "vitest"
import { computeScheduleOccurrences, getNextOccurrence } from "../scheduleCalculator"

function occurrences(expression: string, from: string, count: number): string[] {
  const out: string[] = []
  let cursor = new Date(from)
  for (let i = 0; i < count; i++) {
    const next = getNextOccurrence(expression, cursor)
    if (!next) break
    out.push(next.toISOString().slice(0, 10))
    cursor = next
  }
  return out
}

describe("cron stepped wildcard day semantics (C2)", () => {
  it("fires `0 0 */2 * *` only on odd days of the month", () => {
    expect(occurrences("0 0 */2 * *", "2026-06-30T12:00:00Z", 5)).toEqual(["2026-07-01", "2026-07-03", "2026-07-05", "2026-07-07", "2026-07-09"])
    expect(occurrences("0 0 */2 * *", "2026-07-30T12:00:00Z", 2)).toEqual(["2026-07-31", "2026-08-01"])
  })

  it("fires `0 0 * * */2` only on Sun/Tue/Thu/Sat", () => {
    const days = occurrences("0 0 * * */2", "2026-06-01T12:00:00Z", 8)
    expect(days.map((day) => new Date(`${day}T00:00:00Z`).getUTCDay())).toEqual([2, 4, 6, 0, 2, 4, 6, 0])
    expect(days[0]).toBe("2026-06-02")
  })

  it("ANDs a stepped-wildcard day field with a restricted one (Vixie semantics)", () => {
    // odd days that are also Mondays: 2026-06-15 is the first after June 2
    expect(getNextOccurrence("0 9 */2 * 1", new Date("2026-06-02T10:00:00Z"))?.toISOString()).toBe("2026-06-15T09:00:00.000Z")
  })

  it("treats `0 0 30 2 1` as Feb 30 OR any Monday in February", () => {
    // 2027-02-01 is a Monday
    expect(getNextOccurrence("0 0 30 2 1", new Date("2026-10-07T00:00:00Z"))?.toISOString()).toBe("2027-02-01T00:00:00.000Z")
    expect(computeScheduleOccurrences({
      schedule: { cronExpression: "0 0 30 2 1", enabled: true, nextRunAt: new Date("2027-02-01T00:00:00Z") },
      now: new Date("2027-03-01T00:00:00Z"), maxCount: 10,
    }).map((date) => date.toISOString().slice(0, 10))).toEqual(["2027-02-01", "2027-02-08", "2027-02-15", "2027-02-22"])
  })

  it("still returns null for impossible restricted dates with a wildcard day-of-week", () => {
    expect(getNextOccurrence("0 0 30 2 *", new Date("2026-01-01T00:00:00Z"))).toBeNull()
  })
})
