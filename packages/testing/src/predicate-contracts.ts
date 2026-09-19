import { describe, it, expect } from "vitest"
import { Predicate, evaluatePredicate } from "core/domain"

export function runPredicateContractTests(label: string): void {
  describe(`Predicate contract: ${label}`, () => {
    it("eq operator produces same results in JS and SQL", () => {
      const record = { name: "alice" }
      const node = Predicate.eq("name", "alice")
      expect(evaluatePredicate(record, node)).toBe(true)

      const mismatch = Predicate.eq("name", "bob")
      expect(evaluatePredicate(record, mismatch)).toBe(false)
    })

    it("neq operator", () => {
      const record = { role: "admin" }
      expect(evaluatePredicate(record, Predicate.neq("role", "user"))).toBe(true)
      expect(evaluatePredicate(record, Predicate.neq("role", "admin"))).toBe(false)
    })

    it("contains (string matching)", () => {
      const record = { email: "alice@example.com" }
      expect(evaluatePredicate(record, Predicate.contains("email", "example"))).toBe(true)
      expect(evaluatePredicate(record, Predicate.contains("email", "test"))).toBe(false)
    })

    it("gt / lt (numeric comparison)", () => {
      const record = { age: 30 }
      expect(evaluatePredicate(record, Predicate.gt("age", 20))).toBe(true)
      expect(evaluatePredicate(record, Predicate.gt("age", 30))).toBe(false)
      expect(evaluatePredicate(record, Predicate.gte("age", 30))).toBe(true)
      expect(evaluatePredicate(record, Predicate.lt("age", 40))).toBe(true)
      expect(evaluatePredicate(record, Predicate.lt("age", 30))).toBe(false)
      expect(evaluatePredicate(record, Predicate.lte("age", 30))).toBe(true)
    })

    it("in (array membership)", () => {
      const record = { status: "active" }
      expect(evaluatePredicate(record, Predicate.in("status", ["active", "pending"]))).toBe(true)
      expect(evaluatePredicate(record, Predicate.in("status", ["inactive"]))).toBe(false)
      expect(evaluatePredicate({ status: null }, Predicate.in("status", [null, "active"]))).toBe(false)
      expect(evaluatePredicate(record, Predicate.in("status", [null, "active"]))).toBe(true)
    })

    it("isEmpty / isNotEmpty treat null and empty strings like SQL", () => {
      expect(evaluatePredicate({ value: null }, Predicate.isEmpty("value"))).toBe(true)
      expect(evaluatePredicate({ value: "" }, Predicate.isEmpty("value"))).toBe(true)
      expect(evaluatePredicate({ value: "set" }, Predicate.isEmpty("value"))).toBe(false)
      expect(evaluatePredicate({ value: null }, Predicate.isNotEmpty("value"))).toBe(false)
      expect(evaluatePredicate({ value: "set" }, Predicate.isNotEmpty("value"))).toBe(true)
    })

    it("and / or composition", () => {
      const record = { age: 25, role: "editor" }
      const both = Predicate.and(
        Predicate.gte("age", 18),
        Predicate.eq("role", "editor"),
      )
      expect(evaluatePredicate(record, both)).toBe(true)

      const either = Predicate.or(
        Predicate.eq("role", "admin"),
        Predicate.eq("role", "editor"),
      )
      expect(evaluatePredicate(record, either)).toBe(true)

      const neither = Predicate.and(
        Predicate.eq("role", "admin"),
        Predicate.gt("age", 30),
      )
      expect(evaluatePredicate(record, neither)).toBe(false)
    })

    it("Null handling: null !== any value", () => {
      const record = { name: null }
      expect(evaluatePredicate(record, Predicate.eq("name", null))).toBe(true)
      expect(evaluatePredicate(record, Predicate.neq("name", null))).toBe(false)
      expect(evaluatePredicate(record, Predicate.eq("name", "alice"))).toBe(false)
    })

    it("Date comparison consistency", () => {
      const d1 = new Date("2024-01-01")
      const d2 = new Date("2024-06-15")
      const d3 = new Date("2024-12-31")
      const record = { created: d2 }

      expect(evaluatePredicate(record, Predicate.gt("created", d1))).toBe(true)
      expect(evaluatePredicate(record, Predicate.lt("created", d3))).toBe(true)
      expect(evaluatePredicate(record, Predicate.eq("created", d2))).toBe(true)
    })

    it("Number/string equality: '100' !== 100", () => {
      const record = { val: "100" }
      expect(evaluatePredicate(record, Predicate.eq("val", 100))).toBe(false)
      expect(evaluatePredicate(record, Predicate.eq("val", "100"))).toBe(true)
    })
  })
}
