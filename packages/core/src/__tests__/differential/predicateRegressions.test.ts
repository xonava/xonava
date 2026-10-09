import { describe, expect, it } from "vitest"
import { Predicate, type PredicateNode } from "../../domain/predicate"
import { evaluatePredicate, evaluatePredicateTruth, MAX_PREDICATE_EVALUATION_DEPTH, parseRfc3339Timestamp } from "../../domain/evaluatePredicate"
import { ValidationError } from "../../domain/errors"

/**
 * Minimal counterexamples found by the predicate-semantics differentials,
 * kept as named examples so the fixes cannot silently regress.
 */
describe("regressions found by the predicate-semantics differentials", () => {
  it("RFC 3339 years 0000-0099 are valid instants (Date.UTC maps them to 19xx)", () => {
    // Found by "rfc3339 round trip": 0000-01-02T17:08:00.00000000-06:52 parsed as null.
    expect(parseRfc3339Timestamp("0001-01-01T00:00:00Z")).toBe(Date.parse("0001-01-01T00:00:00Z"))
    expect(parseRfc3339Timestamp("0099-11-16")).toBe(Date.parse("0099-11-16T00:00:00Z"))
    expect(parseRfc3339Timestamp("0000-02-29")).toBe(Date.parse("0000-02-29T00:00:00Z"))
    expect(parseRfc3339Timestamp("0001-02-29")).toBeNull()
    expect(evaluatePredicateTruth({ at: new Date("0001-01-01T00:00:00Z") }, Predicate.eq("at", "0001-01-01T00:00:00Z"))).toBe(true)
    expect(evaluatePredicateTruth({ at: "0048-02-28T05:42:41.197Z" }, Predicate.gte("at", new Date("2025-12-31T23:59:59Z")))).toBe(false)
  })

  it("in with an empty list is FALSE for an array-valued field too (spec: empty list is FALSE)", () => {
    // Found by "in empty list": in(["x"], []) was UNKNOWN, so not(in(...)) excluded the row.
    expect(evaluatePredicateTruth({ tags: ["x"] }, Predicate.in("tags", []))).toBe(false)
    expect(evaluatePredicateTruth({ tags: ["x"] }, Predicate.in("tags", [null]))).toBe(false)
    expect(evaluatePredicate({ tags: ["x"] }, Predicate.not(Predicate.in("tags", [])))).toBe(true)
    expect(evaluatePredicateTruth({ tags: ["x"] }, Predicate.in("tags", ["x"]))).toBeNull()
  })

  it("includesAll does not depend on member order when the list contains NULL", () => {
    // Found by "includes decomposition": [null, "X"] was UNKNOWN but ["X", null] FALSE.
    const record = { tags: ["y", "z"] }
    expect(evaluatePredicateTruth(record, Predicate.includesAll("tags", [null, "X"]))).toBe(false)
    expect(evaluatePredicateTruth(record, Predicate.includesAll("tags", ["X", null]))).toBe(false)
    expect(evaluatePredicateTruth(record, Predicate.includesAll("tags", [null, "y"]))).toBeNull()
  })

  it("an over-deep predicate is rejected even when a sibling short-circuits evaluation", () => {
    // Found by "depth limit is data independent": and(false, <too deep>) returned FALSE.
    let deep: PredicateNode = Predicate.eq("amount", 1)
    for (let index = 0; index <= MAX_PREDICATE_EVALUATION_DEPTH; index++) deep = Predicate.not(deep)
    expect(() => evaluatePredicate({}, Predicate.and(Predicate.literal(false), deep))).toThrow(ValidationError)
    expect(() => evaluatePredicateTruth({}, Predicate.or(Predicate.literal(true), deep))).toThrow(ValidationError)
  })
})
