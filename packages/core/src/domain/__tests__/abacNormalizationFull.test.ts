import { describe, it, expect } from "vitest"
import { normalizeAbacPolicy } from "../abacPolicyNormalizer"
import type { AbacModuleCatalog } from "../abacCatalog"
import type { AbacContext } from "../abacTypes"

const testCatalog: AbacModuleCatalog = {
  moduleKey: "test.module",
  actions: ["read", "update"],
  capabilities: ["export"],
  fields: {
    branchId: { key: "branchId", type: "string", operators: ["equals"] },
    status: { key: "status", type: "string", operators: ["equals"] },
  },
}

const context: AbacContext = { userId: "u1", tenantId: "t1" }

describe("normalizeAbacPolicy with catalog validation", () => {
  it("accepts valid policy", () => {
    const result = normalizeAbacPolicy({
      policy: {
        source: { policyId: "p1", scopeType: "tenant_default" },
        moduleKey: "test.module",
        effect: "allow",
        priority: 100,
        payload: {
          actions: ["read"],
          capabilities: [],
          conditions: {
            version: 2,
            systemScope: { logic: "AND", conditions: [{ field: "branchId", operator: "equals", value: "branch-1" }] },
            userFilters: { logic: "AND", conditions: [] },
          },
        },
      },
      catalog: testCatalog,
      context,
    })
    expect(result.success).toBe(true)
  })

  it("rejects unknown action", () => {
    const result = normalizeAbacPolicy({
      policy: {
        source: { policyId: "p2", scopeType: "tenant_default" },
        moduleKey: "test.module",
        effect: "allow",
        priority: 100,
        payload: {
          actions: ["delete"],
          capabilities: [],
          conditions: {
            version: 2,
            systemScope: { logic: "AND", conditions: [] },
            userFilters: { logic: "AND", conditions: [] },
          },
        },
      },
      catalog: testCatalog,
      context,
    })
    expect(result.success).toBe(false)
  })
})
