import { describe, expect, it } from "vitest"
import { ValidationError } from "../errors"
import { compareCodePoints, evaluatePredicate, evaluatePredicateTruth, MAX_PREDICATE_EVALUATION_DEPTH, parseRfc3339Timestamp } from "../evaluatePredicate"
import type { PredicateNode } from "../predicate"

const cond = (field: string, op: string, value?: unknown): PredicateNode => ({ kind: "condition", field, op, ...(value === undefined ? {} : { value }) }) as never
const lit = (value: boolean): PredicateNode => ({ kind: "literal", value })
const and = (...filters: PredicateNode[]): PredicateNode => ({ kind: "and", filters })
const or = (...filters: PredicateNode[]): PredicateNode => ({ kind: "or", filters })
const not = (filter: PredicateNode): PredicateNode => ({ kind: "not", filter })
const truth = (record: Record<string, unknown>, node: PredicateNode): boolean | null => evaluatePredicateTruth(record, node)
const nested = (depth: number, leaf: PredicateNode = lit(true), wrap: (n: PredicateNode) => PredicateNode = not): PredicateNode => {
  let node = leaf
  for (let i = 0; i < depth; i++) node = wrap(node)
  return node
}

describe("parseRfc3339Timestamp", () => {
  it("parses full dates as UTC midnight", () => {
    expect(parseRfc3339Timestamp("2026-01-02")).toBe(Date.UTC(2026, 0, 2))
    expect(parseRfc3339Timestamp("2024-02-29")).toBe(Date.UTC(2024, 1, 29))
  })

  it("parses date-times with Z, fractions and offsets", () => {
    expect(parseRfc3339Timestamp("2026-01-02T03:04:05Z")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5))
    expect(parseRfc3339Timestamp("2026-01-02T03:04:05.123Z")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5, 123))
    expect(parseRfc3339Timestamp("2026-01-02T03:04:05+05:30")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5) - (5 * 60 + 30) * 60_000)
    expect(parseRfc3339Timestamp("2026-01-02T03:04:05-08:00")).toBe(Date.UTC(2026, 0, 2, 3, 4, 5) + 8 * 3_600_000)
    expect(parseRfc3339Timestamp("2026-12-31T23:59:59+23:59")).toBe(Date.UTC(2026, 11, 31, 23, 59, 59) - (23 * 60 + 59) * 60_000)
  })

  it("keeps years below 100 intact", () => {
    expect(parseRfc3339Timestamp("0001-01-01T00:00:00Z")).toBe(Date.parse("0001-01-01T00:00:00Z"))
  })

  it.each([
    "", "2026", "2026-1-02", "26-01-02", "2026-01-02T03:04", "2026-01-02T03:04:05", "2026-01-02 03:04:05Z", "x2026-01-02", "2026-01-02x",
    "2026-01-02T03:04:05Zx", "2026-01-02T03:04:05.Z", "2026-01-02T03:04:05.1234567890Z", "2026-01-02T03:04:05+0530", "2026-01-02T3:04:05Z",
    "2026-01-02T03:4:05Z", "2026-01-02T03:04:5Z", "2026-01-02T03:04:05+5:30", "2026-01-02T03:04:05+05:3", "20260-01-02", "abcd-01-02",
    "2026-ab-02", "2026-01-ab", "2026-01-02Tab:04:05Z", "2026-01-02T03:ab:05Z", "2026-01-02T03:04:abZ",
  ])("rejects the malformed shape %j", (value) => {
    expect(parseRfc3339Timestamp(value)).toBeNull()
  })

  it.each([
    "2026-02-30", "2026-02-29", "2026-04-31", "2026-00-10", "2026-13-10", "2026-01-00", "2026-01-32",
    "2026-01-02T24:00:00Z", "2026-01-02T00:60:00Z", "2026-01-02T00:00:60Z", "2026-01-02T00:00:00+24:00", "2026-01-02T00:00:00+00:60",
  ])("rejects the out-of-range value %s", (value) => {
    expect(parseRfc3339Timestamp(value)).toBeNull()
  })

  it("accepts the last valid value of each clock field", () => {
    expect(parseRfc3339Timestamp("2026-01-02T23:00:00Z")).toBe(Date.UTC(2026, 0, 2, 23))
    expect(parseRfc3339Timestamp("2026-01-02T00:59:00Z")).toBe(Date.UTC(2026, 0, 2, 0, 59))
    expect(parseRfc3339Timestamp("2026-01-02T00:00:59Z")).toBe(Date.UTC(2026, 0, 2, 0, 0, 59))
    expect(parseRfc3339Timestamp("2026-01-02T00:00:00+23:00")).toBe(Date.UTC(2026, 0, 2) - 23 * 3_600_000)
    expect(parseRfc3339Timestamp("2026-01-02T00:00:00+00:59")).toBe(Date.UTC(2026, 0, 2) - 59 * 60_000)
  })
})

