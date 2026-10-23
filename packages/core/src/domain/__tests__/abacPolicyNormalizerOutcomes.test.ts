import { describe, expect, it } from "vitest"
import type { AbacModuleCatalog } from "../abacCatalog"
import { normalizeAbacPolicy } from "../abacPolicyNormalizer"
import type { AbacPolicy } from "../abacTypes"
import type { PolicyConditions } from "../abacPolicySchema"

const catalog: AbacModuleCatalog = {
  moduleKey: "m",
  actions: ["read"],
  capabilities: ["cap"],
  fields: {
    name: { key: "name", type: "string", operators: ["equals", "contains"] },
    amount: { key: "amount", type: "number", operators: ["equals", "greaterThan"] },
    when: { key: "when", type: "date", operators: ["equals", "greaterThan", "between"] },
  },
}

const context = { userId: "user-1" }
const AT = new Date("2026-06-01T00:00:00.000Z")

function conditions(clause: Record<string, unknown>): PolicyConditions {
  return {
    version: 2,
    systemScope: { logic: "AND", conditions: [clause as never] },
    userFilters: { logic: "AND", conditions: [] },
  }
}

function policy(overrides: Partial<AbacPolicy> = {}, clause: Record<string, unknown> = { field: "name", operator: "equals", value: "x" }): AbacPolicy {
  return {
    source: { policyId: "p1", scopeType: "tenant_default" },
    moduleKey: "m",
    effect: "allow",
    priority: 10,
    payload: { actions: ["read"], capabilities: [], conditions: conditions(clause) },
    ...overrides,
  }
}

function run(p: AbacPolicy, at: Date = AT) {
  return normalizeAbacPolicy({ policy: p, catalog, context, at })
}

describe("normalizeAbacPolicy validation outcomes", () => {
  it("rejects an invalid active window with its own code", () => {
    expect(run(policy({ source: { policyId: "p1", scopeType: "tenant_default", startsAt: "2026-07-01T00:00:00.000Z", endsAt: "2026-01-01T00:00:00.000Z" } }))).toEqual({
      success: false,
      errors: [{ code: "POLICY_WINDOW_INVALID", message: "Policy active window is invalid", policyId: "p1" }],
    })
    expect(run(policy({ source: { policyId: "p1", scopeType: "tenant_default", startsAt: "not-a-date" } }))).toMatchObject({
      success: false,
      errors: [{ code: "POLICY_WINDOW_INVALID" }],
    })
  })

  it("rejects an effect other than allow or deny", () => {
    expect(run(policy({ effect: "maybe" as never }))).toEqual({
      success: false,
      errors: [{ code: "POLICY_EFFECT_INVALID", message: 'Policy effect must be "allow" or "deny"', path: "effect", policyId: "p1" }],
    })
  })

  it("rejects priorities that are not safe integers", () => {
    const expected = {
      success: false,
      errors: [{ code: "POLICY_PRIORITY_INVALID", message: "Policy priority must be a safe integer", path: "priority", policyId: "p1" }],
    }
    expect(run(policy({ priority: 1.5 }))).toEqual(expected)
    expect(run(policy({ priority: "1" as never }))).toEqual(expected)
    expect(run(policy({ priority: Number.MAX_SAFE_INTEGER + 2 }))).toEqual(expected)
    expect(run(policy({ priority: Number.MAX_SAFE_INTEGER })).success).toBe(true)
  })

  it("rejects a module key that differs from the catalog", () => {
    expect(run(policy({ moduleKey: "other" }))).toEqual({
      success: false,
      errors: [{
        code: "MODULE_KEY_MISMATCH",
        message: 'Policy moduleKey "other" does not match catalog moduleKey "m"',
        policyId: "p1",
      }],
    })
  })

  it("reports catalog failures and skips condition compilation", () => {
    const unknownAction = policy()
    unknownAction.payload.actions = ["write"]
    expect(run(unknownAction)).toEqual({
      success: false,
      errors: [{ code: "CATALOG_VALIDATION_FAILED", message: "Unknown action: write", path: "actions", policyId: "p1", value: "write" }],
    })
  })
})

describe("normalizeAbacPolicy active window", () => {
  it("excludes a policy that starts after the evaluation time", () => {
    const result = run(policy({ source: { policyId: "p1", scopeType: "tenant_default", startsAt: "2026-07-01T00:00:00.000Z" } }))
    expect(result).toMatchObject({ success: true, excluded: "inactive" })
  })

  it("excludes a policy that ended before the evaluation time", () => {
    const result = run(policy({ source: { policyId: "p1", scopeType: "tenant_default", endsAt: "2026-05-01T00:00:00.000Z" } }))
    expect(result).toMatchObject({ success: true, excluded: "inactive" })
  })

  it("treats the exact start and end instants as active and omits the excluded flag", () => {
    const startsAtNow = run(policy({ source: { policyId: "p1", scopeType: "tenant_default", startsAt: AT } }))
    expect(startsAtNow.success).toBe(true)
    if (!startsAtNow.success) throw new Error("expected success")
    expect(startsAtNow).not.toHaveProperty("excluded")
    const endsAtNow = run(policy({ source: { policyId: "p1", scopeType: "tenant_default", endsAt: AT } }))
    expect(endsAtNow.success).toBe(true)
    expect(endsAtNow).not.toHaveProperty("excluded")
  })

  it("canonicalizes date window values to ISO strings in the durable policy", () => {
    const result = run(policy({ source: { policyId: "p1", scopeType: "tenant_default", startsAt: new Date("2026-01-01T00:00:00.000Z") } }))
    if (!result.success) throw new Error("expected success")
    expect(result.policy.source.startsAt).toBe("2026-01-01T00:00:00.000Z")
    expect(Object.isFrozen(result.policy)).toBe(true)
    expect(Object.isFrozen(result.policy.source)).toBe(true)
  })
})

describe("normalizeAbacPolicy predicate portability", () => {
  it("rejects string substring operators as non-portable", () => {
    expect(run(policy({}, { field: "name", operator: "contains", value: "x" }))).toEqual({
      success: false,
      errors: [{
        code: "NON_PORTABLE_PREDICATE",
        message: 'Predicate operator "contains" on field "name" is not supported consistently by all persistence adapters',
        policyId: "p1",
      }],
    })
  })

  it("rejects date ordering on date fields but accepts numeric ordering", () => {
    expect(run(policy({}, { field: "when", operator: "greaterThan", value: "2026-01-01" }))).toEqual({
      success: false,
      errors: [{
        code: "NON_PORTABLE_PREDICATE",
        message: 'Predicate operator "gt" on field "when" is not supported consistently by all persistence adapters',
        policyId: "p1",
      }],
    })
    expect(run(policy({}, { field: "when", operator: "between", value: ["2026-01-01", "2026-02-01"] })).success).toBe(false)
    expect(run(policy({}, { field: "when", operator: "equals", value: "2026-01-01" })).success).toBe(true)
    expect(run(policy({}, { field: "amount", operator: "greaterThan", value: 5 })).success).toBe(true)
  })

  it("accepts a valid policy and stores the compiled predicate", () => {
    const result = run(policy({}, { field: "name", operator: "equals", value: "x" }))
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("expected success")
    expect(result.policy.compiledConditions).toBeDefined()
    expect(result.policy.compiledConditions).not.toEqual({ kind: "literal", value: false })
    expect(result.policy.effect).toBe("allow")
    expect(result.policy.priority).toBe(10)
  })
})
