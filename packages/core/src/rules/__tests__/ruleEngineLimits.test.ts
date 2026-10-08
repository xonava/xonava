import { describe, expect, it } from "vitest"
import { ConfigurationError, Predicate, ValidationError } from "../../domain"
import { compileRuleSet, evaluateRuleSet, MAX_RULE_NODES, MAX_RULE_SET_RULES, type RuleDefinition } from ".."

type Action = Readonly<{ type: string }>

const trivialRule = (index: number): RuleDefinition<Action> => ({
  key: `rule.${index}`, version: 1, priority: 0, when: { kind: "literal", value: true }, actions: [{ type: "noop" }],
})

describe("rule engine declared limits", () => {
  it("compiles and evaluates the advertised maximum number of rules", () => {
    const rules = Array.from({ length: MAX_RULE_SET_RULES }, (_, index) => trivialRule(index))
    const compiled = compileRuleSet<Action>({ key: "large", version: 1, rules, conflictResolution: { kind: "all-matches" } })
    expect(compiled.rules).toHaveLength(MAX_RULE_SET_RULES)
    const result = evaluateRuleSet(compiled, {}, new Date("2026-01-01T00:00:00.000Z"))
    expect(result.matches).toHaveLength(MAX_RULE_SET_RULES)
    expect(result.trace).toHaveLength(MAX_RULE_SET_RULES)
  })

  it("rejects more rules than advertised with a ConfigurationError", () => {
    const rules = Array.from({ length: MAX_RULE_SET_RULES + 1 }, (_, index) => trivialRule(index))
    expect(() => compileRuleSet<Action>({ key: "large", version: 1, rules, conflictResolution: { kind: "all-matches" } })).toThrow(ConfigurationError)
  })

  it("reports an oversized single rule as a ConfigurationError rather than a raw RangeError", () => {
    const actions = [{ type: "big", items: Array.from({ length: MAX_RULE_NODES }, () => ({ n: 1 })) }]
    let caught: unknown
    try {
      compileRuleSet<Action>({ key: "big", version: 1, rules: [{ ...trivialRule(0), actions }], conflictResolution: { kind: "all-matches" } })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfigurationError)
    expect((caught as Error).message).toMatch(/node count/)
  })

  it("reports non-data rule content as a ConfigurationError", () => {
    const rules = [{ ...trivialRule(0), actions: [{ type: "x", execute: () => undefined }] }]
    expect(() => compileRuleSet({ key: "bad", version: 1, rules, conflictResolution: { kind: "all-matches" } } as never)).toThrow(ConfigurationError)
    expect(() => compileRuleSet({ key: "bad", version: 1, rules: [{ ...trivialRule(0), when: Predicate.eq("x", (() => 1) as never) }], conflictResolution: { kind: "all-matches" } } as never)).toThrow(ConfigurationError)
  })

  it("reports invalid facts as a ValidationError", () => {
    const compiled = compileRuleSet<Action>({ key: "set", version: 1, rules: [trivialRule(0)], conflictResolution: { kind: "all-matches" } })
    expect(() => evaluateRuleSet(compiled, { amount: Number.NaN }, new Date())).toThrow(ValidationError)
  })
})

describe("rule engine conflict groups", () => {
  it("does not let a user conflict key collide with another rule's implicit group", () => {
    const compiled = compileRuleSet<Action>({
      key: "set", version: 1,
      conflictResolution: { kind: "highest-priority-per-key", onPriorityTie: "rule-key" },
      rules: [
        { key: "a", version: 1, priority: 1, when: { kind: "literal", value: true }, actions: [{ type: "a" }] },
        { key: "b", version: 1, priority: 2, conflictKey: "rule:a", when: { kind: "literal", value: true }, actions: [{ type: "b" }] },
      ],
    })
    const result = evaluateRuleSet(compiled, {}, new Date())
    expect(result.actions.map(action => action.type).sort()).toEqual(["a", "b"])
    expect(result.trace.map(entry => entry.disposition)).toEqual(["selected", "selected"])
  })
})
