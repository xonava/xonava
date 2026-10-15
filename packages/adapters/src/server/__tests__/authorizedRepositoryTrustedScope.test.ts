import { describe, expect, it } from "vitest"
import { Predicate, bindAbacSecurityDigest, createAbacAuthorizer, evaluatePredicate, type NormalizedAbacPolicy, type PredicateNode } from "@xonava/core/domain"
import { DEFAULT_QUERY_BUDGET, validateQueryPlan, type QueryPlan } from "@xonava/core/query"
import type { ListResult } from "@xonava/core/query"
import type { VersionedEntityDescriptor, VersionedRepository } from "@xonava/core/persistence"
import { createAuthorizedRepository } from "../authorizedRepository"

/**
 * Regression: ABAC scopes counted against the caller's query budget, so a
 * read whose scope was deeper than DEFAULT_QUERY_BUDGET.maxPredicateDepth was
 * rejected ("query predicate exceeds maximum depth") before reaching the DB.
 */

interface Row { id: string; tenantId: string; status: string; region: string; ownerId: string; name: string; version: number; [key: string]: unknown }

const entity: VersionedEntityDescriptor<Row> = {
  name: "doc", primaryKey: "id", tenantField: "tenantId", versionField: "version",
  fields: { id: { type: "string" }, tenantId: { type: "string" }, status: { type: "string" }, region: { type: "string" }, ownerId: { type: "string" }, name: { type: "string" }, version: { type: "number" } },
}

const rows: Row[] = [
  { id: "1", tenantId: "t1", status: "draft", region: "eu", ownerId: "u1", name: "a", version: 1 },
  { id: "2", tenantId: "t1", status: "open", region: "eu", ownerId: "u1", name: "a", version: 1 },
  { id: "3", tenantId: "t1", status: "open", region: "us", ownerId: "u2", name: "a", version: 1 },
]

/** Validates every findMany plan with the default budget, as the drizzle repositories do. */
function validatingRepository(): VersionedRepository<Row, string> {
  const unused = () => Promise.reject(new Error("not used"))
  return {
    findMany: (options?: { filter?: PredicateNode }): Promise<ListResult<Row>> => {
      const plan: QueryPlan = options?.filter ? { filter: options.filter } : {}
      validateQueryPlan(plan)
      const matched = rows.filter((row) => !options?.filter || evaluatePredicate(row, options.filter))
      return Promise.resolve({ rows: matched, rowCount: matched.length, page: 1, pageSize: 100 })
    },
    findById: unused, findOneWhere: unused, insert: unused, update: unused, updateOneWhere: unused,
    updateOneWhereReturning: unused, delete: unused, deleteWhere: unused,
  } as unknown as VersionedRepository<Row, string>
}

function policy(id: string, effect: "allow" | "deny", priority: number, when: PredicateNode): NormalizedAbacPolicy {
  return {
    source: { policyId: id, scopeType: "tenant_default" }, moduleKey: "docs", effect, priority,
    payload: { actions: ["read"], capabilities: [], conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } } },
    compiledConditions: when,
  }
}

describe("authorized repository: trusted scopes and the caller query budget", () => {
  it("reads through a deep ABAC scope plus a caller filter that uses the whole budget", async () => {
    const bundle = await bindAbacSecurityDigest({
      mode: "tenant", moduleKey: "docs", context: { tenantId: "t1" }, defaultEffect: "deny", fieldCatalog: {},
      policies: [
        policy("deny", "deny", 10, Predicate.and(Predicate.or(Predicate.eq("status", "draft"), Predicate.eq("status", "locked")), Predicate.eq("region", "eu"))),
        policy("allow", "allow", 1, Predicate.eq("ownerId", "u1")),
      ],
    })
    const repository = createAuthorizedRepository({
      repository: validatingRepository(), entity, authorizer: createAbacAuthorizer(bundle), bundle,
      structuralScope: Predicate.and(Predicate.eq("tenantId", "t1"), Predicate.isNotNull("id")),
    })
    expect((await repository.findMany()).rows.map((row) => row.id)).toEqual(["2"])
    let callerFilter: PredicateNode = Predicate.eq("name", "a")
    for (let depth = 1; depth < DEFAULT_QUERY_BUDGET.maxPredicateDepth; depth++) callerFilter = Predicate.and(callerFilter, Predicate.isNotNull("name"))
    expect((await repository.findMany({ filter: callerFilter })).rows.map((row) => row.id)).toEqual(["2"])
    expect(await repository.findById("1")).toBeNull()
    expect((await repository.findById("2"))?.id).toBe("2")
    // The caller's own filter is still held to the budget.
    await expect(repository.findMany({ filter: Predicate.not(callerFilter) })).rejects.toThrow("exceeds maximum depth")
  })
})
