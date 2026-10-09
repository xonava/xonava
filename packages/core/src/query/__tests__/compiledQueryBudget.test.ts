import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { DEFAULT_QUERY_BUDGET, compileQueryBudget, validateQueryPlan } from "../queryBudget"

describe("compileQueryBudget", () => {
  it("defaults every budget key and ignores non-budget limits", () => {
    const budget = compileQueryBudget({ maxSortFields: 2, maxOffset: 100, maxCount: 10, maxSearchableColumns: 1, maxFilterJsonBytes: 64 })
    expect(budget).toEqual({ ...DEFAULT_QUERY_BUDGET, maxSortFields: 2 })
    expect(Object.isFrozen(budget)).toBe(true)
    expect(() => validateQueryPlan({ sort: [{ field: "a", direction: "asc" }] }, budget)).not.toThrow()
    expect(() => validateQueryPlan({ sort: [{ field: "a", direction: "asc" }, { field: "b", direction: "asc" }, { field: "c", direction: "asc" }] }, budget)).toThrow(/maximum sort fields/)
  })

  it("returns the defaults when no limits are declared", () => {
    expect(compileQueryBudget(undefined)).toEqual(DEFAULT_QUERY_BUDGET)
  })

  it("rejects invalid budget values", () => {
    expect(() => compileQueryBudget({ maxSortFields: 0 })).toThrow(ValidationError)
  })
})
