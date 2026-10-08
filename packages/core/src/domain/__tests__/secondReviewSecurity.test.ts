import { describe, expect, it } from "vitest"
import { createAbacBundle } from "../abacBundleFactory"
import { normalizeAbacPolicy } from "../abacPolicyNormalizer"
import { resolveTieredDecision } from "../abacTierDecision"
import { buildTieredPolicyOutcome } from "../policyTierResolver"
import { policyClauseToPredicate } from "../abacConditionCompiler"
import { coercePolicyValue, PolicyValidationError } from "../coercePolicyValue"
import { parseFieldAccessStrict } from "../abacPolicySchema"
import { projectResponseRecord, resolveFieldQueryAccess, resolveFieldQueryDenials, resolveFieldReadOverrides } from "../fieldAccess"
import { evaluatePredicate } from "../evaluatePredicate"
import { InvalidPolicyConfigurationError } from "../errors"
import { Predicate } from "../predicate"
import type { AbacModuleCatalog } from "../abacCatalog"
import type { AbacPolicy, NormalizedAbacPolicy } from "../abacTypes"
import type { PolicyFilterClause } from "../abacPolicySchema"

const catalog: AbacModuleCatalog = {
  moduleKey: "tenant.records",
  actions: ["read"],
  capabilities: [],
  fields: {
    branchId: { key: "branchId", type: "string", operators: ["equals", "notEquals", "in"] },
    level: { key: "level", type: "number", operators: ["equals", "greaterOrEqual"] },
  },
}

function policy(overrides: Partial<AbacPolicy> = {}, clause: PolicyFilterClause = { field: "branchId", operator: "equals", value: "b1" }): AbacPolicy {
  return {
    source: { policyId: "p1", scopeType: "tenant_default" },
    moduleKey: "tenant.records",
    effect: "allow",
    priority: 10,
    payload: {
      actions: ["read"],
      capabilities: [],
      conditions: { version: 2, systemScope: { logic: "AND", conditions: [clause] }, userFilters: { logic: "AND", conditions: [] } },
    },
    ...overrides,
  }
}

const bundleInput = (policies: AbacPolicy[]) => ({
  provider: { resolve: async () => policies },
  mode: "tenant" as const,
  moduleKey: "tenant.records",
  context: { userId: "u1", tenantId: "t1" },
  catalog,
})

describe("S1: policy effect and priority validation", () => {
  it.each([["permit"], ["ALLOW"], [undefined], [null]])("rejects effect %s", async (effect) => {
    await expect(createAbacBundle(bundleInput([policy({ effect: effect as never })]))).rejects.toThrow(InvalidPolicyConfigurationError)
    const result = normalizeAbacPolicy({ policy: policy({ effect: effect as never }), catalog, context: {} })
    expect(result.success).toBe(false)
  })

  it.each([[Number.NaN], [Infinity], [1.5], [2 ** 60], ["10"]])("rejects priority %s", async (priority) => {
    await expect(createAbacBundle(bundleInput([policy({ priority: priority as never })]))).rejects.toThrow(InvalidPolicyConfigurationError)
  })

  it("tier decisions only allow on an explicit allow effect", () => {
    const decision = resolveTieredDecision({ policies: [{ e: "permit" }], getPriority: () => 1, getEffect: (p) => p.e as never, matches: () => true })
    expect(decision.allowed).toBe(false)
    const outcome = buildTieredPolicyOutcome({
      policies: [{ e: "permit", p: 2 }, { e: "allow", p: 1 }],
      getPriority: (p) => p.p, getEffect: (p) => p.e as never, getMatch: () => Predicate.alwaysTrue(),
      ops: { alwaysTrue: Predicate.alwaysTrue, alwaysFalse: Predicate.alwaysFalse, and: (e) => Predicate.and(...e), or: (e) => Predicate.or(...e), not: Predicate.not },
    })
    expect(evaluatePredicate({}, outcome)).toBe(false)
  })
})

