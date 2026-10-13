import { describe, expect, it } from "vitest"
import { parseIsoInstant } from "../isoInstant"

describe("parseIsoInstant", () => {
  it("reads a calendar date as UTC midnight and a date-time with an explicit zone", () => {
    expect(parseIsoInstant("2026-02-03")).toBe(Date.UTC(2026, 1, 3))
    expect(parseIsoInstant("2026-02-03T04:05:06.789Z")).toBe(Date.UTC(2026, 1, 3, 4, 5, 6, 789))
    expect(parseIsoInstant("2026-02-03T04:05Z")).toBe(Date.UTC(2026, 1, 3, 4, 5))
    expect(parseIsoInstant("2026-02-03T04:05:06+02:00")).toBe(Date.UTC(2026, 1, 3, 2, 5, 6))
    expect(parseIsoInstant("2024-02-29")).toBe(Date.UTC(2024, 1, 29))
  })

  it("returns NaN for free text, impossible fields, zone-less date-times and non-strings", () => {
    for (const text of ["foo 5", "1", "", "2026-02-30", "2026-02-29", "2026-13-01", "2026-00-10", "2026-01-00", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z",
      "2026-01-01T00:00:00", "2026-01-01T00:00:00+24:00", "2026-01-01T00:00:00+00:60", "+010000-01-01T00:00:00.000Z", " 2026-01-01", "2026-01-01 "]) {
      expect(parseIsoInstant(text), text).toBeNaN()
    }
    for (const value of [undefined, null, 5, new Date(0), {}]) expect(parseIsoInstant(value)).toBeNaN()
  })
})
