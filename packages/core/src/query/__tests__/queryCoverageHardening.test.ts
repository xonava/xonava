import { describe, expect, it } from "vitest"
import { Predicate } from "../../domain/predicate"
import { CancelledError, ConfigurationError, TimeoutError, ValidationError } from "../../domain/errors"
import { assertQueryBudget, validateQueryPlan, type QueryBudget } from "../queryBudget"
import { validateSearchRequest, validateSearchResult, type SearchCapability, type SearchRequest } from "../search"

const budget: QueryBudget = { maxPredicateDepth: 2, maxPredicateNodes: 3, maxOrBranches: 2, maxInValues: 2, maxSortFields: 1, maxProjectionFields: 1, maxSearchBytes: 4 }
const capability: SearchCapability = { portKey: "search", searchableFields: new Set(["name"]), filterableFields: new Set(["tenantId"]), sortableFields: new Set(["name"]), consistency: ["eventual"], maxQueryBytes: 5, maxResults: 2 }
const request: SearchRequest = { scope: { kind: "tenant", tenantId: "t1" }, text: "test", fields: ["name"], filter: { tenantId: "t1" }, sort: [{ field: "name", direction: "asc" }], limit: 2, consistency: "eventual" }

describe("query budget defensive coverage", () => {
  it("rejects malformed, incomplete, unknown, and non-positive budgets", () => {
    expect(() => assertQueryBudget(null as never)).toThrow(/object/)
    expect(() => assertQueryBudget([] as never)).toThrow(/object/)
    for (const key of Object.keys(budget) as (keyof QueryBudget)[]) {
      expect(() => assertQueryBudget({ ...budget, [key]: 0 })).toThrow(key)
      expect(() => assertQueryBudget({ ...budget, [key]: 1.5 })).toThrow(key)
    }
    expect(() => assertQueryBudget({ ...budget, extra: 1 } as never)).toThrow(/Unknown/)
  })

  it("enforces depth, node, sort, and projection limits", () => {
    expect(() => validateQueryPlan({ filter: Predicate.not(Predicate.not(Predicate.eq("id", 1))) }, budget)).toThrow(/depth/)
    expect(() => validateQueryPlan({ filter: Predicate.and(Predicate.eq("a", 1), Predicate.eq("b", 2), Predicate.eq("c", 3)) }, { ...budget, maxPredicateNodes: 3, maxOrBranches: 4 })).toThrow(/node count/)
    expect(() => validateQueryPlan({ sort: [{ field: "a", direction: "asc" }, { field: "b", direction: "desc" }] }, budget)).toThrow(/sort fields/)
    expect(() => validateQueryPlan({ projection: { fields: ["a", "b"] } }, budget)).toThrow(/projection fields/)
    expect(() => validateQueryPlan({}, budget)).not.toThrow()
  })
})