describe("S4: missing user attributes never coerce", () => {
  const clause: PolicyFilterClause = { field: "branchId", operator: "equals", userAttr: "user.branchId" }
  const compile = (c: PolicyFilterClause, effect?: "allow" | "deny") =>
    policyClauseToPredicate({ clause: c, context: { userId: "u1" }, fieldCatalog: catalog.fields, ...(effect ? { effect } : {}) })

  it("allow policies compile a missing attribute to always-false", () => {
    const result = compile(clause, "allow")
    expect(result.success).toBe(true)
    if (result.success) {
      expect(evaluatePredicate({ branchId: "undefined" }, result.predicate)).toBe(false)
      expect(evaluatePredicate({ branchId: null }, result.predicate)).toBe(false)
    }
    const listed = compile({ field: "branchId", operator: "in", values: ["user.branchId"] }, "allow")
    if (listed.success) expect(evaluatePredicate({ branchId: "undefined" }, listed.predicate)).toBe(false)
  })

  it("deny policies fail closed on a missing attribute", () => {
    for (const c of [clause, { ...clause, operator: "notEquals" as const }, { field: "branchId", operator: "in" as const, values: ["user.branchId"] }]) {
      const result = compile(c, "deny")
      expect(result.success).toBe(true)
      if (result.success) expect(evaluatePredicate({ branchId: "b9" }, result.predicate)).toBe(true)
    }
  })

  it("normalized deny policies with a missing attribute still deny", () => {
    const result = normalizeAbacPolicy({ policy: policy({ effect: "deny" }, clause), catalog, context: { userId: "u1" } })
    expect(result.success).toBe(true)
    if (result.success) expect(evaluatePredicate({ branchId: "b2" }, result.policy.compiledConditions)).toBe(true)
  })

  it("null user attribute on a number field does not become 0", () => {
    const result = policyClauseToPredicate({ clause: { field: "level", operator: "equals", userAttr: "user.roleId" }, context: { roleId: null }, fieldCatalog: catalog.fields })
    expect(result.success).toBe(true)
    if (result.success) expect(evaluatePredicate({ level: 0 }, result.predicate)).toBe(false)
  })

  it("coercion rejects non-scalar values", () => {
    expect(() => coercePolicyValue({ type: "string", value: undefined })).toThrow(PolicyValidationError)
    expect(() => coercePolicyValue({ type: "string", value: { a: 1 } })).toThrow(PolicyValidationError)
    expect(() => coercePolicyValue({ type: "identifier", value: [1] })).toThrow(PolicyValidationError)
    expect(() => coercePolicyValue({ type: "number", value: undefined })).toThrow(PolicyValidationError)
    expect(() => coercePolicyValue({ type: "number", value: "" })).toThrow(PolicyValidationError)
    expect(() => coercePolicyValue({ type: "number", value: true })).toThrow(PolicyValidationError)
    expect(() => coercePolicyValue({ type: "number", value: [] })).toThrow(PolicyValidationError)
    expect(coercePolicyValue({ type: "number", value: null })).not.toBe(0)
    expect(coercePolicyValue({ type: "number", value: "18" })).toBe(18)
    expect(coercePolicyValue({ type: "string", value: 5 })).toBe("5")
  })
})

function normalized(overrides: Partial<NormalizedAbacPolicy>): NormalizedAbacPolicy {
  return {
    source: { policyId: "p", scopeType: "tenant_default" },
    moduleKey: "m",
    effect: "allow",
    priority: 10,
    payload: { actions: ["read"], capabilities: [], conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } } },
    compiledConditions: Predicate.alwaysTrue(),
    ...overrides,
  }
}

describe("S5b: read allowlists default unlisted fields to omit", () => {
  it("omits a declared field absent from the trusted record", () => {
    const allow = normalized({ payload: { ...normalized({}).payload, fieldAccess: { read: { name: "allow" } } } })
    const overrides = resolveFieldReadOverrides({ policies: [allow], moduleKey: "m", record: { id: "1", name: "n" } })
    const entity = { fields: { id: { type: "string" }, name: { type: "string" }, ssn: { type: "string" } } } as never
    expect(projectResponseRecord({ entity, record: { id: "1", name: "n", ssn: "123" }, overrides })).toEqual({ name: "n" })
  })

  it("a lower-priority explicit allow cannot re-open a field the higher allowlist omits", () => {
    const top = normalized({ priority: 20, payload: { ...normalized({}).payload, fieldAccess: { read: { name: "allow" } } } })
    const low = normalized({ priority: 5, payload: { ...normalized({}).payload, fieldAccess: { read: { ssn: "allow" } } } })
    const overrides = resolveFieldReadOverrides({ policies: [top, low], moduleKey: "m", record: { name: "n" } })
    const entity = { fields: { name: { type: "string" }, ssn: { type: "string" } } } as never
    expect(projectResponseRecord({ entity, record: { name: "n", ssn: "123" }, overrides })).toEqual({ name: "n" })
  })
})

describe("S5c: query grants never re-open deny-omitted fields", () => {
  const payload = normalized({}).payload
  it("ignores grants on deny policies", () => {
    const deny = normalized({ effect: "deny", payload: { ...payload, fieldAccess: { read: { ssn: "omit" }, query: { filter: ["ssn"], sort: ["ssn"], search: ["ssn"] } } } })
    const denials = resolveFieldQueryDenials({ policies: [deny], moduleKey: "m", fields: ["name", "ssn"] })
    expect(denials.filter).toContain("ssn")
    expect(denials.sort).toContain("ssn")
    expect(denials.search).toContain("ssn")
    expect(resolveFieldQueryAccess({ policies: [deny], moduleKey: "m", fields: ["name", "ssn"] }).filter).not.toContain("ssn")
  })

  it("allow grants do not subtract a deny's omission", () => {
    const deny = normalized({ effect: "deny", payload: { ...payload, fieldAccess: { read: { ssn: "omit" } } } })
    const allow = normalized({ compiledConditions: Predicate.eq("branchId", "b1"), payload: { ...payload, fieldAccess: { query: { filter: ["ssn"] } } } })
    expect(resolveFieldQueryDenials({ policies: [deny, allow], moduleKey: "m", fields: ["name", "ssn"] }).filter).toContain("ssn")
    expect(resolveFieldQueryAccess({ policies: [deny, allow], moduleKey: "m", fields: ["name", "ssn"] }).filter).not.toContain("ssn")
  })
})

describe("P3: reserved read-map keys", () => {
  it.each([["__proto__"], ["constructor"], ["prototype"]])("rejects %s", (key) => {
    const result = parseFieldAccessStrict(JSON.parse(`{"read":{"${key}":"allow","name":"allow"}}`), "fieldAccess")
    expect(result.success).toBe(false)
  })
})
