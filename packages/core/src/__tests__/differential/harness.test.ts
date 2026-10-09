import { describe, expect, it } from "vitest"
import { createRng, forAll, forAllAsync } from "./harness"
import { generatePredicate, generateRecord, shrinkPredicate } from "./arbitraries"
import { evaluatePredicateTruth } from "../../domain/evaluatePredicate"
import type { PredicateNode } from "../../domain/predicate"

describe("differential harness", () => {
  it("is deterministic for a seed", () => {
    const a = createRng(42)
    const b = createRng(42)
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(Array.from({ length: 20 }, () => b.next()))
  })

  it("reports a replayable, shrunk counterexample", () => {
    const depth = (node: PredicateNode): number =>
      node.kind === "not" ? 1 + depth(node.filter) : node.kind === "and" || node.kind === "or" ? 1 + Math.max(0, ...node.filters.map(depth)) : 0
    let message = ""
    try {
      forAll("planted: no negation anywhere", (rng) => generatePredicate(rng), (node) => {
        if (JSON.stringify(node).includes("\"not\"")) throw new Error("found a negation")
      }, { runs: 200, shrink: shrinkPredicate })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("DIFFERENTIAL_SEED=")
    expect(message).toContain("DIFFERENTIAL_RUN=")
    const shrunk = JSON.parse(message.split("Case: ")[1]!.split("\nReason:")[0]!) as PredicateNode
    expect(shrunk.kind).toBe("not")
    expect(depth(shrunk)).toBeLessThanOrEqual(1)
  })

  it("generates records and predicates that actually exercise all three truth values", () => {
    const seen = new Set<boolean | null>()
    forAll("truth coverage", (rng) => ({ node: generatePredicate(rng), record: generateRecord(rng) }), ({ node, record }) => {
      seen.add(evaluatePredicateTruth(record, node))
    }, { runs: 300 })
    expect([...seen].sort()).toEqual([false, null, true].sort())
  })

  it("supports async properties", async () => {
    await expect(forAllAsync("async planted", (rng) => rng.int(10), async (value) => { if (value === 3) throw new Error("three") }, { runs: 200 })).rejects.toThrow("three")
  })
})
