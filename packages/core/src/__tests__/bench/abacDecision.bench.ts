import { describe } from "vitest"
import { evaluateAbacActionForCollection, evaluateAbacRecordAction, evaluateAbacRecordCapability, evaluateGlobalAbacCapability } from "../../domain/abacDecision"
import { bindAbacSecurityDigest } from "../../domain/abacBundleIntegrity"
import { Predicate, type PredicateNode } from "../../domain/predicate"
import type { AbacPolicyBundle, NormalizedAbacPolicy } from "../../domain/abacTypes"
import { bench, BENCH_OPTIONS } from "./benchOptions"

let sequence = 0
function policy(effect: "allow" | "deny", priority: number, compiledConditions: PredicateNode, scopeType: NormalizedAbacPolicy["source"]["scopeType"] = "role"): NormalizedAbacPolicy {
  sequence += 1
  return {
    source: { policyId: `policy-${sequence}`, scopeType, scopeRefId: `ref-${sequence}` },
    moduleKey: "bench.module",
    effect,
    priority,
    payload: {
      actions: ["read", "update"],
      capabilities: ["export"],
      conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
    },
    compiledConditions,
  }
}

/** A realistic mix: one tenant default, several role/branch tiers with conditions, and deny overrides. */
function policies(): NormalizedAbacPolicy[] {
  return [
    policy("allow", 100, Predicate.alwaysTrue(), "tenant_default"),
    policy("allow", 200, Predicate.eq("ownerId", "user-42"), "role"),
    policy("allow", 300, Predicate.and(Predicate.eq("region", "emea"), Predicate.in("status", ["open", "pending"])), "branch"),
    policy("deny", 400, Predicate.and(Predicate.eq("archived", true), Predicate.lt("amount", 100)), "department"),
    policy("allow", 500, Predicate.or(Predicate.eq("ownerId", "user-42"), Predicate.eq("region", "apac")), "user"),
    policy("deny", 600, Predicate.and(Predicate.isNotNull("deletedAt"), Predicate.neq("status", "open")), "user"),
    ...Array.from({ length: 10 }, (_, index) => policy(index % 3 === 0 ? "deny" : "allow", 700 + index, Predicate.eq("ownerId", `user-${index}`), "role")),
  ]
}

const bundle: AbacPolicyBundle = await bindAbacSecurityDigest({
  mode: "tenant",
  moduleKey: "bench.module",
  policies: policies(),
  context: { userId: "user-42", tenantId: "tenant-1" },
  defaultEffect: "deny",
  fieldCatalog: {},
})
const record: Record<string, unknown> = { ownerId: "user-42", region: "emea", status: "open", amount: 1250.5, archived: false, deletedAt: null }

describe("ABAC record decisions", () => {
  bench("record action decision (16 policies)", () => { evaluateAbacRecordAction({ bundle, action: "read", record }) }, BENCH_OPTIONS)
  bench("record action with no relevant policy", () => { evaluateAbacRecordAction({ bundle, action: "archive", record }) }, BENCH_OPTIONS)
  bench("record capability decision", () => { evaluateAbacRecordCapability({ bundle, capability: "export", record }) }, BENCH_OPTIONS)
  bench("global capability decision", () => { evaluateGlobalAbacCapability({ bundle, capability: "export" }) }, BENCH_OPTIONS)
  bench("collection action decision", () => { evaluateAbacActionForCollection({ bundle, action: "read" }) }, BENCH_OPTIONS)
})
