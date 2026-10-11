import { describe, expect, it } from "vitest"
import { forAll, type Rng } from "./harness"
import { compileScheduleLifecycle, isScheduleEffective, type ScheduleLifecycle } from "../../execution/scheduleLifecycle"
import { assertFencedScheduleClaim } from "../../execution/scheduleStore"

/**
 * Lifecycle (pause / effective window / finite occurrences) against a direct
 * transcription of the contract: an instant text is valid iff it is an ISO-8601
 * calendar date or a date-time with an explicit zone designator whose fields
 * all exist on the calendar; a window is half-open [from, until); the schedule
 * is effective iff it is not paused, has occurrences left (or no limit) and
 * `now` lies inside the window.
 */

const MINUTE = 60_000
const pad = (value: number, width: number): string => String(value).padStart(width, "0")

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}
function monthLength(year: number, month: number): number {
  return month === 2 ? (isLeap(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31
}
/** Days since 1970-01-01 of a proleptic Gregorian date (independent of Date). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra - 719468
}

interface InstantParts { year: number; month: number; day: number; time: { hour: number; minute: number; second: number | null; fraction: string | null; zone: { sign: 1 | -1; hour: number; minute: number } | "Z" } | null }

function render(parts: InstantParts): string {
  const date = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`
  if (!parts.time) return date
  const { hour, minute, second, fraction, zone } = parts.time
  const zoneText = zone === "Z" ? "Z" : `${zone.sign === 1 ? "+" : "-"}${pad(zone.hour, 2)}:${pad(zone.minute, 2)}`
  return `${date}T${pad(hour, 2)}:${pad(minute, 2)}${second === null ? "" : `:${pad(second, 2)}${fraction === null ? "" : `.${fraction}`}`}${zoneText}`
}

/** Reference semantics: the epoch milliseconds of a valid instant, or null when the parts do not form one. */
function reference(parts: InstantParts): number | null {
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > monthLength(parts.year, parts.month)) return null
  const midnight = daysFromCivil(parts.year, parts.month, parts.day) * 86_400_000
  if (!parts.time) return midnight
  const { hour, minute, second, fraction, zone } = parts.time
  if (hour > 23 || minute > 59 || (second ?? 0) > 59) return null
  if (zone !== "Z" && (zone.hour > 23 || zone.minute > 59)) return null
  const offset = zone === "Z" ? 0 : zone.sign * (zone.hour * 60 + zone.minute) * MINUTE
  const millis = fraction === null ? 0 : Math.floor(Number(`0.${fraction}`) * 1000 + 1e-9)
  return midnight + hour * 3_600_000 + minute * MINUTE + (second ?? 0) * 1000 + millis - offset
}

function generateParts(rng: Rng): InstantParts {
  const year = rng.pick([1999, 2000, 2024, 2026, 2026, 2027, 2100, 2400, 1900, 9999])
  const month = rng.bool(0.9) ? 1 + rng.int(12) : rng.pick([0, 13, 99])
  const day = rng.bool(0.8) ? 1 + rng.int(monthLength(year, Math.min(Math.max(month, 1), 12))) : rng.pick([0, 29, 30, 31, 32, 99])
  const withTime = rng.bool(0.7)
  const hasSeconds = rng.bool(0.6)
  return {
    year, month, day,
    time: withTime ? {
      hour: rng.bool(0.9) ? rng.int(24) : rng.pick([24, 25, 99]),
      minute: rng.bool(0.9) ? rng.int(60) : rng.pick([60, 61, 99]),
      second: hasSeconds ? (rng.bool(0.9) ? rng.int(60) : rng.pick([60, 61])) : null,
      fraction: hasSeconds && rng.bool(0.4) ? rng.pick(["5", "123", "000", "999999", "0000000001"]) : null,
      zone: rng.bool(0.5) ? "Z" : { sign: rng.pick([1, -1] as const), hour: rng.bool(0.9) ? rng.int(15) : 24, minute: rng.pick([0, 30, 45, 60]) },
    } : null,
  }
}

const MALFORMED = ["", " ", "1", "2026", "2026-01", "foo 5", "March 7, 2026", "12/31/2026", "2026-03-07 10:00:00Z", "2026-03-07T10:00", "2026-03-07T10:00:00", "2026-03-07T10Z", "2026-03-07T10:00:00+0530", "2026-03-07T10:00:00 Z", " 2026-03-07", "2026-03-07 ", "2026-3-7", "26-03-07", "2026-03-07T10:00:00z", "2026-03-07t10:00:00Z", "+002026-03-07", "-000001-01-01", "2026-03-07T10:00:00.Z", "2026-03-07T10:00:00,5Z", "2026-W10-1", "NaN", "null", "undefined", "2026-03-07T24:00:00Z"]

function generateInstantText(rng: Rng): { text: string; expected: number | null } {
  if (rng.bool(0.25)) {
    const text = rng.pick(MALFORMED)
    return { text, expected: null }
  }
  const parts = generateParts(rng)
  return { text: render(parts), expected: reference(parts) }
}

describe("schedule lifecycle", () => {
  it("compileScheduleLifecycle accepts exactly strict ISO instants and orders the window", () => {
    forAll("schedule lifecycle instant validation matches the ISO reference", (rng) => ({
      from: rng.bool(0.8) ? generateInstantText(rng) : null,
      until: rng.bool(0.8) ? generateInstantText(rng) : null,
      remaining: rng.pick([undefined, 0, 1, 5, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, Number.POSITIVE_INFINITY]),
      paused: rng.pick([undefined, true, false]),
    }), ({ from, until, remaining, paused }) => {
      const input: Partial<ScheduleLifecycle> = {
        ...(from ? { effectiveFrom: from.text } : {}), ...(until ? { effectiveUntil: until.text } : {}),
        ...(remaining === undefined ? {} : { remainingOccurrences: remaining }), ...(paused === undefined ? {} : { paused }),
      }
      let expectedError: RegExp | null = null
      if (from && from.expected === null) expectedError = /effectiveFrom must be an ISO timestamp/
      else if (until && until.expected === null) expectedError = /effectiveUntil must be an ISO timestamp/
      else if (from && until && from.expected! >= until.expected!) expectedError = /effective range is empty/
      else if (remaining !== undefined && (!Number.isSafeInteger(remaining) || remaining < 0)) expectedError = /remainingOccurrences/
      if (expectedError) {
        expect(() => compileScheduleLifecycle(input), JSON.stringify(input)).toThrow(expectedError)
        return
      }
      const compiled = compileScheduleLifecycle(input)
      expect(compiled.paused).toBe(paused ?? false)
      expect(compiled.effectiveFrom).toBe(input.effectiveFrom)
      expect(compiled.effectiveUntil).toBe(input.effectiveUntil)
      expect(compiled.remainingOccurrences).toBe(remaining)
      expect(Object.isFrozen(compiled)).toBe(true)
    }, { runs: 600 })
  })

  it("isScheduleEffective is paused-false, occurrences-left and now in [from, until), with exact boundaries", () => {
    forAll("schedule lifecycle effectiveness follows the half-open window", (rng) => {
      const base = Date.UTC(2026, 0, 1) + rng.int(400) * 86_400_000 + rng.int(1440) * MINUTE
      return {
        paused: rng.bool(0.2),
        remaining: rng.pick([undefined, undefined, 0, 1, 7]),
        from: rng.bool(0.6) ? base : null,
        until: rng.bool(0.6) ? base + (1 + rng.int(5000)) * MINUTE : null,
        probe: rng.pick(["before-from", "at-from", "after-from", "before-until", "at-until", "after-until", "arbitrary"] as const),
        arbitrary: base + (rng.int(10000) - 2000) * MINUTE,
      }
    }, (value) => {
      const lifecycle = compileScheduleLifecycle({
        paused: value.paused, ...(value.remaining === undefined ? {} : { remainingOccurrences: value.remaining }),
        ...(value.from === null ? {} : { effectiveFrom: new Date(value.from).toISOString() }), ...(value.until === null ? {} : { effectiveUntil: new Date(value.until).toISOString() }),
      })
      const at: Record<typeof value.probe, number> = {
        "before-from": (value.from ?? value.arbitrary) - 1, "at-from": value.from ?? value.arbitrary, "after-from": (value.from ?? value.arbitrary) + 1,
        "before-until": (value.until ?? value.arbitrary) - 1, "at-until": value.until ?? value.arbitrary, "after-until": (value.until ?? value.arbitrary) + 1,
        arbitrary: value.arbitrary,
      }
      const now = at[value.probe]
      const expected = !value.paused && (value.remaining === undefined || value.remaining > 0) && (value.from === null || now >= value.from) && (value.until === null || now < value.until)
      expect(isScheduleEffective(lifecycle, new Date(now))).toBe(expected)
    }, { runs: 400 })
  })

  it("assertFencedScheduleClaim accepts only non-blank string tokens", () => {
    forAll("fenced schedule claim token validation", (rng) => rng.pick<unknown>(["token", "t", " x ", "", "   ", "\n\t", null, undefined, 0, 1, {}, [], " ", "​"]), (token) => {
      const valid = typeof token === "string" && token.trim().length > 0
      const run = () => assertFencedScheduleClaim(token as string | null | undefined, "s1")
      if (valid) expect(run).not.toThrow()
      else expect(run).toThrow(/no claim token/)
    }, { runs: 100 })
  })
})
