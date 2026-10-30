import { describe } from "vitest"
import { buildActionScope } from "../../domain/abacReadScope"
import { bindAbacSecurityDigest } from "../../domain/abacBundleIntegrity"
import { Predicate, type PredicateNode } from "../../domain/predicate"
import type { AbacPolicyBundle, NormalizedAbacPolicy } from "../../domain/abacTypes"
import { bench, BENCH_OPTIONS } from "./benchOptions"

let sequence = 0
function policy(effect: "allow" | "deny", priority: number, compiledConditions: PredicateNode, actions: string[] = ["read"]): NormalizedAbacPolicy {
  sequence += 1
  return {
    source: { policyId: `scope-policy-${sequence}`, scopeType: "role", scopeRefId: `ref-${sequence}` },
    moduleKey: "bench.module",
    effect,
    priority,
    payload: {
      actions,
      capabilities: [],
      conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
    },
    compiledConditions,
  }
}

function bundleOf(policies: NormalizedAbacPolicy[], defaultEffect: "allow" | "deny" = "deny"): Promise<AbacPolicyBundle> {
  return bindAbacSecurityDigest({ mode: "tenant", moduleKey: "bench.module", policies, context: { userId: "user-42", tenantId: "tenant-1" }, defaultEffect, fieldCatalog: {}, cacheScopeKey: "bench" })
}

const empty = await bundleOf([])
const single = await bundleOf([policy("allow", 100, Predicate.eq("ownerId", "user-42"))])
const tiered = await bundleOf([
  policy("allow", 100, Predicate.alwaysTrue()),
  policy("allow", 200, Predicate.eq("ownerId", "user-42")),
  policy("allow", 300, Predicate.and(Predicate.eq("region", "emea"), Predicate.in("status", ["open", "pending"]))),
  policy("deny", 400, Predicate.and(Predicate.eq("archived", true), Predicate.lt("amount", 100))),
  policy("allow", 500, Predicate.or(Predicate.eq("ownerId", "user-42"), Predicate.eq("region", "apac"))),
  policy("deny", 600, Predicate.and(Predicate.isNotNull("deletedAt"), Predicate.neq("status", "open"))),
])
const many = await bundleOf(Array.from({ length: 50 }, (_, index) => policy(index % 4 === 0 ? "deny" : "allow", 100 + index * 10, Predicate.and(Predicate.eq("ownerId", `user-${index}`), Predicate.gte("amount", index)))))

describe("ABAC read-scope compilation", () => {
  bench("no relevant policy", () => { buildActionScope({ bundle: empty, action: "read" }) }, BENCH_OPTIONS)
  bench("single allow policy", () => { buildActionScope({ bundle: single, action: "read" }) }, BENCH_OPTIONS)
  bench("six tiered allow/deny policies", () => { buildActionScope({ bundle: tiered, action: "read" }) }, BENCH_OPTIONS)
  bench("fifty tiered policies", () => { buildActionScope({ bundle: many, action: "read" }) }, BENCH_OPTIONS)
})
