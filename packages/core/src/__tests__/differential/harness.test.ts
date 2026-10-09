import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
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

  describe("success reports (DIFFERENTIAL_REPORT_DIR)", () => {
    let directory: string | undefined
    afterEach(() => {
      vi.unstubAllEnvs()
      if (directory) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    })

    it("appends one line per passing property with the seed, scale, and runs it used", async () => {
      directory = mkdtempSync(join(tmpdir(), "differential-report-"))
      vi.stubEnv("DIFFERENTIAL_REPORT_DIR", directory)
      vi.stubEnv("DIFFERENTIAL_SEED", "77")
      vi.stubEnv("DIFFERENTIAL_SCALE", "2")
      forAll("reported sync", (rng) => rng.int(10), () => undefined, { runs: 30 })
      await forAllAsync("reported async", (rng) => rng.int(10), async () => undefined, { runs: 20 })
      expect(() => forAll("unreported failure", (rng) => rng.int(10), () => { throw new Error("no") }, { runs: 5 })).toThrow("no")
      const files = readdirSync(directory)
      expect(files).toHaveLength(1)
      const lines = readFileSync(join(directory, files[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(lines.map(({ recordedAt: _recordedAt, ...rest }) => rest)).toEqual([
        { property: "reported sync", seed: 77, scale: 2, baseRuns: 30, runs: 60, replayRun: null, passed: true },
        { property: "reported async", seed: 77, scale: 2, baseRuns: 20, runs: 40, replayRun: null, passed: true },
      ])
    })

    it("writes nothing when the directory is not configured", () => {
      directory = mkdtempSync(join(tmpdir(), "differential-report-"))
      vi.stubEnv("DIFFERENTIAL_REPORT_DIR", "")
      forAll("quiet", (rng) => rng.int(10), () => undefined, { runs: 5 })
      expect(readdirSync(directory)).toEqual([])
    })
  })
})
