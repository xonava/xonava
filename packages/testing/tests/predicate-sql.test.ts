import { describe, it, expect } from "vitest"
import { Predicate, evaluatePredicate } from "core/domain"

describe("JavaScript predicate evaluation", () => {
  const record = {
    id: "1",
    name: "John",
    age: 30,
    status: "active",
    score: 95.5,
    tags: ["vip", "returning"],
    createdAt: "2026-01-15T00:00:00.000Z",
    deletedAt: null,
  }

  it("eq matches string value", () => {
    expect(evaluatePredicate(record, Predicate.eq("status", "active"))).toBe(true)
    expect(evaluatePredicate(record, Predicate.eq("status", "inactive"))).toBe(false)
  })

  it("eq matches number value", () => {
    expect(evaluatePredicate(record, Predicate.eq("age", 30))).toBe(true)
    expect(evaluatePredicate(record, Predicate.eq("age", 31))).toBe(false)
  })

  it("neq does not match", () => {
    expect(evaluatePredicate(record, Predicate.neq("status", "inactive"))).toBe(true)
    expect(evaluatePredicate(record, Predicate.neq("status", "active"))).toBe(false)
  })

  it("neq handles null correctly", () => {
    // null should not equal null — but neq(null, null) should also be false
    expect(evaluatePredicate(record, Predicate.neq("deletedAt", null))).toBe(false)
  })

  it("in matches array membership", () => {
    expect(evaluatePredicate(record, Predicate.in("status", ["active", "pending"]))).toBe(true)
    expect(evaluatePredicate(record, Predicate.in("status", ["inactive"]))).toBe(false)
  })

  it("contains matches substring", () => {
    expect(evaluatePredicate(record, Predicate.contains("name", "Joh"))).toBe(true)
    expect(evaluatePredicate(record, Predicate.contains("name", "Jane"))).toBe(false)
  })

  it("gt/lt compare numbers", () => {
    expect(evaluatePredicate(record, Predicate.gt("age", 20))).toBe(true)
    expect(evaluatePredicate(record, Predicate.lt("age", 40))).toBe(true)
    expect(evaluatePredicate(record, Predicate.gt("age", 30))).toBe(false)
    expect(evaluatePredicate(record, Predicate.lt("age", 30))).toBe(false)
  })

  it("and/or compose correctly", () => {
    const p1 = Predicate.eq("status", "active")
    const p2 = Predicate.gt("age", 18)
    expect(evaluatePredicate(record, Predicate.and(p1, p2))).toBe(true)
    expect(evaluatePredicate(record, Predicate.and(p1, Predicate.eq("status", "inactive")))).toBe(false)
    expect(evaluatePredicate(record, Predicate.or(p1, Predicate.eq("status", "inactive")))).toBe(true)
  })

  it("alwaysTrue/alwaysFalse", () => {
    expect(evaluatePredicate(record, Predicate.alwaysTrue())).toBe(true)
    expect(evaluatePredicate(record, Predicate.alwaysFalse())).toBe(false)
  })

  it("not inverts", () => {
    expect(evaluatePredicate(record, Predicate.not(Predicate.eq("status", "inactive")))).toBe(true)
    expect(evaluatePredicate(record, Predicate.not(Predicate.eq("status", "active")))).toBe(false)
  })

  it("handles null values correctly", () => {
    // null != any value
    expect(evaluatePredicate(record, Predicate.eq("deletedAt", null))).toBe(true)
    // Checking for null specifically
    expect(evaluatePredicate(record, Predicate.isNull("deletedAt"))).toBe(true)
  })
})