describe("search request and provider-result coverage", () => {
  it("rejects malformed capability declarations", () => {
    expect(() => validateSearchRequest(null as never, request)).toThrow(/portKey/)
    expect(() => validateSearchRequest({ ...capability, portKey: " " }, request)).toThrow(/portKey/)
    expect(() => validateSearchRequest({ ...capability, maxQueryBytes: 0 }, request)).toThrow(/budgets/)
    expect(() => validateSearchRequest({ ...capability, maxResults: 1.5 }, request)).toThrow(/budgets/)
    expect(() => validateSearchRequest({ ...capability, searchableFields: [] as never }, request)).toThrow(/declarations/)
    expect(() => validateSearchRequest({ ...capability, consistency: {} as never }, request)).toThrow(/declarations/)
  })

  it("rejects malformed, cancelled, expired, oversized, and unauthorized requests", () => {
    const aborted = new AbortController(); aborted.abort()
    const invalid: unknown[] = [
      null, { ...request, text: 1 }, { ...request, fields: {} }, { ...request, scope: { kind: "tenant", tenantId: "" } },
      { ...request, signal: aborted.signal }, { ...request, deadline: Number.NaN }, { ...request, deadline: Date.now() - 1 },
      { ...request, text: "€€" }, { ...request, limit: 0 }, { ...request, limit: 3 }, { ...request, fields: [""] },
      { ...request, fields: ["secret"] }, { ...request, filter: [] }, { ...request, filter: { secret: true } },
      { ...request, sort: {} }, { ...request, sort: [{ field: "name", direction: "asc" }, { field: "name", direction: "desc" }] },
      { ...request, sort: [{ field: "secret", direction: "asc" }] }, { ...request, consistency: "strong" },
    ]
    for (const value of invalid) expect(() => validateSearchRequest(capability, value as never)).toThrow()
    expect(() => validateSearchRequest(capability, request)).not.toThrow()
  })

  it("rejects excessive, inconsistent, duplicate, malformed, and unauthorized provider results", () => {
    const hit = { id: "1", score: 1, fields: { name: { display: "A" } } }
    const invalid: unknown[] = [
      null, { hits: {}, consistency: "eventual" }, { hits: [hit, hit, hit], consistency: "eventual" },
      { hits: [], consistency: "strong" }, { hits: [hit], consistency: "eventual", total: 0 },
      { hits: [{ ...hit, id: "" }], consistency: "eventual" },
      { hits: [hit, { ...hit }], consistency: "eventual" },
      { hits: [{ ...hit, score: Number.NaN }], consistency: "eventual" },
      { hits: [{ ...hit, fields: [] }], consistency: "eventual" },
      { hits: [{ ...hit, fields: { secret: true } }], consistency: "eventual" },
    ]
    for (const value of invalid) expect(() => validateSearchResult(capability, request, value as never)).toThrow(ConfigurationError)
    const result = validateSearchResult(capability, request, { hits: [hit], consistency: "eventual", total: 1 })
    expect(result).toEqual({ hits: [hit], consistency: "eventual", total: 1 })
    expect(Object.isFrozen(result.hits[0]?.fields.name)).toBe(true)
  })
})

describe("search error contract", () => {
  it("reports cancellation as CancelledError carrying the abort reason", () => {
    const controller = new AbortController(); const reason = new Error("client went away"); controller.abort(reason)
    let thrown: unknown
    try { validateSearchRequest(capability, { ...request, signal: controller.signal }) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(CancelledError)
    expect((thrown as Error).cause).toBe(reason)
  })

  it("reports an expired deadline as TimeoutError using the injected clock", () => {
    expect(() => validateSearchRequest(capability, { ...request, deadline: 1_000 }, 1_000)).toThrow(TimeoutError)
    expect(() => validateSearchRequest(capability, { ...request, deadline: 1_000 }, 999)).not.toThrow()
    expect(() => validateSearchRequest(capability, { ...request, deadline: 1_000 }, { now: () => new Date(2_000) })).toThrow(TimeoutError)
    expect(() => validateSearchRequest(capability, { ...request, deadline: 1_000 }, { now: () => new Date(500) })).not.toThrow()
    expect(() => validateSearchRequest(capability, { ...request, deadline: Number.NaN }, 0)).toThrow(ValidationError)
    expect(() => validateSearchRequest(capability, { ...request, deadline: 1_000 }, Number.NaN)).toThrow(ConfigurationError)
  })

  it("does not re-check cancellation or deadline when validating a provider result", () => {
    const controller = new AbortController(); controller.abort()
    const late = { ...request, signal: controller.signal, deadline: Date.now() - 1 }
    expect(validateSearchResult(capability, late, { hits: [], consistency: "eventual" })).toEqual({ hits: [], consistency: "eventual" })
  })

  it("reports provider contract violations as ConfigurationError", () => {
    const hit = { id: "1", score: 1, fields: { name: "A" } }
    expect(() => validateSearchResult(capability, request, { hits: [hit, { ...hit, id: "2" }, { ...hit, id: "3" }], consistency: "eventual" })).toThrow(ConfigurationError)
    expect(() => validateSearchResult(capability, request, { hits: [], consistency: "strong" })).toThrow(ConfigurationError)
    expect(() => validateSearchResult(capability, request, { hits: [hit], consistency: "eventual", total: 0 })).toThrow(ConfigurationError)
    expect(() => validateSearchResult(capability, request, { hits: [{ ...hit, score: Number.NaN }], consistency: "eventual" })).toThrow(ConfigurationError)
    expect(() => validateSearchResult(capability, request, { hits: [{ ...hit, fields: { secret: true } }], consistency: "eventual" })).toThrow(ConfigurationError)
  })
})
