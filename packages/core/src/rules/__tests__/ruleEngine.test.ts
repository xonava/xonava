import { describe, expect, it } from "vitest"
import { ConfigurationError, Predicate } from "../../domain"
import { compileRuleSet, evaluateRuleSet, isCompiledRuleSet, type RuleSetDefinition } from ".."

type Action = Readonly<{ type: string; value?: number; dates?: readonly Date[] }>

const rule = (overrides: Record<string, unknown> = {}) => ({
  key: "discount.standard", version: 1, priority: 10,
  when: Predicate.gte("total", 100), actions: [{ type: "discount", value: 10 }],
  ...overrides,
})

function compile(rules = [rule()], conflictResolution: RuleSetDefinition<Action>["conflictResolution"] = { kind: "all-matches" }) {
  return compileRuleSet<Action>({ key: "checkout", version: 1, rules, conflictResolution })
}

describe("rule key validation", () => {
  it.each([
    ["rule-set key", () => compileRuleSet<Action>({ key: ["rs"] as never, version: 1, rules: [rule()], conflictResolution: { kind: "all-matches" } })],
    ["rule key", () => compile([rule({ key: ["r1"] })])],
    ["conflict key", () => compile([rule({ conflictKey: ["c1"] })])],
  ])("rejects a non-string %s that a regular expression would coerce to a valid key", (_name, build) => {
    // Before the fix KEY.test(["rs"]) coerced the array to "rs" and compilation succeeded.
    expect(build).toThrow(ConfigurationError)
  })
})