describe("compareCodePoints", () => {
  it("orders by code point, including astral characters", () => {
    expect(compareCodePoints("a", "b")).toBe(-1)
    expect(compareCodePoints("b", "a")).toBe(1)
    expect(compareCodePoints("a", "a")).toBe(0)
    expect(compareCodePoints("ab", "abc")).toBe(-1)
    expect(compareCodePoints("abc", "ab")).toBe(1)
    expect(compareCodePoints("\u{1F600}", "\u{1F601}")).toBe(-1)
    expect(compareCodePoints("\u{1F600}a", "\u{1F600}b")).toBe(-1)
    expect(compareCodePoints("\u{1F600}b", "\u{1F600}a")).toBe(1)
    expect(compareCodePoints("￿", "\u{10000}")).toBe(-1)
  })
})

describe("comparison semantics", () => {
  it("never coerces between primitive kinds", () => {
    expect(truth({ n: 1 }, cond("n", "isTrue"))).toBeNull()
    expect(truth({ n: 0 }, cond("n", "isFalse"))).toBeNull()
    expect(truth({ n: "100" }, cond("n", "eq", 100))).toBeNull()
    expect(truth({ n: 100 }, cond("n", "eq", "100"))).toBeNull()
    expect(truth({ n: 1 }, cond("n", "eq", true))).toBeNull()
    expect(truth({ n: true }, cond("n", "eq", 1))).toBeNull()
    expect(truth({ n: "x" }, cond("n", "gt", {}))).toBeNull()
    expect(truth({ n: Number.NaN }, cond("n", "eq", 1))).toBeNull()
    expect(truth({ n: 1 }, cond("n", "eq", Number.NaN))).toBeNull()
  })

  it("orders booleans false before true", () => {
    expect(truth({ b: true }, cond("b", "gt", false))).toBe(true)
    expect(truth({ b: false }, cond("b", "gt", true))).toBe(false)
    expect(truth({ b: false }, cond("b", "lt", true))).toBe(true)
    expect(truth({ b: true }, cond("b", "gte", true))).toBe(true)
    expect(truth({ b: true }, cond("b", "lte", false))).toBe(false)
  })

  it("orders numbers and strings with all four operators", () => {
    expect(truth({ n: 2 }, cond("n", "gt", 1))).toBe(true)
    expect(truth({ n: 1 }, cond("n", "gt", 1))).toBe(false)
    expect(truth({ n: 1 }, cond("n", "gte", 1))).toBe(true)
    expect(truth({ n: 0 }, cond("n", "gte", 1))).toBe(false)
    expect(truth({ n: 1 }, cond("n", "lt", 1))).toBe(false)
    expect(truth({ n: 0 }, cond("n", "lt", 1))).toBe(true)
    expect(truth({ n: 1 }, cond("n", "lte", 1))).toBe(true)
    expect(truth({ n: 2 }, cond("n", "lte", 1))).toBe(false)
    expect(truth({ s: "b" }, cond("s", "gt", "a"))).toBe(true)
    expect(truth({ s: "a" }, cond("s", "gt", "b"))).toBe(false)
  })

  it("compares instants with dates and RFC 3339 strings in both directions", () => {
    const date = new Date("2026-01-02T00:00:00.000Z")
    expect(truth({ d: date }, cond("d", "eq", "2026-01-02"))).toBe(true)
    expect(truth({ d: date }, cond("d", "lt", "2026-01-03T00:00:00Z"))).toBe(true)
    expect(truth({ d: "2026-01-02T00:00:00Z" }, cond("d", "eq", date))).toBe(true)
    expect(truth({ d: "2026-01-03T00:00:00+00:00" }, cond("d", "gt", date))).toBe(true)
    expect(truth({ d: date }, cond("d", "eq", "not a date"))).toBeNull()
    expect(truth({ d: "2026-02-30" }, cond("d", "eq", date))).toBeNull()
    expect(truth({ d: date }, cond("d", "eq", "2026-01-02 00:00:00"))).toBeNull()
    expect(truth({ d: new Date(Number.NaN) }, cond("d", "eq", date))).toBeNull()
    expect(truth({ d: date }, cond("d", "eq", 1))).toBeNull()
    expect(truth({ d: "2026-01-02" }, cond("d", "eq", "2026-01-02T00:00:00Z"))).toBe(false)
  })
})

