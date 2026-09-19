import { describe, it, expect } from "vitest"
import { normalizeAbacPolicy } from "../abacPolicyNormalizer"
import type { AbacModuleCatalog } from "../abacCatalog"
import type { AbacPolicy, AbacContext } from "../abacTypes"
import type { PolicyFilterClause } from "../abacPolicySchema"

const testCatalog: AbacModuleCatalog = {
  moduleKey: "test.module",
  actions: ["read", "update", "delete"],
  capabilities: ["export", "manage"],
  fields: {
    status: { key: "status", type: "string", operators: ["equals"] },
    age: { key: "age", type: "number", operators: ["greaterThan", "lessThan"] },
    ownerId: { key: "ownerId", type: "string", operators: ["equals"] },
  },
}

const testContext: AbacContext = { userId: "user-1", roleId: "role-1", tenantId: "tenant-1" }

function makePolicy(overrides: Partial<AbacPolicy> = {}): AbacPolicy {
  return {
    source: { policyId: "test-policy", scopeType: "tenant_default" },
    moduleKey: "test.module",
    effect: "allow",
    priority: 100,
    payload: {
      actions: ["read"],
      capabilities: [],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
      },
    },
    ...overrides,
  }
}

describe("normalizeAbacPolicy", () => {
  it("normalizes a valid policy", () => {
    const result = normalizeAbacPolicy({ policy: makePolicy(), catalog: testCatalog, context: testContext })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.policy.moduleKey).toBe("test.module")
      expect(result.policy.compiledConditions).toBeDefined()
    }
  })

  it("rejects policy with unknown action", () => {
    const result = normalizeAbacPolicy({
      policy: makePolicy({ payload: { ...makePolicy().payload, actions: ["unknown-action"] } }),
      catalog: testCatalog,
      context: testContext,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.success).toBe(false)
    }
  })

  it("rejects policy with unknown capability", () => {
    const result = normalizeAbacPolicy({
      policy: makePolicy({ payload: { ...makePolicy().payload, capabilities: ["unknown-cap"] } }),
      catalog: testCatalog,
      context: testContext,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.success).toBe(false)
    }
  })

  it("rejects policy with unknown field in fieldAccess.read", () => {
    const result = normalizeAbacPolicy({
      policy: makePolicy({ payload: { ...makePolicy().payload, fieldAccess: { read: { unknownField: "allow" as const } } } }),
      catalog: testCatalog,
      context: testContext,
    })
    expect(result.success).toBe(false)
  })

  it("rejects policy with moduleKey mismatch", () => {
    const result = normalizeAbacPolicy({
      policy: makePolicy({ moduleKey: "wrong.module" }),
      catalog: testCatalog,
      context: testContext,
    })
    expect(result.success).toBe(false)
  })

  it("compiles conditions successfully", () => {
    const result = normalizeAbacPolicy({
      policy: makePolicy({
        payload: {
          actions: ["read"],
          capabilities: [],
          conditions: {
            version: 2,
            systemScope: {
              logic: "AND",
              conditions: [{ field: "status", operator: "equals", value: "active" }],
            },
            userFilters: { logic: "AND", conditions: [] },
          },
        },
      }),
      catalog: testCatalog,
      context: testContext,
    })
    expect(result.success).toBe(true)
  })

  it("canonicalizes date values so no Date instance survives normalization", () => {
    const catalog: AbacModuleCatalog = {
      moduleKey: "test.module",
      actions: ["read"],
      capabilities: [],
      fields: {
        createdAt: { key: "createdAt", type: "datetime", operators: ["equals"] },
      },
    }
    const result = normalizeAbacPolicy({
      policy: makePolicy({
        payload: {
          actions: ["read"],
          capabilities: [],
          conditions: {
            version: 2,
            systemScope: { logic: "AND", conditions: [{ field: "createdAt", operator: "equals", value: "2026-01-01T00:00:00.000Z" }] },
            userFilters: { logic: "AND", conditions: [] },
          },
        },
      }),
      catalog,
      context: testContext,
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(Object.isFrozen(result.policy)).toBe(true)
    expect(Object.isFrozen(result.policy.compiledConditions)).toBe(true)

    const found: Date[] = []
    const collectDates = (value: unknown): void => {
      if (value instanceof Date) found.push(value)
      else if (Array.isArray(value)) value.forEach(collectDates)
      else if (value && typeof value === "object") Object.values(value).forEach(collectDates)
    }
    collectDates(result.policy)
    expect(found).toEqual([])

    const conditions: Array<{ field?: unknown; op?: unknown; value?: unknown }> = []
    const walkConditions = (node: unknown): void => {
      if (node && typeof node === "object" && "kind" in node) {
        const current = node as { kind?: unknown; filters?: unknown; op?: unknown; value?: unknown }
        if (current.kind === "condition") conditions.push(node as { field?: unknown; op?: unknown; value?: unknown })
        if (Array.isArray(current.filters)) current.filters.forEach(walkConditions)
      }
    }
    walkConditions(result.policy.compiledConditions)
    expect(conditions).toHaveLength(1)
    expect(conditions[0]).toMatchObject({ op: "eq", value: "2026-01-01T00:00:00.000Z" })
  })

  it("rejects non-portable security predicates (substring, date scalar, empty array)", () => {
    const catalog: AbacModuleCatalog = {
      moduleKey: "test.module",
      actions: ["read"],
      capabilities: [],
      fields: {
        name: { key: "name", type: "string", operators: ["contains", "startsWith", "endsWith", "isEmpty"] },
        createdAt: { key: "createdAt", type: "datetime", operators: ["after", "before"] },
        age: { key: "age", type: "number", operators: ["greaterThan"] },
        tags: { key: "tags", type: "string-array", operators: ["includesAny"] },
      },
    }

    const expectRejected = (clause: PolicyFilterClause): void => {
      const result = normalizeAbacPolicy({
        policy: makePolicy({
          payload: {
            actions: ["read"],
            capabilities: [],
            conditions: {
              version: 2,
              systemScope: { logic: "AND", conditions: [clause] },
              userFilters: { logic: "AND", conditions: [] },
            },
          },
        }),
        catalog,
        context: testContext,
      })
      expect(result.success).toBe(false)
      if (!result.success) expect(result.errors).toContainEqual(expect.objectContaining({ code: "NON_PORTABLE_PREDICATE" }))
    }

    expectRejected({ field: "name", operator: "contains", value: "x" })
    expectRejected({ field: "name", operator: "startsWith", value: "x" })
    expectRejected({ field: "name", operator: "endsWith", value: "x" })
    expectRejected({ field: "createdAt", operator: "after", value: "2026-01-01" })
    expectRejected({ field: "createdAt", operator: "before", value: "2026-02-01" })

    const isEmptyResult = normalizeAbacPolicy({
      policy: makePolicy({
        payload: {
          actions: ["read"],
          capabilities: [],
          conditions: {
            version: 2,
            systemScope: { logic: "AND", conditions: [{ field: "tags", operator: "includesAny", values: ["x"] }, { field: "name", operator: "isEmpty" }] },
            userFilters: { logic: "AND", conditions: [] },
          },
        },
      }),
      catalog,
      context: testContext,
    })
    expect(isEmptyResult.success).toBe(false)
    if (!isEmptyResult.success) expect(isEmptyResult.errors).toContainEqual(expect.objectContaining({ code: "NON_PORTABLE_PREDICATE" }))

    const numericResult = normalizeAbacPolicy({
      policy: makePolicy({
        payload: {
          actions: ["read"],
          capabilities: [],
          conditions: {
            version: 2,
            systemScope: { logic: "AND", conditions: [{ field: "age", operator: "greaterThan", value: "18" }] },
            userFilters: { logic: "AND", conditions: [] },
          },
        },
      }),
      catalog,
      context: testContext,
    })
    expect(numericResult.success).toBe(true)
  })

  it("excludes a valid but inactive policy instead of failing", () => {
    const future = makePolicy({
      source: { policyId: "future", scopeType: "tenant_default", startsAt: new Date("2027-01-01") },
    })
    const result = normalizeAbacPolicy({ policy: future, catalog: testCatalog, context: testContext, at: new Date("2026-01-01") })
    expect(result.success).toBe(true)
    if (result.success) expect(result.excluded).toBe("inactive")

    const invalid = makePolicy({
      source: { policyId: "invalid-window", scopeType: "tenant_default", startsAt: new Date("2027-01-01"), endsAt: new Date("2026-01-01") },
    })
    const invalidResult = normalizeAbacPolicy({ policy: invalid, catalog: testCatalog, context: testContext, at: new Date("2026-01-01") })
    expect(invalidResult.success).toBe(false)
    if (!invalidResult.success) expect(invalidResult.errors).toContainEqual(expect.objectContaining({ code: "POLICY_WINDOW_INVALID" }))
  })
})
