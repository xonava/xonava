import { describe, expect, it } from "vitest"
import { parseRfc3339Timestamp } from "../domain/evaluatePredicate"
import { parseTimeWindowMs } from "../rate-limit/rateLimit"
import { parseCronExpression } from "../execution/scheduleCalculator"
import { compileScheduleLifecycle } from "../execution/scheduleLifecycle"
import { canonicalJsonString } from "../serialization/canonicalJson"

/**
 * Guards for untrusted, unbounded text reaching the regular expressions in core. Every shape is 200 kB; the bound is generous
 * (a linear scan takes a few ms) but a backtracking blow-up takes seconds to minutes.
 */
const SIZE = 200_000
const shapes: Array<[string, string]> = [
  ["digits", "1".repeat(SIZE)],
  ["digit-space pairs", "1 ".repeat(SIZE / 2)],
  ["spaces", " ".repeat(SIZE)],
  ["dash pairs", "1-".repeat(SIZE / 2)],
  ["dot pairs", "a.".repeat(SIZE / 2)],
  ["slash groups", "0-0/".repeat(SIZE / 4)],
  ["valid prefix then digits", `2026-01-01T00:00:00.${"0".repeat(SIZE)}`],
  ["colon groups", `a${":v1".repeat(SIZE / 3)}`],
]

function elapsed(fn: () => unknown): number {
  const started = performance.now()
  try { fn() } catch { /* rejection is the expected outcome */ }
  return performance.now() - started
}

describe.each(shapes)("adversarial input: %s", (_name, text) => {
  it("parseRfc3339Timestamp", () => { expect(elapsed(() => parseRfc3339Timestamp(text))).toBeLessThan(500) })
  it("parseTimeWindowMs", () => { expect(elapsed(() => parseTimeWindowMs(text))).toBeLessThan(500) })
  it("parseCronExpression", () => { expect(elapsed(() => parseCronExpression(text))).toBeLessThan(500) })
  it("compileScheduleLifecycle", () => { expect(elapsed(() => compileScheduleLifecycle({ effectiveFrom: text, effectiveUntil: text }))).toBeLessThan(500) })
  it("canonicalJsonString", () => { expect(elapsed(() => canonicalJsonString({ [text.slice(0, 1000)]: text }))).toBeLessThan(500) })
})
