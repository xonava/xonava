import { describe, expect, it } from "vitest"
import { ConfigurationError, Predicate, ValidationError, type PredicateNode } from "../../domain"
import { compileRuleSet, evaluateRuleSet, isCompiledRuleSet, MAX_RULE_NODES, MAX_RULE_SET_RULES, type RuleDefinition, type RuleSetDefinition } from ".."
import { snapshotRuleData } from "../snapshot"

const T = Predicate.isTrue("on")
const F = Predicate.isTrue("off")
const rule = (o: Partial<RuleDefinition> = {}): RuleDefinition => ({ key: "r", version: 1, priority: 1, when: T, actions: [{ type: "x" }], ...o })
const set = (rules: RuleDefinition[], resolution: RuleSetDefinition["conflictResolution"] = { kind: "all-matches" }): RuleSetDefinition => ({ key: "set", version: 1, conflictResolution: resolution, rules })
const bad = (definition: unknown, message: string) => {
  expect(() => compileRuleSet(definition as never)).toThrow(new ConfigurationError(message))
}
const badRule = (o: Partial<RuleDefinition>, message: string) => bad(set([rule(o)]), message)
const at = new Date("2026-01-01T00:00:00.000Z")
const lit = (value: unknown) => ({ kind: "literal", value }) as unknown as PredicateNode
const andOf = (filters: unknown[], kind = "and") => ({ kind, filters }) as unknown as PredicateNode
const nested = (levels: number, wrap: (inner: PredicateNode) => PredicateNode): PredicateNode => {
  let node: PredicateNode = lit(true)
  for (let i = 0; i < levels; i += 1) node = wrap(node)
  return node
}

describe("rule predicate validation", () => {
  const structural = "Rule predicate exceeds structural limits"
  it("limits nodes to 1000 inclusively", () => {
    expect(isCompiledRuleSet(compileRuleSet(set([rule({ when: andOf(Array.from({ length: 999 }, () => lit(true))) })])))).toBe(true)
    badRule({ when: andOf(Array.from({ length: 1000 }, () => lit(true))) }, structural)
  })
  it("limits depth to 32 inclusively for not and rejects deeper and/or/not chains", () => {
    const not = (n: PredicateNode) => ({ kind: "not", filter: n }) as unknown as PredicateNode
    expect(isCompiledRuleSet(compileRuleSet(set([rule({ when: nested(32, not) })])))).toBe(true)
    for (const wrap of [(n: PredicateNode) => andOf([n]), (n: PredicateNode) => andOf([n], "or"), not]) {
      expect(isCompiledRuleSet(compileRuleSet(set([rule({ when: nested(15, wrap) })])))).toBe(true)
      badRule({ when: nested(33, wrap) }, structural)
    }
  })
  it("rejects null and non-object nodes", () => {
    badRule({ when: andOf([null]) }, structural)
    badRule({ when: andOf(["x"]) }, structural)
    badRule({ when: andOf([5]) }, structural)
    badRule({ when: null as never }, structural)
  })
  it("requires boolean literals", () => {
    badRule({ when: lit("true") }, "Rule predicate literal must be boolean")
    badRule({ when: lit(undefined) }, "Rule predicate literal must be boolean")
    for (const v of [true, false]) expect(isCompiledRuleSet(compileRuleSet(set([rule({ when: lit(v) })])))).toBe(true)
  })
  it("validates conditions", () => {
    const m = "Rule predicate condition is invalid"
    const cond = (extra: Record<string, unknown>) => ({ kind: "condition", field: "f", op: "eq", value: 1, ...extra }) as unknown as PredicateNode
    badRule({ when: cond({ field: undefined }) }, m)
    badRule({ when: cond({ field: "" }) }, m)
    badRule({ when: cond({ field: "  " }) }, m)
    badRule({ when: cond({ field: "f".repeat(201) }) }, m)
    badRule({ when: cond({ op: "nope" }) }, m)
    expect(isCompiledRuleSet(compileRuleSet(set([rule({ when: cond({ field: "f".repeat(200) }) })])))).toBe(true)
    badRule({ when: cond({ value: () => 1 }) }, "Rule predicate value must contain data only")
  })
  it("rejects unknown kinds and malformed groups", () => {
    const kind = "Rule predicate kind is invalid"
    badRule({ when: { kind: "xor" } as never }, kind)
    badRule({ when: { kind: "", filters: [] } as never }, kind)
    badRule({ when: { kind: "", filter: lit(true) } as never }, kind)
    const group = "Rule predicate group is invalid"
    badRule({ when: { kind: "and", filters: "x" } as never }, group)
    badRule({ when: { kind: "or" } as never }, group)
    expect(isCompiledRuleSet(compileRuleSet(set([rule({ when: andOf([], "or") })])))).toBe(true)
  })
})

