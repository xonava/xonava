import { describe, it, expect } from "vitest"
import { bindAbacSecurityDigest, buildTieredPolicyOutcome, evaluateAbacRecordAction, buildActionScope, Predicate } from "@xonava/core/domain"
import type { AbacPolicyBundle } from "@xonava/core/domain"

const emptyConditions = {
  version: 2 as const,
  systemScope: { logic: "AND" as const, conditions: [] },
  userFilters: { logic: "AND" as const, conditions: [] },
}

export function runAbacInvariantTests(): void {
  describe("ABAC invariants", () => {
    it("Deny always wins within same priority", () => {
      const result = buildTieredPolicyOutcome({
        policies: [
          { effect: "allow" as const, actions: ["read"] },
          { effect: "deny" as const, actions: ["read"] },
        ],
        getPriority: () => 0,
        getEffect: (p) => p.effect,
        getMatch: () => true,
        ops: {
          alwaysTrue: () => true,
          alwaysFalse: () => false,
          and: (exprs) => exprs.every(Boolean),
          or: (exprs) => exprs.some(Boolean),
          not: (expr) => !expr,
        },
      })
      expect(result).toBe(false)
    })

    it("Higher priority allow beats lower priority deny", () => {
      const result = buildTieredPolicyOutcome({
        policies: [
          { effect: "deny" as const, priority: 0 },
          { effect: "allow" as const, priority: 10 },
        ],
        getPriority: (p) => p.priority ?? 0,
        getEffect: (p) => p.effect,
        getMatch: () => true,
        ops: {
          alwaysTrue: () => true,
          alwaysFalse: () => false,
          and: (exprs) => exprs.every(Boolean),
          or: (exprs) => exprs.some(Boolean),
          not: (expr) => !expr,
        },
      })
      expect(result).toBe(true)
    })

    it("Higher priority deny beats lower priority allow", () => {
      const result = buildTieredPolicyOutcome({
        policies: [
          { effect: "allow" as const, priority: 0 },
          { effect: "deny" as const, priority: 10 },
        ],
        getPriority: (p) => p.priority ?? 0,
        getEffect: (p) => p.effect,
        getMatch: () => true,
        ops: {
          alwaysTrue: () => true,
          alwaysFalse: () => false,
          and: (exprs) => exprs.every(Boolean),
          or: (exprs) => exprs.some(Boolean),
          not: (expr) => !expr,
        },
      })
      expect(result).toBe(false)
    })

    it("No matching policies → default deny", () => {
      const result = buildTieredPolicyOutcome({
        policies: [],
        getPriority: () => 0,
        getEffect: () => "deny",
        getMatch: () => true,
        ops: {
          alwaysTrue: () => true,
          alwaysFalse: () => false,
          and: (exprs) => exprs.every(Boolean),
          or: (exprs) => exprs.some(Boolean),
          not: (expr) => !expr,
        },
      })
      expect(result).toBe(false)
    })

    it("Empty parsed conditions match all resources by canonical predicate semantics", () => {
      const bundle: AbacPolicyBundle = {
        mode: "tenant",
        moduleKey: "test",
        policies: [
          {
            moduleKey: "test",
            source: { policyId: "test", scopeType: "tenant_default" },
            effect: "allow",
            priority: 0,
            payload: {
              conditions: emptyConditions,
              actions: ["read"],
              capabilities: [],
            },
            compiledConditions: Predicate.alwaysTrue(),
          },
        ],
        context: { userId: "u1" },
        defaultEffect: "deny",
        fieldCatalog: {},
      }
      const result = evaluateAbacRecordAction({ bundle, action: "read", record: {} })
      expect(result.allowed).toBe(true)
    })

    it("Invalid policy data → fail closed (deny access)", () => {
      const bundle: AbacPolicyBundle = {
        mode: "tenant",
        moduleKey: "test",
        policies: [
          {
            moduleKey: "test",
            source: { policyId: "test", scopeType: "tenant_default" },
            effect: "deny",
            priority: 0,
            payload: {
              conditions: emptyConditions,
              actions: [],
              capabilities: [],
            },
            compiledConditions: Predicate.alwaysTrue(),
          },
        ],
        context: { userId: "u1" },
        defaultEffect: "deny",
        fieldCatalog: {},
      }
      const result = evaluateAbacRecordAction({ bundle, action: "read", record: {} })
      expect(result.allowed).toBe(false)
    })

    it("buildActionScope produces different scopes for read-only vs update-only bundles", async () => {
      const readBundle: AbacPolicyBundle = {
        mode: "tenant",
        moduleKey: "test",
        policies: [
          {
            moduleKey: "test",
            source: { policyId: "test", scopeType: "tenant_default" },
            effect: "allow",
            priority: 0,
            payload: {
              conditions: {
                version: 2,
                systemScope: {
                  logic: "AND",
                  conditions: [{ field: "departmentId", operator: "equals", value: "dept-1" }],
                },
                userFilters: { logic: "AND", conditions: [] },
              },
              actions: ["read"],
              capabilities: [],
            },
            compiledConditions: Predicate.alwaysTrue(),
          },
        ],
        context: { userId: "u1" },
        defaultEffect: "deny",
        fieldCatalog: {},
      }

      const updateBundle: AbacPolicyBundle = {
        mode: "tenant",
        moduleKey: "test",
        policies: [
          {
            moduleKey: "test",
            source: { policyId: "test", scopeType: "tenant_default" },
            effect: "allow",
            priority: 0,
            payload: {
              conditions: {
                version: 2,
                systemScope: {
                  logic: "AND",
                  conditions: [{ field: "departmentId", operator: "equals", value: "dept-2" }],
                },
                userFilters: { logic: "AND", conditions: [] },
              },
              actions: ["update"],
              capabilities: [],
            },
            compiledConditions: Predicate.alwaysTrue(),
          },
        ],
        context: { userId: "u1" },
        defaultEffect: "deny",
        fieldCatalog: {},
      }

      const readScope = buildActionScope({ bundle: await bindAbacSecurityDigest(readBundle), action: "read" })
      const updateScope = buildActionScope({ bundle: await bindAbacSecurityDigest(updateBundle), action: "read" })

      expect(JSON.stringify(readScope)).not.toBe(JSON.stringify(updateScope))
    })
  })
}
