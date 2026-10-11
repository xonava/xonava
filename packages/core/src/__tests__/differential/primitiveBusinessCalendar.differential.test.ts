import { describe, expect, it } from "vitest"
import { forAll, type Rng } from "./harness"
import { ValidationError } from "../../domain/errors"
import { validateWorkingWindows } from "../../business-calendar/businessCalendar"

/**
 * core/business-calendar ships only the port contract and `validateWorkingWindows`
 * (there is no business-day arithmetic in core to compare with a day-by-day
 * oracle), so the differential target is the window validator: a pairwise
 * brute-force check of "valid, within [from, to], ordered, non-overlapping".
 */

interface WindowCase { from: unknown; to: unknown; windows: unknown }

function generateWindows(rng: Rng): WindowCase {
  const hostile = rng.bool(0.5)
  const instant = (): Date => new Date(rng.int(12))
  const from = hostile && rng.bool(0.15) ? rng.pick([new Date(NaN), 5, "x", null, undefined] as unknown[]) : new Date(rng.int(4))
  const to = hostile && rng.bool(0.15) ? rng.pick([new Date(NaN), 5, "x", null, undefined] as unknown[]) : new Date(6 + rng.int(6))
  if (hostile && rng.bool(0.1)) return { from, to, windows: rng.pick([null, undefined, {}, "w", 5] as unknown[]) }
  const count = rng.int(5)
  const windows: unknown[] = []
  // Mostly well-formed ascending windows with occasional defects.
  let cursor = from instanceof Date && !Number.isNaN(from.getTime()) ? from.getTime() : 0
  for (let i = 0; i < count; i++) {
    const start = cursor + rng.int(3)
    const end = start + 1 + rng.int(3)
    cursor = end
    let window: unknown = { start: new Date(start), end: new Date(end) }
    if (hostile) {
      const defect = rng.int(10)
      if (defect === 0) window = { start: new Date(end), end: new Date(start) }
      else if (defect === 1) window = { start: instant(), end: instant() }
      else if (defect === 2) window = rng.pick([null, 5, "w", [], { start: 1, end: 2 }, { start: new Date(NaN), end: new Date(3) }, { start: new Date(1) }] as unknown[])
      else if (defect === 3) window = { start: new Date(start), end: new Date(start) }
    }
    windows.push(window)
  }
  return { from, to, windows }
}

function oracleValid(c: WindowCase): boolean {
  const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime())
  if (!isDate(c.from) || !isDate(c.to) || !Array.isArray(c.windows)) return false
  if (c.from.getTime() >= c.to.getTime()) return false
  const ws = c.windows as Array<{ start?: unknown; end?: unknown } | null>
  for (const w of ws) {
    if (!w || typeof w !== "object" || !isDate(w.start) || !isDate(w.end)) return false
    if (w.start.getTime() >= w.end.getTime()) return false
    if (w.start.getTime() < c.from.getTime() || w.end.getTime() > c.to.getTime()) return false
  }
  // Pairwise (brute force): any earlier window must end no later than a later window starts.
  for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) if ((ws[i]!.end as Date).getTime() > (ws[j]!.start as Date).getTime()) return false
  return true
}

describe("business-calendar working windows", () => {
  it("validateWorkingWindows ≡ pairwise brute-force validity; accepted windows are a frozen, defensive copy; every rejection is a ValidationError", () => {
    forAll("business calendar window validity", generateWindows, (c) => {
      const valid = oracleValid(c)
      let thrown: unknown
      let out: ReturnType<typeof validateWorkingWindows> | undefined
      try { out = validateWorkingWindows(c.from as Date, c.to as Date, c.windows as never) } catch (error) { thrown = error }
      if (!valid) { expect(thrown, "invalid input accepted").toBeInstanceOf(ValidationError); return }
      expect(thrown, "valid input rejected").toBeUndefined()
      const input = c.windows as Array<{ start: Date; end: Date }>
      expect(out!.map((w) => [w.start.getTime(), w.end.getTime()])).toEqual(input.map((w) => [w.start.getTime(), w.end.getTime()]))
      expect(Object.isFrozen(out)).toBe(true)
      // Mutating the caller's dates or the returned dates never changes what the other side sees.
      const before = out!.map((w) => [w.start.getTime(), w.end.getTime()])
      for (const w of input) { w.start.setTime(-1); w.end.setTime(-1) }
      for (const w of out!) { w.start.setTime(-2); w.end.setTime(-2) }
      expect(out!.map((w) => [w.start.getTime(), w.end.getTime()])).toEqual(before)
    }, { runs: 600, describe: (c) => JSON.stringify(c, (_k, v: unknown) => (v === undefined ? "<undefined>" : v)) })
  })
})
