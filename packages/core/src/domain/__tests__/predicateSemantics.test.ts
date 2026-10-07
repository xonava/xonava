import { describe, expect, it } from "vitest"
import { compareCodePoints, evaluatePredicate, evaluatePredicateTruth, MAX_PREDICATE_EVALUATION_DEPTH } from "../evaluatePredicate"
import { Predicate, type PredicateNode, type PredicatePrimitive } from "../predicate"
import { ValidationError } from "../errors"

const VALUES: readonly unknown[] = [undefined, null, Number.NaN, -1, 0, 0.5, 2, "", "0.5", "2", "a", "B", "é", "😀", "abc", true, false, new Date(0), new Date("invalid"), [1], { a: 1 }]
const LITERALS: readonly PredicatePrimitive[] = [null, -1, 0, 0.5, 2, "", "0.5", "a", "B", "é", true, false, new Date(0)]
const OPS = ["eq", "neq", "gt", "lt", "gte", "lte", "contains", "startsWith", "endsWith", "isTrue", "isFalse", "isNull", "isNotNull", "isEmpty", "isNotEmpty"] as const

function generator(seed: number) {
  let state = seed >>> 0
  const next = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
  const pick = <T>(values: readonly T[]): T => values[next() % values.length]!
  const leaf = (): PredicateNode => {
    const roll = next() % 4
    if (roll === 0) return Predicate.in("x", [pick(LITERALS), pick(LITERALS)])
    if (roll === 1) return Predicate.between("x", { from: pick(LITERALS), to: pick(LITERALS) })
    return { kind: "condition", field: "x", op: pick(OPS), value: pick(LITERALS) }
  }
  const node = (depth: number): PredicateNode => {
    const roll = next() % 8
    if (depth > 3 || roll < 3) return leaf()
    if (roll < 5) return Predicate.not(node(depth + 1))
    const children = [node(depth + 1), node(depth + 1)]
    return roll < 7 ? Predicate.and(...children) : Predicate.or(...children)
  }
  return { node: () => node(0), record: () => ({ x: pick(VALUES) }) }
}

describe("normative predicate semantics", () => {
  it("never treats incomparable operands as equal", () => {
    for (const record of [{ amount: Number.NaN }, { amount: "abc" }, { amount: {} }, { amount: [] }, { amount: true }]) {
      expect(evaluatePredicate(record, Predicate.lte("amount", 100))).toBe(false)
      expect(evaluatePredicate(record, Predicate.gte("amount", 100))).toBe(false)
      expect(evaluatePredicate(record, Predicate.between("amount", [1, 1000]))).toBe(false)
      expect(evaluatePredicate(record, Predicate.not(Predicate.lte("amount", 100)))).toBe(false)
    }
  })

  it("never coerces across kinds: \"100\" and 100 are different values", () => {
    expect(evaluatePredicateTruth({ id: "100" }, Predicate.eq("id", 100))).toBeNull()
    expect(evaluatePredicateTruth({ id: 100 }, Predicate.eq("id", "100"))).toBeNull()
    expect(evaluatePredicateTruth({ amount: "9" }, Predicate.lte("amount", 100))).toBeNull()
    expect(evaluatePredicateTruth({ flag: 1 }, Predicate.isTrue("flag"))).toBeNull()
    expect(evaluatePredicate({ id: "100" }, Predicate.not(Predicate.eq("id", 100)))).toBe(false)
  })

  it("accepts only strict RFC 3339 strings when comparing with instants", () => {
    const at = new Date("2026-01-02T00:00:00.000Z")
    expect(evaluatePredicate({ at }, Predicate.eq("at", "2026-01-02"))).toBe(true)
    expect(evaluatePredicate({ at }, Predicate.eq("at", "2026-01-02T01:00:00+01:00"))).toBe(true)
    expect(evaluatePredicate({ at }, Predicate.gt("at", "2026-01-01T23:59:59.999999999Z"))).toBe(true)
    for (const lenient of ["1", "Jan 2 2026", "2026-1-2", "2026-02-30", "2026-01-02T24:00:00Z", "2026-01-02T00:00:00+24:00", "2026-01-02T00:00:00"]) {
      expect(evaluatePredicateTruth({ at }, Predicate.eq("at", lenient)), lenient).toBeNull()
    }
    expect(evaluatePredicateTruth({ at: new Date("invalid") }, Predicate.eq("at", "2026-01-02"))).toBeNull()
  })

  it("orders strings by Unicode code point, not UTF-16 unit or locale", () => {
    expect(compareCodePoints("😀", "￿")).toBe(1)
    expect(compareCodePoints("B", "a")).toBe(-1)
    expect(compareCodePoints("ab", "abc")).toBe(-1)
    expect(compareCodePoints("abc", "ab")).toBe(1)
    expect(compareCodePoints("😀a", "😀b")).toBe(-1)
    expect(compareCodePoints("same", "same")).toBe(0)
  })

  it("reads only own fields; inherited properties are missing", () => {
    expect(evaluatePredicate({}, Predicate.isNull("constructor"))).toBe(true)
    expect(evaluatePredicate({}, Predicate.isNotNull("toString"))).toBe(false)
  })

  it("rejects pathologically deep trees instead of overflowing the stack", () => {
    const chain = (count: number): PredicateNode => {
      let node: PredicateNode = Predicate.eq("x", 1)
      for (let index = 0; index < count; index++) node = Predicate.not(node)
      return node
    }
    expect(MAX_PREDICATE_EVALUATION_DEPTH % 2).toBe(0)
    expect(evaluatePredicate({ x: 1 }, chain(MAX_PREDICATE_EVALUATION_DEPTH))).toBe(true)
    expect(() => evaluatePredicate({ x: 1 }, chain(MAX_PREDICATE_EVALUATION_DEPTH + 1))).toThrow(ValidationError)
  })

  it("satisfies Kleene algebra over generated predicates and records", () => {
    const { node, record } = generator(0x2026_1007)
    for (let iteration = 0; iteration < 5000; iteration++) {
      const p = node(); const q = node(); const row = record()
      const tp = evaluatePredicateTruth(row, p)
      const tq = evaluatePredicateTruth(row, q)
      const negate = (truth: boolean | null) => (truth === null ? null : !truth)
      expect(evaluatePredicateTruth(row, Predicate.not(p))).toBe(negate(tp))
      expect(evaluatePredicateTruth(row, Predicate.not(Predicate.not(p)))).toBe(tp)
      expect(evaluatePredicateTruth(row, Predicate.not(Predicate.and(p, q)))).toBe(evaluatePredicateTruth(row, Predicate.or(Predicate.not(p), Predicate.not(q))))
      expect(evaluatePredicateTruth(row, Predicate.not(Predicate.or(p, q)))).toBe(evaluatePredicateTruth(row, Predicate.and(Predicate.not(p), Predicate.not(q))))
      expect(evaluatePredicateTruth(row, Predicate.and(p, q))).toBe(evaluatePredicateTruth(row, Predicate.and(q, p)))
      expect(evaluatePredicate(row, p) && evaluatePredicate(row, Predicate.not(p))).toBe(false)
    }
  })
})