describe("string operators", () => {
  it.each(["contains", "startsWith", "endsWith"])("%s is UNKNOWN for nullish or non-string operands", (op) => {
    expect(truth({ s: 42 }, cond("s", op, "4"))).toBeNull()
    expect(truth({ s: "abc" }, cond("s", op, 5))).toBeNull()
    expect(truth({ s: null }, cond("s", op, "a"))).toBeNull()
    expect(truth({}, cond("s", op, "a"))).toBeNull()
    expect(truth({ s: "abc" }, cond("s", op))).toBeNull()
  })

  it("matches and rejects strings", () => {
    expect(truth({ s: "abc" }, cond("s", "contains", "b"))).toBe(true)
    expect(truth({ s: "abc" }, cond("s", "contains", "x"))).toBe(false)
    expect(truth({ s: "abc" }, cond("s", "startsWith", "ab"))).toBe(true)
    expect(truth({ s: "abc" }, cond("s", "startsWith", "bc"))).toBe(false)
    expect(truth({ s: "abc" }, cond("s", "endsWith", "bc"))).toBe(true)
    expect(truth({ s: "abc" }, cond("s", "endsWith", "ab"))).toBe(false)
  })
})

describe("in, includesAny, includesAll and between", () => {
  it("in rejects non-array operands and treats an all-null list as FALSE", () => {
    expect(truth({ r: "a" }, cond("r", "in", "a"))).toBe(false)
    expect(truth({ r: "a" }, cond("r", "in"))).toBe(false)
    expect(truth({ r: null }, cond("r", "in", [null]))).toBe(false)
    expect(truth({ r: "a" }, cond("r", "in", []))).toBe(false)
    expect(truth({ r: null }, cond("r", "in", [null, "a"]))).toBeNull()
    expect(truth({}, cond("r", "in", ["a"]))).toBeNull()
    expect(truth({ r: ["a"] }, cond("r", "in", ["a"]))).toBeNull()
  })

  it("in reports FALSE for a miss, TRUE for any hit and ignores null members", () => {
    expect(truth({ r: "z" }, cond("r", "in", ["x", "y"]))).toBe(false)
    expect(truth({ r: "y" }, cond("r", "in", ["x", "y"]))).toBe(true)
    expect(truth({ r: "y" }, cond("r", "in", [null, "y"]))).toBe(true)
    expect(truth({ r: "z" }, cond("r", "in", [null, "y"]))).toBe(false)
    expect(truth({ r: 1 }, cond("r", "in", ["x", 1]))).toBe(true)
    expect(truth({ r: 1 }, cond("r", "in", ["x"]))).toBeNull()
    expect(truth({ r: 1 }, cond("r", "in", ["x", 2]))).toBeNull()
  })

  it("includesAny follows Kleene logic over the actual array", () => {
    expect(truth({ a: "x" }, cond("a", "includesAny", ["x"]))).toBeNull()
    expect(truth({}, cond("a", "includesAny", ["x"]))).toBeNull()
    expect(truth({ a: ["x", "y"] }, cond("a", "includesAny", ["z", "y"]))).toBe(true)
    expect(truth({ a: ["x", "y"] }, cond("a", "includesAny", ["z"]))).toBe(false)
    expect(truth({ a: ["x"] }, cond("a", "includesAny", [null, "x"]))).toBe(true)
    expect(truth({ a: ["x"] }, cond("a", "includesAny", [null]))).toBe(false)
    expect(truth({ a: ["x"] }, cond("a", "includesAny", "x"))).toBe(false)
    expect(truth({ a: ["x"] }, cond("a", "includesAny"))).toBe(false)
    expect(truth({ a: [] }, cond("a", "includesAny", ["x"]))).toBe(false)
  })

  it("includesAll treats a null member as UNKNOWN regardless of order", () => {
    expect(truth({ a: "x" }, cond("a", "includesAll", ["x"]))).toBeNull()
    expect(truth({ a: ["x", "y"] }, cond("a", "includesAll", ["x", "y"]))).toBe(true)
    expect(truth({ a: ["x"] }, cond("a", "includesAll", ["x", "y"]))).toBe(false)
    expect(truth({ a: [] }, cond("a", "includesAll", [null]))).toBeNull()
    expect(truth({ a: ["x"] }, cond("a", "includesAll", [null, "x"]))).toBeNull()
    expect(truth({ a: ["x"] }, cond("a", "includesAll", [null, "y"]))).toBe(false)
    expect(truth({ a: ["x"] }, cond("a", "includesAll", ["y", null]))).toBe(false)
    expect(truth({ a: ["x"] }, cond("a", "includesAll", "x"))).toBe(true)
    expect(truth({ a: ["x"] }, cond("a", "includesAll"))).toBe(true)
  })

  it("between needs an object with at least one bound", () => {
    for (const bad of [null, undefined, 5, "a", [1, 2], new Date(0), true, {}]) {
      expect(truth({ n: 1 }, cond("n", "between", bad))).toBe(false)
    }
    expect(truth({ n: 1 }, cond("n", "between", { from: 1 }))).toBe(true)
    expect(truth({ n: 0 }, cond("n", "between", { from: 1 }))).toBe(false)
    expect(truth({ n: 1 }, cond("n", "between", { to: 1 }))).toBe(true)
    expect(truth({ n: 2 }, cond("n", "between", { to: 1 }))).toBe(false)
    expect(truth({ n: 1 }, cond("n", "between", { from: 1, to: 1 }))).toBe(true)
    expect(truth({ n: 5 }, cond("n", "between", { from: 1, to: 3 }))).toBe(false)
    expect(truth({ n: 0 }, cond("n", "between", { from: 1, to: 3 }))).toBe(false)
    expect(truth({}, cond("n", "between", { from: 1, to: 3 }))).toBeNull()
    expect(truth({ n: "a" }, cond("n", "between", { from: 1 }))).toBeNull()
    expect(truth({ n: 5 }, cond("n", "between", { from: "a", to: 3 }))).toBe(false)
    expect(truth({ n: 0 }, cond("n", "between", { from: 1, to: "a" }))).toBe(false)
  })

  it("rejects unknown operators and unknown node kinds without matching", () => {
    expect(truth({ n: 1 }, cond("n", "regex", "1"))).toBe(false)
    expect(truth({ n: 1 }, { kind: "mystery" } as never)).toBeNull()
    expect(evaluatePredicate({ n: 1 }, { kind: "mystery" } as never)).toBe(false)
  })

  it("isEmpty and isNotEmpty distinguish arrays, empty strings and nullish", () => {
    expect(truth({ v: [] }, cond("v", "isEmpty"))).toBe(true)
    expect(truth({ v: [1] }, cond("v", "isEmpty"))).toBe(false)
    expect(truth({ v: "" }, cond("v", "isEmpty"))).toBe(true)
    expect(truth({ v: "x" }, cond("v", "isEmpty"))).toBe(false)
    expect(truth({}, cond("v", "isEmpty"))).toBe(true)
    expect(truth({ v: [] }, cond("v", "isNotEmpty"))).toBe(false)
    expect(truth({ v: [1] }, cond("v", "isNotEmpty"))).toBe(true)
    expect(truth({ v: "" }, cond("v", "isNotEmpty"))).toBe(false)
    expect(truth({ v: 0 }, cond("v", "isNotEmpty"))).toBe(true)
    expect(truth({}, cond("v", "isNotEmpty"))).toBe(false)
  })

  it("reads only own properties", () => {
    expect(truth(Object.create({ inherited: "x" }) as Record<string, unknown>, cond("inherited", "eq", "x"))).toBeNull()
    expect(truth({}, cond("toString", "isNull"))).toBe(true)
  })
})

