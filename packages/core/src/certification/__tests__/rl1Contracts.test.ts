import { describe, expect, it } from "vitest"
import { Predicate } from "../../domain"
import { compileRuleSet, evaluateRuleSet } from "../../rules"

describe("rule-engine contracts", () => {
  it("is deterministic for the same compiled definition, facts, and trusted time", () => {
    const compiled = compileRuleSet({ key: "eligibility", version: 2, conflictResolution: { kind: "all-matches" }, rules: [
      { key: "adult", version: 1, priority: 1, when: Predicate.gte("age", 18), actions: [{ type: "eligible" }] },
    ] })
    const time = new Date("2026-01-01T00:00:00.000Z")
    expect(evaluateRuleSet(compiled, { age: 20 }, time)).toEqual(evaluateRuleSet(compiled, { age: 20 }, time))
  })

  it("separates decisions from effect execution", () => {
    const compiled = compileRuleSet({ key: "approval", version: 1, conflictResolution: { kind: "all-matches" }, rules: [
      { key: "manual-review", version: 1, priority: 1, when: Predicate.gt("amount", 1000), actions: [{ type: "start-workflow", workflowKey: "manual-review" }] },
    ] })
    expect(evaluateRuleSet(compiled, { amount: 1001 }, new Date()).actions).toEqual([{ type: "start-workflow", workflowKey: "manual-review" }])
  })
})
