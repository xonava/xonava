import { describe, expect, it } from "vitest"
import { parseRfc3339Timestamp } from "../domain/evaluatePredicate"
import { parseTimeWindowMs } from "../rate-limit/rateLimit"
import { parseCronExpression } from "../execution/scheduleCalculator"
import { compileScheduleLifecycle } from "../execution/scheduleLifecycle"
import { canonicalJsonString } from "../serialization/canonicalJson"
import { expectNearLinear } from "./timing"

/**
 * Guards for untrusted, unbounded text reaching the regular expressions in core. Every shape is 200 kB; the cost on it is compared with the
 * cost on a quarter of it, so the result does not depend on machine speed or load (a backtracking blow-up grows sixteen-fold).
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

/** The cost on the whole shape must stay within a small multiple of the cost on a quarter of it (see expectNearLinear). */
const nearLinear = (text: string, run: (text: string) => unknown) =>
  expectNearLinear((size) => { const part = text.slice(0, size); return () => { try { run(part) } catch { /* rejection is the expected outcome */ } } }, { size: text.length })

describe.each(shapes)("adversarial input: %s", (_name, text) => {
  it("parseRfc3339Timestamp", async () => { await nearLinear(text, parseRfc3339Timestamp) })
  it("parseTimeWindowMs", async () => { await nearLinear(text, parseTimeWindowMs) })
  it("parseCronExpression", async () => { await nearLinear(text, parseCronExpression) })
  it("compileScheduleLifecycle", async () => { await nearLinear(text, (part) => compileScheduleLifecycle({ effectiveFrom: part, effectiveUntil: part })) })
  it("canonicalJsonString", async () => { await nearLinear(text, (part) => canonicalJsonString({ [part.slice(0, 1000)]: part })) })
})