describe("Kleene groups", () => {
  it("and: FALSE wins over UNKNOWN, UNKNOWN over TRUE", () => {
    const unknown = cond("missing", "eq", "x")
    expect(truth({}, and(unknown, lit(false)))).toBe(false)
    expect(truth({}, and(lit(false), unknown))).toBe(false)
    expect(truth({}, and(lit(true), unknown))).toBeNull()
    expect(truth({}, and(unknown, lit(true)))).toBeNull()
    expect(truth({}, and(lit(true), lit(true)))).toBe(true)
    expect(truth({}, and())).toBe(true)
  })

  it("or: TRUE wins over UNKNOWN, UNKNOWN over FALSE", () => {
    const unknown = cond("missing", "eq", "x")
    expect(truth({}, or(unknown, lit(true)))).toBe(true)
    expect(truth({}, or(lit(true), unknown))).toBe(true)
    expect(truth({}, or(lit(false), unknown))).toBeNull()
    expect(truth({}, or(unknown, lit(false)))).toBeNull()
    expect(truth({}, or(lit(false), lit(false)))).toBe(false)
    expect(truth({}, or())).toBe(false)
  })

  it("not keeps UNKNOWN and negates the rest", () => {
    expect(truth({}, not(cond("missing", "eq", "x")))).toBeNull()
    expect(truth({}, not(lit(true)))).toBe(false)
    expect(truth({}, not(lit(false)))).toBe(true)
  })

  it("evaluatePredicate collapses UNKNOWN to false only at the root", () => {
    expect(evaluatePredicate({}, cond("missing", "eq", "x"))).toBe(false)
    expect(evaluatePredicate({}, not(cond("missing", "eq", "x")))).toBe(false)
    expect(evaluatePredicate({}, lit(true))).toBe(true)
    expect(evaluatePredicate({}, { kind: "literal", value: "yes" } as never)).toBe(false)
  })
})

