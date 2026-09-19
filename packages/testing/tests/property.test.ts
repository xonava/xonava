import { describe, expect, it } from "vitest"
import { Predicate, evaluatePredicate } from "core/domain"

describe("release property harness", () => {
  it("is deterministic across seeded generated predicate cases", () => {
    const generate = (initialSeed: number) => {
      let seed = initialSeed
      const next = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0
        return seed
      }
      return Array.from({ length: 128 }, (_, index) => {
        const raw = next() % 4
        const value = raw === 0 ? null : raw === 1 ? next() % 1000 : raw === 2 ? `value-${next() % 100}` : next() % 2 === 0
        return { index, value }
      })
    }
    const cases = generate(0x5eed1234)
    expect(cases).toEqual(generate(0x5eed1234))
    for (const { value } of cases) expect(evaluatePredicate({ value }, Predicate.eq("value", value))).toBe(true)
  })
})
