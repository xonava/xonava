import { describe, expect, it, vi } from "vitest"
import { forAllAsync, type Rng } from "./harness"
import { ABAC_PROPERTY_TIMEOUT_MS, ABAC_ACTIONS, ABAC_CAPABILITIES, ABAC_MODULE, bindPolicies, canonicalPolicyLiteral } from "./abacArbitraries"
import { DIFFERENTIAL_FIELDS, IDENTIFIER_VALUES, fieldValue, generateRecord } from "./arbitraries"
import { normalizeAbacPolicy } from "../../domain/abacPolicyNormalizer"
import { defineAbacModule, type AbacModuleCatalog } from "../../domain/abacCatalog"
import { evaluatePredicateTruth } from "../../domain/evaluatePredicate"
import { findNonPortablePredicate, type PredicateNode } from "../../domain/predicate"
import type { AbacContext, AbacPolicy } from "../../domain/abacTypes"
import type { PolicyConditionGroup, PolicyFilterClause, PolicyOperator } from "../../domain/abacPolicySchema"

/**
 * Policy normalization end to end: generated condition trees (with user
 * attributes) go through normalizeAbacPolicy. Accepted policies must bind, be
 * date-free and portable, and an unresolved user attribute must fail closed
 * (never grant more through an allow, never match less through a deny).
 */

vi.setConfig({ testTimeout: ABAC_PROPERTY_TIMEOUT_MS })

const OPERATORS: readonly PolicyOperator[] = [
  "equals", "notEquals", "in", "isNull", "isNotNull", "isTrue", "isFalse", "greaterThan", "lessThan", "greaterOrEqual", "lessOrEqual", "between",
  "contains", "before", "after",
]

const CATALOG: AbacModuleCatalog = defineAbacModule({
  moduleKey: ABAC_MODULE,
  actions: [...ABAC_ACTIONS],
  capabilities: [...ABAC_CAPABILITIES],
  fields: Object.fromEntries(DIFFERENTIAL_FIELDS.map((field) => [field.key, { key: field.key, type: field.type, operators: [...OPERATORS, "includesAny", "isEmpty"] }])),
})

const USER_ATTRS = ["user.id", "user.branchId", "user.departmentId"] as const
const RESOLVED: AbacContext = { tenantId: "t1", userId: "u1", branchId: "u2", departmentId: "u3", roleId: "r1" }
const UNRESOLVED: AbacContext = { tenantId: "t1", roleId: "r1" }

function literal(rng: Rng, type: (typeof DIFFERENTIAL_FIELDS)[number]["type"]): unknown {
  const value = fieldValue(rng, type)
  return value instanceof Date ? value.toISOString() : value
}

function generateClause(rng: Rng): PolicyFilterClause {
  const field = rng.pick(DIFFERENTIAL_FIELDS)
  const operator = rng.pick(OPERATORS)
  const clause: PolicyFilterClause = { field: field.key, operator }
  const useAttr = field.type === "identifier" || rng.bool(0.15)
  if (operator === "in") {
    clause.values = Array.from({ length: 1 + rng.int(3) }, () => (useAttr && rng.bool(0.5) ? rng.pick(USER_ATTRS) : literal(rng, field.type)))
  } else if (operator === "between") {
    clause.value = { from: literal(rng, field.type), to: literal(rng, field.type) }
  } else if (useAttr && rng.bool(0.6)) {
    clause.userAttr = rng.pick(USER_ATTRS)
  } else {
    clause.value = literal(rng, field.type)
  }
  return clause
}

function generateGroup(rng: Rng, depth = 0): PolicyConditionGroup {
  return {
    logic: rng.bool() ? "AND" : "OR",
    conditions: Array.from({ length: rng.int(3) + (depth === 0 ? 0 : 1) }, () => (depth < 1 && rng.bool(0.25) ? generateGroup(rng, depth + 1) : generateClause(rng))),
  }
}

function generateRawPolicy(rng: Rng, id: string): AbacPolicy {
  return {
    source: { policyId: id, scopeType: "tenant_default" },
    moduleKey: ABAC_MODULE,
    effect: rng.bool() ? "allow" : "deny",
    priority: rng.pick([1, 5, 10]),
    payload: {
      actions: rng.subset(ABAC_ACTIONS, 0.6),
      capabilities: rng.subset(ABAC_CAPABILITIES, 0.3),
      conditions: { version: 2, systemScope: generateGroup(rng), userFilters: generateGroup(rng) },
    },
  }
}

