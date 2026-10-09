import { describe, expect, it } from "vitest"
import { bindAbacSecurityDigest } from "../abacBundleIntegrity"
import { createAbacAuthorizer } from "../abacAuthorizer"
import { evaluateAbacRecordCapability } from "../abacDecision"
import { assertPolicyWritableFields, hasRecordDependentFieldWrite, projectResponseRecord, resolveFieldQueryDenials, resolveFieldReadOverrides } from "../fieldAccess"
import { parseFieldAccessStrict } from "../abacPolicySchema"
import { ForbiddenError } from "../errors"
import { Predicate, type PredicateNode } from "../predicate"
import type { NormalizedAbacPolicy, VerifiedAbacPolicyBundle } from "../abacTypes"
import type { ParsedPolicyPayload, PolicyFilterClause } from "../abacPolicySchema"
import { normalizeAbacPolicy } from "../abacPolicyNormalizer"
import { policyConditionsToPredicate } from "../abacConditionCompiler"
import { defineAbacModule } from "../abacCatalog"
import { evaluatePredicateTruth } from "../evaluatePredicate"

/** Minimal counterexamples found by src/__tests__/differential/abac*.differential.test.ts. */

const MODULE = "diff.records"
const FIELDS = ["name", "code", "amount"]

function policy(args: {
  id: string
  effect?: "allow" | "deny"
  priority: number
  actions?: string[]
  capabilities?: string[]
  when?: PredicateNode
  fieldAccess?: ParsedPolicyPayload["fieldAccess"]
}): NormalizedAbacPolicy {
  return {
    source: { policyId: args.id, scopeType: "tenant_default" },
    moduleKey: MODULE,
    effect: args.effect ?? "allow",
    priority: args.priority,
    payload: {
      actions: args.actions ?? [],
      capabilities: args.capabilities ?? [],
      conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
      ...(args.fieldAccess ? { fieldAccess: args.fieldAccess } : {}),
    },
    compiledConditions: args.when ?? Predicate.alwaysTrue(),
  }
}

function bundle(policies: NormalizedAbacPolicy[]): Promise<VerifiedAbacPolicyBundle> {
  const fieldCatalog = Object.fromEntries(FIELDS.map((key) => [key, { key, type: "string" as const, operators: [] }]))
  return bindAbacSecurityDigest({ mode: "tenant", moduleKey: MODULE, policies, context: { tenantId: "t1" }, defaultEffect: "deny", fieldCatalog })
}

describe("regression: global capability looser than a record decision", () => {
  // p5's condition is UNKNOWN for a record without `code`: its tier shadows p0
  // and the record is denied, so the global grant must be denied too.
  const p0 = policy({ id: "p0", priority: 1, capabilities: ["approve"] })
  const p5 = policy({ id: "p5", priority: 5, capabilities: ["approve"], when: Predicate.between("code", { from: "a", to: "b" }) })

  it("denies the global grant when a higher-tier conditional allow may shadow it", async () => {
    const verified = await bundle([p0, p5])
    expect(evaluateAbacRecordCapability({ bundle: verified, capability: "approve", record: {} }).allowed).toBe(false)
    expect(createAbacAuthorizer(verified).canGlobalCapability("approve")).toBe(false)
  })

  it("still grants when the unconditional allow is in the top tier or the conditional one is statically false", async () => {
    expect(createAbacAuthorizer(await bundle([{ ...p0, priority: 5 }, p5])).canGlobalCapability("approve")).toBe(true)
    expect(createAbacAuthorizer(await bundle([p0, { ...p5, compiledConditions: Predicate.alwaysFalse() }])).canGlobalCapability("approve")).toBe(true)
  })
})

describe("regression: fields hidden by a deny read map's reserved \"*\" key stayed queryable", () => {
  const deny = policy({ id: "d", effect: "deny", priority: 10, actions: ["read"], fieldAccess: { read: { amount: "allow", "*": "omit" } } })

  it("query-denies every field the plan hides", () => {
    const plan = resolveFieldReadOverrides({ policies: [deny], moduleKey: MODULE, record: { name: "e", amount: 1 } })
    const projected = projectResponseRecord({ entity: { fields: { name: { type: "string" }, amount: { type: "number" } } }, record: { name: "e", amount: 1 }, overrides: plan })
    expect(projected).toEqual({})
    const denials = resolveFieldQueryDenials({ policies: [deny], moduleKey: MODULE, fields: FIELDS })
    for (const mode of ["filter", "search", "sort"] as const) expect(denials[mode]).toEqual(expect.arrayContaining(FIELDS))
  })

  it("is not re-opened by an allow's query grant", () => {
    const grant = policy({ id: "g", priority: 1, actions: ["read"], fieldAccess: { query: { filter: ["name"] } } })
    expect(resolveFieldQueryDenials({ policies: [deny, grant], moduleKey: MODULE, fields: FIELDS }).filter).toContain("name")
  })

  it("rejects the reserved key in policy read maps", () => {
    expect(parseFieldAccessStrict({ read: { "*": "omit" } }, "fieldAccess").success).toBe(false)
  })
})

