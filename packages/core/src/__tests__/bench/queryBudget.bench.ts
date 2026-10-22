import { bench, describe } from "vitest"
import { compileQueryBudget, validateQueryPlan, DEFAULT_QUERY_BUDGET } from "../../query/queryBudget"
import { Predicate } from "../../domain/predicate"
import { markTrustedPredicate } from "../../domain/trustedPredicate"
import type { QueryPlan } from "../../query/queryPlan"
import { BENCH_OPTIONS } from "./benchOptions"

const limits = { maxPredicateDepth: 6, maxPredicateNodes: 80, maxInValues: 200, pageSizeLimit: 100, maxCount: 10_000 }

const simplePlan: QueryPlan = { filter: Predicate.eq("status", "open"), sort: [{ field: "createdAt", direction: "desc" }], pagination: { kind: "offset", page: 1, pageSize: 25 } }
const richPlan: QueryPlan = {
  filter: Predicate.and(
    Predicate.eq("status", "open"),
    Predicate.or(Predicate.eq("region", "emea"), Predicate.eq("region", "apac")),
    Predicate.between("amount", [100, 5000]),
    Predicate.in("ownerId", Array.from({ length: 50 }, (_, index) => `user-${index}`)),
    Predicate.not(Predicate.isNull("name")),
  ),
  sort: [{ field: "createdAt", direction: "desc" }, { field: "id", direction: "asc" }],
  pagination: { kind: "cursor", after: "opaque-cursor-token", limit: 50 },
  projection: { fields: ["id", "status", "amount", "region", "ownerId", "name", "createdAt"] },
  search: { text: "quarterly maintenance" },
}
const scoped: QueryPlan = {
  filter: Predicate.and(
    markTrustedPredicate(Predicate.or(Predicate.eq("ownerId", "user-42"), Predicate.and(Predicate.eq("region", "emea"), Predicate.in("status", ["open", "pending"])))),
    Predicate.eq("status", "open"),
    Predicate.gte("amount", 100),
  ),
  sort: [{ field: "createdAt", direction: "desc" }],
  pagination: { kind: "offset", page: 2, pageSize: 25 },
}

// Every measured plan must be valid: a plan that throws would time the error path instead.
for (const plan of [simplePlan, richPlan, scoped]) validateQueryPlan(plan, DEFAULT_QUERY_BUDGET)

describe("query budget", () => {
  bench("compile budget from defaults", () => { compileQueryBudget() }, BENCH_OPTIONS)
  bench("compile budget from entity limits", () => { compileQueryBudget(limits) }, BENCH_OPTIONS)
  bench("validate simple plan", () => { validateQueryPlan(simplePlan, DEFAULT_QUERY_BUDGET) }, BENCH_OPTIONS)
  bench("validate rich plan", () => { validateQueryPlan(richPlan, DEFAULT_QUERY_BUDGET) }, BENCH_OPTIONS)
  bench("validate plan with trusted ABAC scope", () => { validateQueryPlan(scoped, DEFAULT_QUERY_BUDGET) }, BENCH_OPTIONS)
})