describe("rule and rule-set validation", () => {
  it("validates the rule key", () => {
    const m = "Rule key is invalid"
    for (const key of ["", "-a", ".a", "a b", "a".repeat(201)]) badRule({ key }, m)
    badRule({ key: 5 as never }, m)
    for (const key of ["a", "A9", `a${"b".repeat(199)}`, "a._:-b"]) expect(isCompiledRuleSet(compileRuleSet(set([rule({ key })])))).toBe(true)
  })
  it("validates version, priority and actions", () => {
    for (const version of [0, -1, 1.5, Number.NaN]) badRule({ version }, 'Rule "r" version must be a positive safe integer')
    for (const priority of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) badRule({ priority }, 'Rule "r" priority must be a safe integer')
    expect(isCompiledRuleSet(compileRuleSet(set([rule({ priority: -5 })])))).toBe(true)
    const m = 'Rule "r" must declare between 1 and 100 actions'
    badRule({ actions: [] }, m)
    badRule({ actions: "x" as never }, m)
    badRule({ actions: Array.from({ length: 101 }, () => ({})) }, m)
    expect(isCompiledRuleSet(compileRuleSet(set([rule({ actions: Array.from({ length: 100 }, () => ({})) })])))).toBe(true)
  })
  it("validates conflict key and description", () => {
    const ck = 'Rule "r" conflict key is invalid'
    badRule({ conflictKey: 5 as never }, ck)
    badRule({ conflictKey: "" }, ck)
    badRule({ conflictKey: "-x" }, ck)
    expect(isCompiledRuleSet(compileRuleSet(set([rule({ conflictKey: "ok" })])))).toBe(true)
    const d = 'Rule "r" description is invalid'
    badRule({ description: "" }, d)
    badRule({ description: "   " }, d)
    badRule({ description: "d".repeat(501) }, d)
    expect(isCompiledRuleSet(compileRuleSet(set([rule({ description: "d".repeat(500) })])))).toBe(true)
  })
  it("requires an increasing effective window", () => {
    const m = 'Rule "r" effective window must be increasing'
    badRule({ effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2026-01-01T00:00:00.000Z" }, m)
    badRule({ effectiveFrom: "2026-01-02T00:00:00.000Z", effectiveUntil: "2026-01-01T00:00:00.000Z" }, m)
    for (const w of [{ effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2026-01-01T00:00:00.001Z" }, { effectiveFrom: "2026-01-01T00:00:00.000Z" }, { effectiveUntil: "2026-01-01T00:00:00.000Z" }]) {
      expect(isCompiledRuleSet(compileRuleSet(set([rule(w)])))).toBe(true)
    }
  })
  it("reports non-data rule content with the rule label", () => {
    badRule({ actions: [{ f: () => 1 }] }, 'Rule "r" must contain data only')
  })
  it("accepts a rule at the exact node budget inside a rule set", () => {
    // rule + when + actions array + one action + its items array + items
    const items = Array.from({ length: MAX_RULE_NODES - 5 }, () => ({}))
    const heavy = rule({ actions: [{ items }] })
    expect(isCompiledRuleSet(compileRuleSet(set([heavy])))).toBe(true)
    badRule({ actions: [{ items: [...items, {}] }] }, 'Rule "r" exceeds the maximum node count')
  })
  it("validates the rule set itself", () => {
    bad(null, "Rule-set key is invalid")
    bad(undefined, "Rule-set key is invalid")
    bad(5, "Rule-set key is invalid")
    bad({ ...set([]), key: 5 }, "Rule-set key is invalid")
    bad({ ...set([]), key: "-x" }, "Rule-set key is invalid")
    for (const version of [0, 1.5, Number.NaN]) bad({ ...set([]), version }, "Rule-set version must be a positive safe integer")
    bad({ ...set([]), rules: "x" }, "Rule-set rules are invalid")
    bad({ ...set([]), rules: new Array(MAX_RULE_SET_RULES + 1) }, "Rule-set rules are invalid")
    bad({ ...set([]), conflictResolution: undefined }, "Rule-set conflict resolution is invalid")
    bad({ ...set([]), conflictResolution: { kind: "x" } }, "Rule-set conflict resolution is invalid")
    bad(set([], { kind: "highest-priority", onPriorityTie: "x" as never }), "Rule-set priority tie behavior is invalid")
    bad(set([], { kind: "highest-priority-per-key" } as never), "Rule-set priority tie behavior is invalid")
    bad(set([rule(), rule()]), "Duplicate rule version: r@1")
    bad(set([], { kind: "all-matches", extra: () => 1 } as never), "Rule set must contain data only")
    expect(compileRuleSet(set([rule(), rule({ version: 2 })])).rules).toHaveLength(2)
    expect(compileRuleSet(set([], { kind: "highest-priority", onPriorityTie: "error" })).rules).toEqual([])
    expect(compileRuleSet(set([], { kind: "highest-priority-per-key", onPriorityTie: "rule-key" })).key).toBe("set")
  })
  it("recognises only compiled rule sets", () => {
    const compiled = compileRuleSet(set([rule()]))
    expect(isCompiledRuleSet(compiled)).toBe(true)
    expect(isCompiledRuleSet({ ...compiled })).toBe(false)
    expect(isCompiledRuleSet(null)).toBe(false)
    expect(isCompiledRuleSet(5)).toBe(false)
    expect(Object.isFrozen(compiled)).toBe(true)
  })
})

describe("snapshotRuleData", () => {
  it("rethrows foreign errors unchanged and wraps structural ones with the cause", () => {
    const boom = new Error("boom")
    const proxy = new Proxy({}, { ownKeys: () => { throw boom } })
    expect(() => snapshotRuleData(proxy, "L")).toThrow(boom)
    try { snapshotRuleData(() => 1, "L") } catch (e) {
      expect(e).toBeInstanceOf(ConfigurationError)
      expect((e as Error).message).toBe("L must contain data only")
      expect((e as Error).cause).toBeInstanceOf(TypeError)
    }
    expect(() => snapshotRuleData(() => 1, "L", { errorType: ValidationError })).toThrow(ValidationError)
  })
})

describe("rule evaluation", () => {
  const compiledOf = (rules: RuleDefinition[], resolution?: RuleSetDefinition["conflictResolution"]) => compileRuleSet(set(rules, resolution))
  it("requires a compiled set and a valid trusted timestamp", () => {
    const c = compiledOf([rule()])
    expect(() => evaluateRuleSet({ ...c } as never, {}, at)).toThrow(new ConfigurationError("evaluateRuleSet requires a compiled rule set"))
    const m = new ConfigurationError("Rule evaluation requires a valid trusted timestamp")
    expect(() => evaluateRuleSet(c, {}, new Date(Number.NaN))).toThrow(m)
    expect(() => evaluateRuleSet(c, {}, "2026-01-01" as never)).toThrow(m)
    expect(() => evaluateRuleSet(c, {}, 0 as never)).toThrow(m)
  })
  it("traces every disposition exactly", () => {
    const c = compiledOf([
      rule({ key: "inactive", conflictKey: "ik", effectiveFrom: "2027-01-01T00:00:00.000Z" }),
      rule({ key: "old", version: 1, priority: 3, conflictKey: "ok1" }),
      rule({ key: "old", version: 2, priority: 4 }),
      rule({ key: "newfirst", version: 2, priority: 5 }),
      rule({ key: "newfirst", version: 1, priority: 6, conflictKey: "nf" }),
      rule({ key: "nomatch", priority: 7, when: F, conflictKey: "nm" }),
      rule({ key: "win", priority: 10, conflictKey: "grp" }),
      rule({ key: "lose", priority: 2, conflictKey: "grp" }),
    ], { kind: "highest-priority-per-key", onPriorityTie: "error" })
    const result = evaluateRuleSet(c, { on: true, off: false }, at)
    expect(result.trace).toStrictEqual([
      { key: "inactive", version: 1, priority: 1, disposition: "inactive", conflictKey: "ik" },
      { key: "old", version: 1, priority: 3, disposition: "superseded", conflictKey: "ok1" },
      { key: "old", version: 2, priority: 4, disposition: "selected" },
      { key: "newfirst", version: 2, priority: 5, disposition: "selected" },
      { key: "newfirst", version: 1, priority: 6, disposition: "superseded", conflictKey: "nf" },
      { key: "nomatch", version: 1, priority: 7, disposition: "not-matched", conflictKey: "nm" },
      { key: "win", version: 1, priority: 10, disposition: "selected", conflictKey: "grp" },
      { key: "lose", version: 1, priority: 2, disposition: "conflict-discarded", conflictKey: "grp" },
    ])
    expect(result.matches).toStrictEqual([
      { key: "win", version: 1, priority: 10, conflictKey: "grp", actions: [{ type: "x" }] },
      { key: "newfirst", version: 2, priority: 5, actions: [{ type: "x" }] },
      { key: "old", version: 2, priority: 4, actions: [{ type: "x" }] },
    ])
    expect(result.actions).toHaveLength(3)
    expect(result.ruleSetKey).toBe("set")
    expect(result.ruleSetVersion).toBe(1)
    expect(result.evaluatedAt.getTime()).toBe(at.getTime())
    expect(result.evaluatedAt).not.toBe(at)
  })
  it("applies effective windows with an inclusive start and exclusive end", () => {
    const c = compiledOf([rule({ effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveUntil: "2026-01-02T00:00:00.000Z" })])
    const sel = (iso: string) => evaluateRuleSet(c, { on: true }, new Date(iso)).trace[0]!.disposition
    expect(sel("2025-12-31T23:59:59.999Z")).toBe("inactive")
    expect(sel("2026-01-01T00:00:00.000Z")).toBe("selected")
    expect(sel("2026-01-01T23:59:59.999Z")).toBe("selected")
    expect(sel("2026-01-02T00:00:00.000Z")).toBe("inactive")
  })
  it("returns every match sorted for all-matches and none for an empty highest-priority", () => {
    const c = compiledOf([rule({ key: "b", priority: 1 }), rule({ key: "a", priority: 1 }), rule({ key: "c", priority: 9 })])
    expect(evaluateRuleSet(c, { on: true }, at).matches.map(m => m.key)).toEqual(["c", "a", "b"])
    const none = evaluateRuleSet(compiledOf([rule({ when: F })], { kind: "highest-priority", onPriorityTie: "error" }), { off: false }, at)
    expect(none.matches).toEqual([])
    expect(none.actions).toEqual([])
  })
  it("resolves highest-priority with the rule-key or error tie behaviour", () => {
    const rules = [rule({ key: "b", priority: 5 }), rule({ key: "a", priority: 5 }), rule({ key: "c", priority: 1 })]
    const byKey = evaluateRuleSet(compiledOf(rules, { kind: "highest-priority", onPriorityTie: "rule-key" }), { on: true }, at)
    expect(byKey.matches.map(m => m.key)).toEqual(["a"])
    expect(() => evaluateRuleSet(compiledOf(rules, { kind: "highest-priority", onPriorityTie: "error" }), { on: true }, at)).toThrow(new ConfigurationError('Rule priority tie in rule set "set": 5'))
    const distinct = evaluateRuleSet(compiledOf([rule({ key: "b", priority: 5 }), rule({ key: "a", priority: 4 })], { kind: "highest-priority", onPriorityTie: "error" }), { on: true }, at)
    expect(distinct.matches.map(m => m.key)).toEqual(["b"])
    const single = evaluateRuleSet(compiledOf([rule()], { kind: "highest-priority", onPriorityTie: "error" }), { on: true }, at)
    expect(single.matches.map(m => m.key)).toEqual(["r"])
  })
  it("resolves per conflict key, keeping implicit groups separate and sorting winners", () => {
    const c = compiledOf([
      rule({ key: "low", priority: 1 }),
      rule({ key: "mid", priority: 5, conflictKey: "g" }),
      rule({ key: "mid2", priority: 3, conflictKey: "g" }),
      rule({ key: "high", priority: 9 }),
    ], { kind: "highest-priority-per-key", onPriorityTie: "error" })
    const result = evaluateRuleSet(c, { on: true }, at)
    expect(result.matches.map(m => m.key)).toEqual(["high", "mid", "low"])
    expect(result.trace.map(t => t.disposition)).toEqual(["selected", "selected", "conflict-discarded", "selected"])
    const tie = compiledOf([rule({ key: "a", priority: 2, conflictKey: "g" }), rule({ key: "b", priority: 2, conflictKey: "g" })], { kind: "highest-priority-per-key", onPriorityTie: "error" })
    expect(() => evaluateRuleSet(tie, { on: true }, at)).toThrow(new ConfigurationError('Rule priority tie in conflict key "g": 2'))
    const byKey = compiledOf([rule({ key: "b", priority: 2, conflictKey: "g" }), rule({ key: "a", priority: 2, conflictKey: "g" })], { kind: "highest-priority-per-key", onPriorityTie: "rule-key" })
    expect(evaluateRuleSet(byKey, { on: true }, at).matches.map(m => m.key)).toEqual(["a"])
  })
  it("validates facts as ValidationError", () => {
    const c = compiledOf([rule()])
    expect(() => evaluateRuleSet(c, { on: () => 1 } as never, at)).toThrow(ValidationError)
  })
})