function containsDate(value: unknown): boolean {
  if (value instanceof Date) return true
  if (Array.isArray(value)) return value.some(containsDate)
  if (value && typeof value === "object") return Object.values(value).some(containsDate)
  return false
}

describe("ABAC differential: normalization", () => {
  it("accepted policies bind, are date-free and portable, and unresolved user attributes fail closed", async () => {
    let accepted = 0
    await forAllAsync("abac normalization fail closed", (rng) => ({
      policies: Array.from({ length: 1 + rng.int(3) }, (_, index) => generateRawPolicy(rng, `n${index}`)),
      rows: Array.from({ length: 8 }, () => generateRecord(rng, { nullRate: 0.2, missingRate: 0.15 })),
    }), async ({ policies, rows }) => {
      for (const raw of policies) {
        const resolved = normalizeAbacPolicy({ policy: raw, catalog: CATALOG, context: RESOLVED })
        const unresolved = normalizeAbacPolicy({ policy: raw, catalog: CATALOG, context: UNRESOLVED })
        // One direction only: a resolved attribute value is type-checked against
        // the field (e.g. `dueOn after user.branchId` fails to coerce "u2"),
        // while an unresolved one compiles to the fail-closed constant, so a
        // policy may be rejected for users whose attribute resolves and
        // accepted (inertly) for users without it. Resolving must never turn
        // a rejected policy into an accepted one.
        if (resolved.success) expect(unresolved.success, "a policy accepted with resolved attributes is rejected without them").toBe(true)
        if (!resolved.success || !unresolved.success) continue
        accepted++
        for (const result of [resolved, unresolved]) {
          expect(containsDate(result.policy)).toBe(false)
          expect(findNonPortablePredicate(result.policy.compiledConditions)).toBeUndefined()
          await expect(bindPolicies([result.policy])).resolves.toBeDefined()
        }
        // Every possible resolution of the attributes, compared clause tree by clause tree.
        const alternatives: PredicateNode[] = [resolved.policy.compiledConditions]
        for (const userId of IDENTIFIER_VALUES) {
          const other = normalizeAbacPolicy({ policy: raw, catalog: CATALOG, context: { ...RESOLVED, userId, branchId: userId, departmentId: userId } })
          if (other.success) alternatives.push(other.policy.compiledConditions)
        }
        for (const row of rows) {
          const unknownTruth = evaluatePredicateTruth(row, unresolved.policy.compiledConditions)
          for (const alternative of alternatives) {
            const truth = evaluatePredicateTruth(row, alternative)
            if (raw.effect === "allow" && unknownTruth === true) expect(truth, `unresolved allow grants ${JSON.stringify(row)}`).toBe(true)
            if (raw.effect === "deny" && truth !== false) expect(unknownTruth, `unresolved deny misses ${JSON.stringify(row)}`).not.toBe(false)
          }
        }
      }
    }, { runs: 400 })
    expect(accepted).toBeGreaterThan(50)
  })
})

describe("ABAC differential: generated bundles model normalization", () => {
  it("canonicalizes date/datetime literals exactly as normalizeAbacPolicy does", async () => {
    await forAllAsync("abac literal canonicalization", (rng) => {
      const field = rng.pick(DIFFERENTIAL_FIELDS.filter((candidate) => candidate.type === "date" || candidate.type === "datetime"))
      const value = fieldValue(rng, field.type)
      return { field: field.key, type: field.type, value: rng.bool(0.5) && typeof value === "string" ? value : value }
    }, async ({ field, type, value }) => {
      const raw: AbacPolicy = {
        source: { policyId: "c", scopeType: "tenant_default" }, moduleKey: ABAC_MODULE, effect: "deny", priority: 1,
        payload: { actions: ["read"], capabilities: [], conditions: { version: 2, systemScope: { logic: "AND", conditions: [{ field, operator: "equals", value }] }, userFilters: { logic: "AND", conditions: [] } } },
      }
      const result = normalizeAbacPolicy({ policy: raw, catalog: CATALOG, context: RESOLVED })
      if (!result.success) throw new Error(JSON.stringify(result.errors))
      const expected = canonicalPolicyLiteral(type, value as string | Date)
      expect(JSON.stringify(result.policy.compiledConditions)).toContain(JSON.stringify({ kind: "condition", field, op: "eq", value: expected }))
    }, { runs: 200 })
  })
})
