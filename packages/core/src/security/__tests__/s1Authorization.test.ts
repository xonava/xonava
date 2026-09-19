import { describe, expect, it } from "vitest"
import { createAuthorizedExecutionPlan, createPrivilegedAuthorizationTrace, isAuthorizedExecutionPlan } from "../authorizedExecutionPlan"
const principal = { kind: "human", id: "actor", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-11T00:00:00.000Z" } } as const
const identity = { actor: principal, subject: principal } as const
const base = { identity, scope: { kind: "tenant", tenantId: "tenant-a" } as const, action: "record.update", operationKind: "mutation" as const, readableFields: new Set(["id", "name"]), writableFields: new Set(["name"]), obligations: [{ kind: "audit", action: "record.update" }] as const, policy: { key: "record-policy", version: 2, digest: "a".repeat(64) } }
describe("S1 authorized execution plan", () => {
  it("rejects mutable facts without commit-time revalidation", () => { expect(() => createAuthorizedExecutionPlan({ ...base, dynamicFacts: [{ factKey: "membership", version: "7", observedAt: "2026-09-11T00:00:00.000Z" }] })).toThrow(/revalidation/) })
  it("accepts each explicit mutation revalidation strategy", () => { for (const revalidation of [{ kind: "mutation-predicate", field: "membership_version", expectedValue: 7 }, { kind: "transaction-check", checkKey: "membership" }, { kind: "lease-grant-check", grantId: "g", version: "1" }] as const) expect(() => createAuthorizedExecutionPlan({ ...base, dynamicFacts: [{ factKey: "membership", version: "7", observedAt: "2026-09-11T00:00:00.000Z", revalidation }] })).not.toThrow() })
  it("produces a redacted privileged trace", () => { const plan = createAuthorizedExecutionPlan({ ...base, dynamicFacts: [], obligations: [{ kind: "step-up", requirement: "mfa" }, { kind: "mask", field: "email", strategy: "partial" }] }); const trace = createPrivilegedAuthorizationTrace(plan); expect(trace).toMatchObject({ scopeKind: "tenant", policyKey: "record-policy", obligationKinds: ["step-up", "mask"] }); expect(JSON.stringify(trace)).not.toContain("actor"); expect(JSON.stringify(trace)).not.toContain("email") })
  it("keeps field sets immutable at runtime", () => {
    const plan = createAuthorizedExecutionPlan({ ...base, operationKind: "read", dynamicFacts: [] })
    expect(() => (plan.readableFields as Set<string>).add("secret")).toThrow()
    expect(plan.readableFields.has("secret")).toBe(false)
  })
  it("supports every readonly field-set iterator without exposing mutation", () => {
    const plan = createAuthorizedExecutionPlan({ ...base, operationKind: "read", dynamicFacts: [] })
    expect(plan.readableFields.size).toBe(2)
    expect([...plan.readableFields]).toEqual(["id", "name"])
    expect([...plan.readableFields.keys()]).toEqual(["id", "name"])
    expect([...plan.readableFields.values()]).toEqual(["id", "name"])
    expect([...plan.readableFields.entries()]).toEqual([["id", "id"], ["name", "name"]])
    const visited: string[] = []
    plan.readableFields.forEach((value, duplicate, collection) => { expect(value).toBe(duplicate); expect(collection).toBe(plan.readableFields); visited.push(value) })
    expect(visited).toEqual(["id", "name"])
  })
  it("snapshots nested policy input without freezing the policy evaluator's objects", () => {
    const predicate = { kind: "comparison", field: "ownerId", operator: "eq", value: "actor" } as never
    const plan = createAuthorizedExecutionPlan({ ...base, operationKind: "read", dynamicFacts: [], mandatoryResourcePredicate: predicate })
    expect(Object.isFrozen(predicate)).toBe(false)
    expect(Object.isFrozen(plan.mandatoryResourcePredicate)).toBe(true)
    expect(plan.mandatoryResourcePredicate).not.toBe(predicate)
  })
  it("snapshots and protects Date predicate values", () => {
    const cutoff = new Date("2026-01-01T00:00:00.000Z")
    const plan = createAuthorizedExecutionPlan({
      ...base,
      operationKind: "read",
      dynamicFacts: [],
      mandatoryResourcePredicate: { kind: "condition", field: "expiresAt", op: "lt", value: cutoff },
    })
    cutoff.setUTCFullYear(2030)
    const snapshot = (plan.mandatoryResourcePredicate as Extract<typeof plan.mandatoryResourcePredicate, { kind: "condition" }>).value as Date
    expect(snapshot.toISOString()).toBe("2026-01-01T00:00:00.000Z")
    expect(() => snapshot.setUTCFullYear(2030)).toThrow(/immutable/)
  })
  it("snapshots mutable dynamic-fact revalidation values", () => {
    const expectedValue = new Date("2026-01-01T00:00:00.000Z")
    const plan = createAuthorizedExecutionPlan({
      ...base,
      dynamicFacts: [{
        factKey: "membership",
        version: "7",
        observedAt: "2026-09-11T00:00:00.000Z",
        revalidation: { kind: "mutation-predicate", field: "membershipExpiresAt", expectedValue },
      }],
    })
    expectedValue.setUTCFullYear(2030)
    const revalidation = plan.dynamicFacts[0]?.revalidation
    expect((revalidation as { expectedValue: Date }).expectedValue.toISOString()).toBe("2026-01-01T00:00:00.000Z")
  })
  it("rejects malformed top-level authority and policy fields", () => {
    for (const invalid of [null, { ...base, action: "" }, { ...base, operationKind: "other" }, { ...base, readableFields: [] }, { ...base, writableFields: new Set([""]) }, { ...base, obligations: {} }, { ...base, policy: { key: "", version: 0, digest: "" } }] as unknown[]) {
      expect(() => createAuthorizedExecutionPlan(invalid as never)).toThrow()
    }
    const issued = createAuthorizedExecutionPlan({ ...base, operationKind: "read", dynamicFacts: [] })
    expect(isAuthorizedExecutionPlan(issued)).toBe(true)
    expect(isAuthorizedExecutionPlan({ ...issued })).toBe(false)
  })
  it("rejects malformed obligations", () => {
    const invalid = [null, { kind: "audit", action: "" }, { kind: "step-up", requirement: "password" }, { kind: "step-up", requirement: "mfa", maxAgeSeconds: 0 }, { kind: "mask", field: "", strategy: "redact" }, { kind: "mask", field: "email", strategy: "unknown" }]
    for (const obligation of invalid) expect(() => createAuthorizedExecutionPlan({ ...base, operationKind: "read", obligations: [obligation] as never, dynamicFacts: [] })).toThrow()
  })
  it("rejects malformed dynamic facts and revalidation strategies", () => {
    const fact = { factKey: "membership", version: "7", observedAt: "2026-09-11T00:00:00.000Z" }
    const invalid = [
      { ...fact, factKey: "" }, { ...fact, version: "" }, { ...fact, observedAt: "bad" },
      { ...fact, revalidation: { kind: "mutation-predicate", field: "" } },
      { ...fact, revalidation: { kind: "transaction-check", checkKey: "" } },
      { ...fact, revalidation: { kind: "lease-grant-check", grantId: "", version: "" } },
    ]
    for (const value of invalid) expect(() => createAuthorizedExecutionPlan({ ...base, operationKind: "read", dynamicFacts: [value] as never })).toThrow()
  })
  it("rejects cyclic, accessor, invalid Date, and class-instance predicate values", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => "secret" })
    class Custom { value = 1 }
    for (const value of [cyclic, accessor, new Date(Number.NaN), new Custom()]) {
      expect(() => createAuthorizedExecutionPlan({ ...base, operationKind: "read", dynamicFacts: [], mandatoryResourcePredicate: { kind: "condition", field: "x", op: "eq", value } as never })).toThrow()
    }
  })
})