describe("business rule engine", () => {
  it("evaluates matching predicates and returns declarative actions", () => {
    const result = evaluateRuleSet(compile(), { total: 150 }, new Date("2026-01-01T00:00:00.000Z"))
    expect(result.actions).toEqual([{ type: "discount", value: 10 }])
    expect(result.matches).toMatchObject([{ key: "discount.standard", version: 1 }])
    expect(result.trace).toMatchObject([{ disposition: "selected" }])
  })

  it("returns a not-matched trace without actions", () => {
    const result = evaluateRuleSet(compile(), { total: 99 }, new Date("2026-01-01T00:00:00.000Z"))
    expect(result.actions).toEqual([])
    expect(result.trace[0]?.disposition).toBe("not-matched")
  })

  it("uses inclusive starts and exclusive ends", () => {
    const compiled = compile([rule({ effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2026-02-01T00:00:00.000Z" })])
    expect(evaluateRuleSet(compiled, { total: 100 }, new Date("2025-12-31T23:59:59.999Z")).trace[0]?.disposition).toBe("inactive")
    expect(evaluateRuleSet(compiled, { total: 100 }, new Date("2026-01-01T00:00:00.000Z")).matches).toHaveLength(1)
    expect(evaluateRuleSet(compiled, { total: 100 }, new Date("2026-02-01T00:00:00.000Z")).trace[0]?.disposition).toBe("inactive")
  })

  it("selects the highest active version of each rule key", () => {
    const compiled = compile([
      rule({ version: 1, actions: [{ type: "old" }] }),
      rule({ version: 3, actions: [{ type: "new" }] }),
      rule({ version: 2, actions: [{ type: "middle" }] }),
    ])
    const result = evaluateRuleSet(compiled, { total: 100 }, new Date("2026-01-01T00:00:00.000Z"))
    expect(result.actions).toEqual([{ type: "new" }])
    expect(result.trace.map(item => item.disposition)).toEqual(["superseded", "selected", "superseded"])
  })

  it("falls back to an older version when a newer version is not effective", () => {
    const compiled = compile([
      rule({ version: 1, actions: [{ type: "current" }] }),
      rule({ version: 2, effectiveFrom: "2027-01-01T00:00:00.000Z", actions: [{ type: "future" }] }),
    ])
    const result = evaluateRuleSet(compiled, { total: 100 }, new Date("2026-01-01T00:00:00.000Z"))
    expect(result.actions).toEqual([{ type: "current" }])
    expect(result.trace.map(item => item.disposition)).toEqual(["selected", "inactive"])
  })

  it("orders all matches deterministically by priority then key", () => {
    const compiled = compile([
      rule({ key: "z", priority: 1, actions: [{ type: "z" }] }),
      rule({ key: "b", priority: 5, actions: [{ type: "b" }] }),
      rule({ key: "a", priority: 5, actions: [{ type: "a" }] }),
    ])
    expect(evaluateRuleSet(compiled, { total: 100 }, new Date()).actions.map(action => action.type)).toEqual(["a", "b", "z"])
  })

  it("selects one global highest-priority match", () => {
    const compiled = compile([
      rule({ key: "low", priority: 1, actions: [{ type: "low" }] }),
      rule({ key: "high", priority: 2, actions: [{ type: "high" }] }),
    ], { kind: "highest-priority", onPriorityTie: "rule-key" })
    const result = evaluateRuleSet(compiled, { total: 100 }, new Date())
    expect(result.actions).toEqual([{ type: "high" }])
    expect(result.trace.map(item => item.disposition)).toEqual(["conflict-discarded", "selected"])
  })

  it("resolves independently per conflict key and leaves ungrouped rules independent", () => {
    const compiled = compile([
      rule({ key: "shipping.slow", conflictKey: "shipping", priority: 1, actions: [{ type: "slow" }] }),
      rule({ key: "shipping.fast", conflictKey: "shipping", priority: 2, actions: [{ type: "fast" }] }),
      rule({ key: "notify", priority: 0, actions: [{ type: "notify" }] }),
    ], { kind: "highest-priority-per-key", onPriorityTie: "rule-key" })
    expect(evaluateRuleSet(compiled, { total: 100 }, new Date()).actions.map(action => action.type)).toEqual(["fast", "notify"])
  })

  it("uses lexical keys as an explicit deterministic tie breaker", () => {
    const compiled = compile([
      rule({ key: "b", priority: 1, actions: [{ type: "b" }] }),
      rule({ key: "a", priority: 1, actions: [{ type: "a" }] }),
    ], { kind: "highest-priority", onPriorityTie: "rule-key" })
    expect(evaluateRuleSet(compiled, { total: 100 }, new Date()).actions).toEqual([{ type: "a" }])
  })

  it("fails closed on an ambiguous configured priority tie", () => {
    const compiled = compile([
      rule({ key: "a", priority: 1 }), rule({ key: "b", priority: 1 }),
    ], { kind: "highest-priority", onPriorityTie: "error" })
    expect(() => evaluateRuleSet(compiled, { total: 100 }, new Date())).toThrow(/priority tie/)
  })

  it("defensively snapshots definitions, actions, facts, dates, and results", () => {
    const actionDate = new Date("2026-01-03T00:00:00.000Z")
    const action = { type: "discount", value: 10, dates: [actionDate] }
    const predicate = Predicate.gte("total", 100)
    const rules = [rule({ actions: [action], when: predicate })]
    const compiled = compile(rules)
    action.value = 99
    predicate.field = "forged"
    rules.length = 0
    const factDate = new Date("2026-01-01T00:00:00.000Z")
    const result = evaluateRuleSet(compiled, { total: 100, factDate }, new Date("2026-01-02T00:00:00.000Z"))
    const evaluatedAt = result.evaluatedAt
    factDate.setUTCFullYear(2030)
    actionDate.setTime(0); evaluatedAt.setTime(0); result.actions[0]!.dates![0]!.setTime(0)
    expect(result.evaluatedAt.toISOString()).toBe("2026-01-02T00:00:00.000Z")
    expect(result.actions[0]!.dates![0]!.toISOString()).toBe("2026-01-03T00:00:00.000Z")
    expect(result.actions).toEqual([{ type: "discount", value: 10, dates: [new Date("2026-01-03T00:00:00.000Z")] }])
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.rules)).toBe(true)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.trace)).toBe(true)
    expect(Object.isFrozen(result.actions[0])).toBe(true)
  })

  it("rejects forged compiled objects", () => {
    const forged = { ...compile() }
    expect(isCompiledRuleSet(forged)).toBe(false)
    expect(() => evaluateRuleSet(forged, {}, new Date())).toThrow(/compiled rule set/)
  })

  it.each([
    [{ key: "", version: 1, rules: [], conflictResolution: { kind: "all-matches" } }, /key/],
    [{ key: "set", version: 0, rules: [], conflictResolution: { kind: "all-matches" } }, /version/],
    [{ key: "set", version: 1, rules: [rule({ version: 0 })], conflictResolution: { kind: "all-matches" } }, /version/],
    [{ key: "set", version: 1, rules: [rule({ priority: 1.5 })], conflictResolution: { kind: "all-matches" } }, /priority/],
    [{ key: "set", version: 1, rules: [rule({ actions: [] })], conflictResolution: { kind: "all-matches" } }, /actions/],
    [{ key: "set", version: 1, rules: [rule(), rule()], conflictResolution: { kind: "all-matches" } }, /Duplicate/],
    [{ key: "set", version: 1, rules: [rule({ effectiveFrom: "invalid" })], conflictResolution: { kind: "all-matches" } }, /ISO-8601/],
    [{ key: "set", version: 1, rules: [rule({ effectiveFrom: "2026-02-01T00:00:00.000Z", effectiveUntil: "2026-01-01T00:00:00.000Z" })], conflictResolution: { kind: "all-matches" } }, /increasing/],
  ] as const)("rejects invalid definitions %#", (definition, message) => {
    expect(() => compileRuleSet(definition as never)).toThrow(message)
  })

  it("rejects executable/accessor-backed or oversized data", () => {
    expect(() => compile([rule({ actions: [{ type: "x", execute: () => undefined }] })])).toThrow(/data only/)
    const getter = Object.defineProperty({}, "secret", { get: () => "executed", enumerable: true })
    expect(() => evaluateRuleSet(compile(), getter, new Date())).toThrow(/accessors/)
    expect(() => evaluateRuleSet(compile(), { amount: NaN }, new Date())).toThrow(/non-finite/)
    expect(() => compile([rule({ actions: [{ type: "x", at: new Date(NaN) }] })])).toThrow(/invalid date/)
  })

  it("rejects malformed predicate trees instead of silently treating them as false", () => {
    expect(() => compile([rule({ when: { kind: "unknown" } })])).toThrow(/kind/)
    expect(() => compile([rule({ when: { kind: "condition", field: "", op: "eq", value: 1 } })])).toThrow(/condition/)
  })

  it("requires a caller-supplied valid evaluation time", () => {
    expect(() => evaluateRuleSet(compile(), {}, new Date(NaN))).toThrow(/trusted timestamp/)
  })

  it("does not mutate or execute action data", () => {
    let invoked = false
    expect(() => compile([rule({ actions: [{ type: "x", get value() { invoked = true; return 1 } }] })])).toThrow()
    expect(invoked).toBe(false)
  })
})