describe("regression: record-dependent field writes not flagged for optimistic concurrency", () => {
  // p2 (unrestricted) only applies when amount >= -0.5; otherwise p1 limits
  // writes to updatedAt. Both rows are in the update scope.
  const p1 = policy({ id: "p1", priority: 1, actions: ["update"], fieldAccess: { write: ["updatedAt"] } })
  const p2 = policy({ id: "p2", priority: 1, actions: ["update"], when: Predicate.gte("amount", -0.5) })

  it("reports the dependence", () => {
    const write = (record: Record<string, unknown>) => () =>
      assertPolicyWritableFields({ policies: [p1, p2], moduleKey: MODULE, action: "update", record, changedFields: ["name"] })
    expect(write({ amount: -0.5 })).not.toThrow()
    expect(write({ amount: null })).toThrow(ForbiddenError)
    expect(hasRecordDependentFieldWrite([p1, p2], MODULE, "update")).toBe(true)
  })

  it("stays false for conditional denies without write lists and for lists that never vary", () => {
    const deny = policy({ id: "d", effect: "deny", priority: 5, actions: ["update"], when: Predicate.eq("code", "locked") })
    expect(hasRecordDependentFieldWrite([p1, deny], MODULE, "update")).toBe(false)
    expect(hasRecordDependentFieldWrite([p1], MODULE, "update")).toBe(false)
    expect(hasRecordDependentFieldWrite([p2], MODULE, "update")).toBe(false)
  })
})

describe("regression: date-field policy literals canonicalized to an instant (fail-open on string-hydrated dates)", () => {
  // `date` columns commonly hydrate as "YYYY-MM-DD" strings (drizzle PG date(),
  // SQLite text dates) and sometimes as UTC-midnight Dates; a policy literal
  // must match both, so it stays a calendar date and never becomes an instant.
  const catalog = defineAbacModule({
    moduleKey: MODULE,
    actions: ["read", "update"],
    capabilities: [],
    fields: { dueOn: { key: "dueOn", type: "date", operators: ["equals", "notEquals", "in", "greaterThan", "lessOrEqual", "between"] } },
  })
  const conditions = (clause: PolicyFilterClause) => ({ version: 2 as const, systemScope: { logic: "AND" as const, conditions: [clause] }, userFilters: { logic: "AND" as const, conditions: [] } })
  const hydrations = [{ dueOn: "2026-01-01" }, { dueOn: new Date("2026-01-01T00:00:00.000Z") }]

  it("normalizes a date equality deny to a calendar-date literal that applies to both hydrations", async () => {
    const result = normalizeAbacPolicy({
      policy: { source: { policyId: "deny-new-year", scopeType: "tenant_default" }, moduleKey: MODULE, effect: "deny", priority: 10, payload: { actions: ["update"], capabilities: [], conditions: conditions({ field: "dueOn", operator: "equals", value: "2026-01-01" }) } },
      catalog,
      context: { tenantId: "t1" },
    })
    if (!result.success) throw new Error(JSON.stringify(result.errors))
    expect(JSON.stringify(result.policy.compiledConditions)).toContain(JSON.stringify(Predicate.eq("dueOn", "2026-01-01")))
    expect(JSON.stringify(result.policy.compiledConditions)).not.toContain("T00:00")
    const verified = await bundle([result.policy, policy({ id: "allow", priority: 1, actions: ["update"] })])
    for (const record of hydrations) expect(createAbacAuthorizer(verified).canRecordAction("update", record)).toBe(false)
    expect(createAbacAuthorizer(verified).canRecordAction("update", { dueOn: "2026-01-02" })).toBe(true)
  })

  it.each([
    ["equals", { value: "2026-01-01" }, true],
    ["notEquals", { value: "2026-01-01" }, false],
    ["in", { values: ["2025-12-31", "2026-01-01"] }, true],
    ["greaterThan", { value: "2025-12-31" }, true],
    ["lessOrEqual", { value: "2025-12-31" }, false],
    ["between", { value: { from: "2026-01-01", to: "2026-01-01" } }, true],
  ] as const)("compiles %s to calendar-date literals evaluated identically for string and Date hydration", (operator, operand, expected) => {
    const compiled = policyConditionsToPredicate({ conditions: conditions({ field: "dueOn", operator, ...operand } as PolicyFilterClause), context: {}, fieldCatalog: catalog.fields, effect: "allow" })
    if (!compiled.success) throw new Error(compiled.error)
    expect(JSON.stringify(compiled.predicate)).not.toContain("T00:00")
    for (const record of hydrations) expect(evaluatePredicateTruth(record, compiled.predicate), JSON.stringify(record)).toBe(expected)
  })
})

describe("date-field policy values supplied as Date instances", () => {
  const fields = { dueOn: { key: "dueOn", type: "date" as const, operators: ["equals" as const] } }
  const compile = (value: unknown) => policyConditionsToPredicate({
    conditions: { version: 2, systemScope: { logic: "AND", conditions: [{ field: "dueOn", operator: "equals", value }] }, userFilters: { logic: "AND", conditions: [] } },
    context: {}, fieldCatalog: fields, effect: "deny",
  })

  it("accepts a UTC-midnight Date as its calendar date and rejects any other instant", () => {
    const midnight = compile(new Date("2026-01-01T00:00:00.000Z"))
    expect(midnight.success && JSON.stringify(midnight.predicate)).toContain("\"2026-01-01\"")
    expect(compile(new Date("2026-01-01T12:00:00.000Z")).success).toBe(false)
  })
})
