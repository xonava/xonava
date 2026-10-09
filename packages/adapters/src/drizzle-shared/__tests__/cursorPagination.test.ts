import { describe, expect, it } from "vitest"
import { compileCursorPredicate, executionSort, normalizeCursorWindow } from "../cursorPagination"
import { evaluatePredicate } from "core/domain"

describe("shared PG/D1 keyset pagination", () => {
  const sort = [{ field: "createdAt", direction: "asc" as const, nulls: "last" as const }, { field: "id", direction: "asc" as const }]
  it("builds a lexicographic predicate retaining the duplicate-value tie breaker", () => {
    expect(compileCursorPredicate(sort, { direction: "after", values: [100, "b"] })).toMatchObject({ kind: "or", filters: [{ kind: "and" }, { kind: "and", filters: [{ field: "createdAt", op: "eq", value: 100 }, { field: "id", op: "gt", value: "b" }] }] })
  })
  it("inverts previous-page order and restores delivery order", () => {
    expect(executionSort(sort, "before").map(item => item.direction)).toEqual(["desc", "desc"])
    expect(normalizeCursorWindow([4, 3, 2], 2, "before")).toEqual({ rows: [3, 4], hasNextPage: true, hasPreviousPage: true })
    expect(normalizeCursorWindow([2, 3, 4], 2, "after")).toEqual({ rows: [2, 3], hasNextPage: true, hasPreviousPage: true })
  })
  it("reverses NULL placement with the direction for a previous page", () => {
    // Regression (real-database differential): `asc NULLS FIRST` executed backwards must be
    // `desc NULLS LAST`, otherwise a backward walk never leaves the NULL group.
    expect(executionSort(sort, "before")).toEqual([{ field: "createdAt", direction: "desc", nulls: "first" }, { field: "id", direction: "desc" }])
    expect(executionSort([{ field: "a", direction: "desc", nulls: "first" }], "before")).toEqual([{ field: "a", direction: "asc", nulls: "last" }])
    expect(executionSort(sort, "after")).toBe(sort)
  })
  it("normalizes explicit null placement", () => {
    expect(compileCursorPredicate(sort, { direction: "after", values: [null, "a"] })).toMatchObject({ kind: "or" })
    expect(() => compileCursorPredicate([{ field: "nullable", direction: "asc" }], { direction: "after", values: [null] })).toThrow(/null ordering/)
  })
  it("does not duplicate rows when data is inserted or the boundary row is deleted", () => {
    const rows = [
      { createdAt: 1, id: "a" }, { createdAt: 1, id: "b" }, { createdAt: 2, id: "c" },
    ]
    const boundary = compileCursorPredicate(sort, { direction: "after", values: [1, "b"] })
    const changed = [{ createdAt: 0, id: "new" }, ...rows.filter(row => row.id !== "b")]
    expect(changed.filter(row => evaluatePredicate(row, boundary)).map(row => row.id)).toEqual(["c"])
  })
})
