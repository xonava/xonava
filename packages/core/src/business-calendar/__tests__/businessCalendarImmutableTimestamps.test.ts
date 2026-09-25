import { describe, expect, it } from "vitest"
import { validateWorkingWindows } from "../businessCalendar"

describe("business calendar timestamp snapshots", () => {
  it("isolates dates in the frozen window array", () => {
    const start = new Date("2026-01-01T09:00:00.000Z"), end = new Date("2026-01-01T17:00:00.000Z")
    const windows = validateWorkingWindows(new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-02T00:00:00.000Z"), [{ start, end }])
    start.setTime(0); end.setTime(0); windows[0]!.start.setTime(1); Date.prototype.setTime.call(windows[0]!.end, 1)
    expect(windows[0]!.start.toISOString()).toBe("2026-01-01T09:00:00.000Z")
    expect(windows[0]!.end.toISOString()).toBe("2026-01-01T17:00:00.000Z")
    expect(Object.isFrozen(windows)).toBe(true)
    expect(Object.isFrozen(windows[0])).toBe(true)
  })

  it("rejects invalid window dates", () => {
    expect(() => validateWorkingWindows(new Date(0), new Date(2), [{ start: new Date(NaN), end: new Date(1) }])).toThrow()
  })
})
