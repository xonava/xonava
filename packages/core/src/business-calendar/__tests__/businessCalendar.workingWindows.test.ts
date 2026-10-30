import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { validateWorkingWindows, type WorkingWindow } from "../businessCalendar"

const R = "Business-calendar range must be valid and increasing."
const W = "Business-calendar windows must be ordered, non-overlapping and within range."
const d = (n: number) => new Date(n)
const w = (start: number, end: number): WorkingWindow => ({ start: d(start), end: d(end) })
const fails = (from: unknown, to: unknown, windows: unknown, message: string) => {
  try { validateWorkingWindows(from as never, to as never, windows as never) } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    expect((e as Error).message).toBe(message)
    return
  }
  throw new Error(`expected: ${message}`)
}

describe("validateWorkingWindows range", () => {
  it("requires valid, strictly increasing dates and an array", () => {
    fails(d(10), d(10), [], R)
    fails(d(11), d(10), [], R)
    fails("a", d(10), [], R)
    fails(d(1), "b", [], R)
    fails(d(Number.NaN), d(10), [], R)
    fails(d(1), d(Number.NaN), [], R)
    fails(d(1), d(10), "x", R)
    expect(validateWorkingWindows(d(1), d(2), [])).toEqual([])
  })
})

describe("validateWorkingWindows windows", () => {
  it("rejects malformed, inverted, out-of-range and overlapping windows", () => {
    fails(d(0), d(100), [null], W)
    fails(d(0), d(100), ["x"], W)
    fails(d(0), d(100), [{ start: 1, end: d(5) }], W)
    fails(d(0), d(100), [{ start: d(1), end: 5 }], W)
    fails(d(0), d(100), [{ start: d(Number.NaN), end: d(5) }], W)
    fails(d(0), d(100), [{ start: d(1), end: d(Number.NaN) }], W)
    fails(d(0), d(100), [w(5, 5)], W)
    fails(d(0), d(100), [w(6, 5)], W)
    fails(d(10), d(100), [w(9, 20)], W)
    fails(d(0), d(100), [w(10, 101)], W)
    fails(d(0), d(100), [w(10, 30), w(29, 40)], W)
    fails(d(0), d(100), [w(10, 30), w(5, 8)], W)
  })
  it("accepts windows touching the range and each other", () => {
    const out = validateWorkingWindows(d(0), d(100), [w(0, 30), w(30, 60), w(61, 100)])
    expect(out.map(x => [x.start.getTime(), x.end.getTime()])).toEqual([[0, 30], [30, 60], [61, 100]])
  })
  it("returns a frozen snapshot labelled as business-calendar windows", () => {
    const input = [w(1, 2)]
    const out = validateWorkingWindows(d(0), d(10), input)
    expect(out).not.toBe(input)
    expect(Object.isFrozen(out)).toBe(true)
    expect(out[0]!.start).not.toBe(input[0]!.start)
    expect(() => validateWorkingWindows(d(0), d(10), [{ start: d(1), end: d(2), extra: () => 1 }] as never)).toThrow("Business-calendar windows must contain data only")
  })
})
