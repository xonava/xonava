import { describe, expect, it } from "vitest"
import { Predicate } from "../../domain"
import { compileRuleSet, evaluateRuleSet } from ".."

const compileWith = (window: { effectiveFrom?: string; effectiveUntil?: string }) =>
  compileRuleSet({ key: "set", version: 1, conflictResolution: { kind: "all-matches" }, rules: [{ key: "r", version: 1, priority: 1, when: Predicate.isTrue("on"), actions: [{ type: "x" }], ...window }] })

describe("rule effective window instants", () => {
  it("accepts canonical instants", () => {
    const compiled = compileWith({ effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2026-02-01T00:00:00.000Z" })
    expect(evaluateRuleSet(compiled, { on: true }, new Date("2026-01-15T00:00:00.000Z")).actions).toHaveLength(1)
  })

  it.each([
    "foo 5", "1", "2026-02-30T00:00:00.000Z", "2026-01-01T00:00:00.000", "2026-01-01", "2026-01-01T00:00:00Z", "2026-01-01T02:00:00.000+02:00",
    "+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z",
  ])("rejects %j as effectiveFrom and effectiveUntil", (text) => {
    expect(() => compileWith({ effectiveFrom: text })).toThrow(/effectiveFrom must be a canonical ISO-8601 instant/)
    expect(() => compileWith({ effectiveUntil: text })).toThrow(/effectiveUntil must be a canonical ISO-8601 instant/)
  })
})
