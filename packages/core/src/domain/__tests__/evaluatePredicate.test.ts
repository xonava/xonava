import { describe, expect, it } from "vitest"
import { evaluatePredicate } from "../evaluatePredicate"
import { Predicate } from "../predicate"

describe("evaluatePredicate", () => {
  const cases = [
    ["eq", { status: "active" }, Predicate.eq("status", "active"), true],
    ["neq", { status: "active" }, Predicate.neq("status", "inactive"), true],
    ["contains", { name: "Ada Lovelace" }, Predicate.contains("name", "Lovelace"), true],
    ["startsWith", { name: "Ada Lovelace" }, Predicate.startsWith("name", "Ada"), true],
    ["endsWith", { name: "Ada Lovelace" }, Predicate.endsWith("name", "Lovelace"), true],
    ["isEmpty", { tags: [] }, Predicate.isEmpty("tags"), true],
    ["isNotEmpty", { tags: ["urgent"] }, Predicate.isNotEmpty("tags"), true],
    ["gt", { age: 42 }, Predicate.gt("age", 18), true],
    ["lt", { age: 18 }, Predicate.lt("age", 42), true],
    ["gte", { age: 42 }, Predicate.gte("age", 42), true],
    ["lte", { age: 42 }, Predicate.lte("age", 42), true],
    ["isTrue", { enabled: true }, Predicate.isTrue("enabled"), true],
    ["isFalse", { enabled: false }, Predicate.isFalse("enabled"), true],
    ["isNull", { deletedAt: null }, Predicate.isNull("deletedAt"), true],
    ["isNotNull", { deletedAt: "2026-01-01" }, Predicate.isNotNull("deletedAt"), true],
    ["in scalar", { role: "doctor" }, Predicate.in("role", ["nurse", "doctor"]), true],
    ["in array", { roles: ["doctor", "admin"] }, Predicate.in("roles", ["admin"]), false],
    ["between inclusive", { score: 50 }, Predicate.between("score", [50, 75]), true],
    ["between open lower bound", { score: 75 }, Predicate.between("score", { to: 75 }), true],
    ["date comparison", { createdAt: new Date("2026-01-02") }, Predicate.gt("createdAt", new Date("2026-01-01")), true],
  ] as const

  it.each(cases)("evaluates %s", (_name, record, predicate, expected) => {
    expect(evaluatePredicate(record, predicate)).toBe(expected)
  })

  it.each([
    ["missing equality", { status: undefined }, Predicate.eq("status", "active")],
    ["wrong type for contains", { age: 42 }, Predicate.contains("age", "4")],
    ["and short circuit result", { status: "active" }, Predicate.and(Predicate.eq("status", "active"), Predicate.isTrue("missing"))],
    ["or no matching branch", { status: "active" }, Predicate.or(Predicate.eq("status", "inactive"), Predicate.isTrue("missing"))],
  ])("returns false for %s", (_name, record, predicate) => {
    expect(evaluatePredicate(record, predicate)).toBe(false)
  })

  it("supports negation and empty group identities", () => {
    expect(evaluatePredicate({ status: "active" }, Predicate.not(Predicate.eq("status", "inactive")))).toBe(true)
    expect(evaluatePredicate({}, Predicate.alwaysTrue())).toBe(true)
    expect(evaluatePredicate({}, Predicate.alwaysFalse())).toBe(false)
  })

  it("fails closed for an empty between range", () => {
    expect(Predicate.between("score", {})).toMatchObject({ kind: "condition", op: "between", value: {} })
    expect(evaluatePredicate({ score: 50 }, { kind: "condition", field: "score", op: "between", value: {} })).toBe(false)
  })

  it("evaluates false and alternate condition branches", () => {
    const cases: Array<[Record<string, unknown>, ReturnType<typeof Predicate.eq>]> = [
      [{ value: "x" }, Predicate.eq("value", "y")],
      [{ value: "y" }, Predicate.neq("value", "y")],
      [{ tags: ["x"] }, Predicate.isEmpty("tags")],
      [{ tags: [] }, Predicate.isNotEmpty("tags")],
      [{ value: 1 }, Predicate.contains("value", "x")],
      [{ value: 1 }, Predicate.gt("value", 2)],
      [{ value: 3 }, Predicate.lt("value", 2)],
      [{ value: 1 }, Predicate.gte("value", 2)],
      [{ value: 3 }, Predicate.lte("value", 2)],
      [{ enabled: false }, Predicate.isTrue("enabled")],
      [{ enabled: true }, Predicate.isFalse("enabled")],
      [{ deletedAt: "set" }, Predicate.isNull("deletedAt")],
      [{ deletedAt: null }, Predicate.isNotNull("deletedAt")],
      [{ roles: ["nurse"] }, Predicate.in("roles", ["doctor"])],
      [{ score: 10 }, Predicate.between("score", { from: 20 })],
      [{ score: 10 }, Predicate.between("score", { to: 5 })],
    ]
    for (const [record, predicate] of cases) expect(evaluatePredicate(record, predicate)).toBe(false)
    expect(evaluatePredicate({ value: {} }, Predicate.gt("value", 1))).toBe(false)
    expect(evaluatePredicate({ value: true }, Predicate.gt("value", false))).toBe(true)
    expect(evaluatePredicate({ value: false }, Predicate.gt("value", true))).toBe(false)
    expect(evaluatePredicate({ value: "x" }, Predicate.contains("value", "z"))).toBe(false)
    expect(evaluatePredicate({ value: "x" }, Predicate.startsWith("value", "z"))).toBe(false)
    expect(evaluatePredicate({ value: "x" }, Predicate.endsWith("value", "z"))).toBe(false)
    expect(evaluatePredicate({ value: "x" }, Predicate.isEmpty("value"))).toBe(false)
    expect(evaluatePredicate({ value: "" }, Predicate.isNotEmpty("value"))).toBe(false)
    expect(evaluatePredicate({ score: 1 }, Predicate.between("score", { from: {} as never }))).toBe(false)
    expect(evaluatePredicate({ score: 1 }, Predicate.between("score", { to: {} as never }))).toBe(false)
    expect(evaluatePredicate({}, { kind: "condition", field: "x", op: "between", value: [] } as never)).toBe(false)
    expect(evaluatePredicate({}, { kind: "unknown" } as never)).toBe(false)
  })

  it("evaluates literals and treats missing values like SQL nulls", () => {
    expect(evaluatePredicate({}, Predicate.literal(true))).toBe(true)
    expect(evaluatePredicate({}, Predicate.literal(false))).toBe(false)
    expect(evaluatePredicate({}, Predicate.eq("value", null))).toBe(true)
    expect(evaluatePredicate({}, Predicate.neq("value", "set"))).toBe(false)
    expect(evaluatePredicate({}, Predicate.in("value", [null, "set"]))).toBe(false)
    expect(evaluatePredicate({ value: "set" }, Predicate.in("value", [null, "set"]))).toBe(true)
  })

  it("separates scalar membership from array overlap and containment", () => {
    expect(evaluatePredicate({ role: "doctor" }, Predicate.in("role", ["admin", "doctor"]))).toBe(true)
    expect(evaluatePredicate({ roles: ["admin", "doctor"] }, Predicate.in("roles", ["doctor"]))).toBe(false)
    expect(evaluatePredicate({ roles: ["admin", "doctor"] }, Predicate.includesAny("roles", ["doctor"]))).toBe(true)
    expect(evaluatePredicate({ roles: ["admin", "doctor"] }, Predicate.includesAll("roles", ["admin", "doctor"]))).toBe(true)
  })

  it("does not turn nullable comparisons into true through NOT", () => {
    expect(evaluatePredicate({}, Predicate.not(Predicate.eq("status", "active")))).toBe(false)
    expect(evaluatePredicate({}, Predicate.not(Predicate.neq("status", "active")))).toBe(false)
  })
})