describe("evaluation depth limit", () => {
  const message = `Predicate nesting exceeds ${MAX_PREDICATE_EVALUATION_DEPTH} levels`

  function failure(run: () => unknown): Error {
    try {
      run()
    } catch (error) {
      return error as Error
    }
    throw new Error("expected the call to throw")
  }

  it("allows depth 256 and rejects 257 on the evaluation path", () => {
    expect(MAX_PREDICATE_EVALUATION_DEPTH).toBe(256)
    expect(truth({}, nested(256))).toBe(true === (256 % 2 === 0))
    const error = failure(() => truth({}, nested(257)))
    expect(error).toBeInstanceOf(ValidationError)
    expect(error.message).toBe(message)
  })

  it("still checks siblings that a short-circuit skips", () => {
    // The skipped sibling sits at depth 1; its chain adds one level per not.
    expect(truth({}, and(lit(false), nested(255)))).toBe(false)
    expect(truth({}, or(lit(true), nested(255)))).toBe(true)
    for (const group of [and(lit(false), nested(256)), or(lit(true), nested(256))]) {
      const error = failure(() => truth({}, group))
      expect(error).toBeInstanceOf(ValidationError)
      expect(error.message).toBe(message)
    }
  })

  it("walks skipped and/or/not subtrees to their full depth", () => {
    const deepAnd = nested(300, lit(true), (n) => and(n))
    const deepOr = nested(300, lit(true), (n) => or(n))
    const mixed = nested(150, nested(150, lit(true), (n) => or(n)), not)
    for (const skipped of [deepAnd, deepOr, mixed]) {
      expect(failure(() => truth({}, and(lit(false), skipped))).message).toBe(message)
      expect(failure(() => truth({}, or(lit(true), skipped))).message).toBe(message)
    }
    // Wide but shallow skipped trees are fine.
    const wide = and(...Array.from({ length: 400 }, () => lit(true)))
    expect(truth({}, and(lit(false), wide))).toBe(false)
  })

  it("ignores skipped groups whose filters are not arrays", () => {
    expect(truth({}, and(lit(false), { kind: "and", filters: "x" } as never))).toBe(false)
    expect(truth({}, or(lit(true), { kind: "or" } as never))).toBe(true)
    expect(truth({}, and(lit(false), { kind: "mystery" } as never, cond("a", "eq", 1)))).toBe(false)
  })
})
