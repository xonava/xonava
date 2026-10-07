import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { evaluatePredicate, evaluatePredicateTruth } from "../../core/src/domain/evaluatePredicate"
import type { PredicateNode } from "../../core/src/domain/predicate"
import { loadConformanceVectors } from "../src/spec/conformanceVectors"

const vectorsDir = join(import.meta.dirname, "..", "conformance", "vectors")

/** Decodes the vector tags for values JSON cannot express. */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if (Object.keys(record).length === 1 && record.$nan === true) return Number.NaN
  if (Object.keys(record).length === 1 && typeof record.$date === "string") return new Date(record.$date)
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decode(item)]))
}

describe("predicate-semantics conformance vectors", () => {
  const vectors = loadConformanceVectors(vectorsDir)
    .filter((suite) => suite.suiteId === "predicate-semantics")
    .flatMap((suite) => suite.vectors)

  it("publishes a substantial language-neutral suite", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(80)
    for (const vector of vectors) expect(["true", "false", "unknown"]).toContain(vector.expected)
  })

  it.each(vectors.map((vector) => [vector.id, vector] as const))("%s", (_id, vector) => {
    const input = vector.input as { record: Record<string, unknown>; predicate: PredicateNode }
    const record = decode(input.record) as Record<string, unknown>
    const predicate = decode(input.predicate) as PredicateNode
    const truth = evaluatePredicateTruth(record, predicate)
    expect(truth === null ? "unknown" : String(truth)).toBe(vector.expected)
    expect(evaluatePredicate(record, predicate)).toBe(vector.expected === "true")
  })
})
