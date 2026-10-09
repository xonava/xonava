import { Predicate, ValidationError, type PredicateNode } from "core/domain"
import type { CursorDirection, CursorValue, SortSpec } from "core/query"

export interface CursorBoundary {
  readonly direction: CursorDirection
  readonly values: readonly CursorValue[]
}

export interface CursorWindow<T> {
  readonly rows: readonly T[]
  readonly hasNextPage: boolean
  readonly hasPreviousPage: boolean
}

function comparison(field: string, direction: "asc" | "desc", boundary: CursorDirection, value: Exclude<CursorValue, null>): PredicateNode {
  const greater = (direction === "asc") === (boundary === "after")
  return greater ? Predicate.gt(field, value) : Predicate.lt(field, value)
}

function compareNullable(spec: SortSpec, boundary: CursorDirection, value: CursorValue): PredicateNode {
  if (value === null) {
    if (!spec.nulls) throw new ValidationError(`nullable cursor field '${spec.field}' requires explicit null ordering`)
    const nullsAreBefore = spec.nulls === "first"
    return nullsAreBefore === (boundary === "after") ? Predicate.isNotNull(spec.field) : Predicate.alwaysFalse()
  }
  const scalar = comparison(spec.field, spec.direction, boundary, value)
  if (!spec.nulls) return scalar
  const nullsAreAfter = spec.nulls === "last"
  return nullsAreAfter === (boundary === "after")
    ? Predicate.or(scalar, Predicate.isNull(spec.field))
    : scalar
}

/** Builds a portable lexicographic keyset predicate shared by PG and D1. */
export function compileCursorPredicate(sort: readonly SortSpec[], boundary: CursorBoundary): PredicateNode {
  if (sort.length === 0 || boundary.values.length !== sort.length)
    throw new ValidationError("cursor values must match the complete sort tuple")
  return Predicate.or(...sort.map((spec, index) => {
    const equalPrefix = sort.slice(0, index).map((prefix, prefixIndex) =>
      boundary.values[prefixIndex] === null
        ? Predicate.isNull(prefix.field)
        : Predicate.eq(prefix.field, boundary.values[prefixIndex]!),
    )
    return Predicate.and(...equalPrefix, compareNullable(spec, boundary.direction, boundary.values[index]!))
  }))
}

/**
 * SQL results are reversed for a `before` page and restored before delivery.
 * Reversing the order reverses NULL placement too: `asc NULLS FIRST` read
 * backwards is `desc NULLS LAST`.
 */
export function executionSort(sort: readonly SortSpec[], direction: CursorDirection): readonly SortSpec[] {
  if (direction === "after") return sort
  return sort.map((item): SortSpec => ({
    ...item,
    direction: item.direction === "asc" ? "desc" : "asc",
    ...(item.nulls ? { nulls: item.nulls === "first" ? "last" : "first" } : {}),
  }))
}

/** Normalizes a limit+1 fetch into transport-neutral page information. */
export function normalizeCursorWindow<T>(rows: readonly T[], limit: number, direction: CursorDirection, hasBoundary = true): CursorWindow<T> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new ValidationError("cursor limit must be a positive safe integer")
  const hasExtra = rows.length > limit
  const page = rows.slice(0, limit)
  return {
    rows: direction === "before" ? [...page].reverse() : page,
    hasNextPage: direction === "after" ? hasExtra : hasBoundary,
    hasPreviousPage: direction === "before" ? hasExtra : hasBoundary,
  }
}
