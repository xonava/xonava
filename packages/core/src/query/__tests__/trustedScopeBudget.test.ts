import { describe, expect, it } from "vitest"
import { DEFAULT_QUERY_BUDGET, validateQueryPlan } from "../queryBudget"
import { Predicate, type PredicateNode } from "../../domain/predicate"
import { markTrustedPredicate } from "../../domain/trustedPredicate"
import { bindAbacSecurityDigest } from "../../domain/abacBundleIntegrity"
import { evaluateAbacActionForCollection } from "../../domain/abacDecision"
import { buildActionScope } from "../../domain/abacReadScope"
import { ConfigurationError, ValidationError } from "../../domain/errors"
import type { NormalizedAbacPolicy } from "../../domain/abacTypes"

/** A caller filter using the whole default depth budget: depth 5. */
function maxDepthCallerFilter(): PredicateNode {
  let node: PredicateNode = Predicate.eq("name", "x")
  for (let depth = 1; depth < DEFAULT_QUERY_BUDGET.maxPredicateDepth; depth++) node = Predicate.and(node, Predicate.eq("code", `c${depth}`))
  return node
}

function policy(id: string, effect: "allow" | "deny", priority: number, when: PredicateNode): NormalizedAbacPolicy {
  return {
    source: { policyId: id, scopeType: "tenant_default" }, moduleKey: "m", effect, priority,
    payload: { actions: ["read"], capabilities: [], conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } } },
    compiledConditions: when,
  }
}

describe("trusted mandatory scopes do not consume the caller's query budget", () => {
  // deny p10 `(status=draft OR status=locked) AND region=eu`, allow p1 `ownerId=u1`.
  const policies = [
    policy("deny", "deny", 10, Predicate.and(Predicate.or(Predicate.eq("status", "draft"), Predicate.eq("status", "locked")), Predicate.eq("region", "eu"))),
    policy("allow", "allow", 1, Predicate.eq("ownerId", "u1")),
  ]
  const bundle = () => bindAbacSecurityDigest({ mode: "tenant", moduleKey: "m", policies, context: { tenantId: "t1" }, defaultEffect: "deny", fieldCatalog: {} })

  it("accepts and(structural, ABAC scope, caller filter) for collection and action scopes", async () => {
    const verified = await bundle()
    const structural = markTrustedPredicate(Predicate.and(Predicate.eq("tenantId", "t1"), Predicate.isNull("deletedAt")))
    for (const scope of [evaluateAbacActionForCollection({ bundle: verified, action: "read" }).scope, buildActionScope({ bundle: verified, action: "read" }).filter]) {
      expect(() => validateQueryPlan({ filter: Predicate.and(structural, scope) })).not.toThrow()
      expect(() => validateQueryPlan({ filter: Predicate.and(structural, scope, maxDepthCallerFilter()) })).not.toThrow()
      expect(() => validateQueryPlan({ filter: Predicate.and(Predicate.and(Predicate.eq("id", "1"), structural), scope) })).not.toThrow()
    }
  })

  it("still enforces the budget on the caller's own filter", async () => {
    const verified = await bundle()
    const scope = evaluateAbacActionForCollection({ bundle: verified, action: "read" }).scope
    const tooDeep = Predicate.not(maxDepthCallerFilter())
    expect(() => validateQueryPlan({ filter: Predicate.and(scope, tooDeep) })).toThrow(ValidationError)
    expect(() => validateQueryPlan({ filter: tooDeep })).toThrow(ValidationError)
    // A caller-built copy of the scope is not trusted.
    expect(() => validateQueryPlan({ filter: Predicate.and(structuredClone(scope), maxDepthCallerFilter()) })).toThrow(ValidationError)
  })

  it("rejects a malformed or unboundedly deep trusted scope as a configuration error", () => {
    let deep: PredicateNode = Predicate.eq("a", 1)
    for (let depth = 0; depth < 400; depth++) deep = Predicate.not(deep)
    expect(() => validateQueryPlan({ filter: Predicate.and(markTrustedPredicate(deep), Predicate.eq("b", 1)) })).toThrow(ConfigurationError)
    const malformed = markTrustedPredicate({ kind: "condition", field: "a", op: "nope" } as unknown as PredicateNode)
    expect(() => validateQueryPlan({ filter: malformed })).toThrow(ConfigurationError)
  })
})
