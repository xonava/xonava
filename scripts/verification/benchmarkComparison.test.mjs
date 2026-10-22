import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { bestOf, combineRuns, compareToBaseline, flattenBenchReport, medianOf } from "./benchmarkComparison.mjs"

const stat = (medianMs, extra = {}) => ({ medianMs, meanMs: medianMs * 1.1, rmePercent: 2, samples: 1000, file: "src/__tests__/bench/a.bench.ts", ...extra })

describe("flattenBenchReport", () => {
  const report = {
    files: [{
      filepath: "/repo/packages/core/src/__tests__/bench/a.bench.ts",
      groups: [{
        fullName: "src/__tests__/bench/a.bench.ts > suite > nested",
        benchmarks: [
          { name: "fast", median: 0.002, mean: 0.0025, rme: 3, sampleCount: 500 },
          { name: "threw", rank: 1, samples: [], median: undefined, sampleCount: undefined },
        ],
      }],
    }],
  }

  it("keys results by package, package-relative file, describe path and benchmark name", () => {
    const flat = flattenBenchReport(report, "@xonava/core", "/repo/packages/core")
    assert.deepEqual(flat["@xonava/core > src/__tests__/bench/a.bench.ts > suite > nested > fast"], { medianMs: 0.002, meanMs: 0.0025, rmePercent: 3, samples: 500, file: "src/__tests__/bench/a.bench.ts" })
  })

  it("records a benchmark without samples as an error instead of dropping it", () => {
    const flat = flattenBenchReport(report, "@xonava/core", "/repo/packages/core")
    assert.match(flat["@xonava/core > src/__tests__/bench/a.bench.ts > suite > nested > threw"].error, /no samples/)
  })
})

describe("compareToBaseline", () => {
  const baseline = { a: stat(1), b: stat(1), c: stat(1) }

  it("passes at exactly the threshold and fails just above it", () => {
    const result = compareToBaseline(baseline, { a: stat(1.25), b: stat(1.2501), c: stat(1) }, 0.25)
    assert.deepEqual(result.regressions.map((row) => row.key), ["b"])
    assert.deepEqual(result.ok.map((row) => row.key).sort(), ["a", "c"])
    assert.equal(result.errors.length, 0)
  })

  it("reports a large speed-up as an improvement, not a failure", () => {
    const result = compareToBaseline({ a: stat(1) }, { a: stat(0.5) }, 0.25)
    assert.equal(result.improvements.length, 1)
    assert.equal(result.regressions.length, 0)
  })

  it("flags a missing, errored and unrecorded benchmark", () => {
    const result = compareToBaseline({ a: stat(1), b: stat(1) }, { b: { error: "no samples" }, extra: stat(1) }, 0.25)
    assert.deepEqual(result.errors.map((error) => error.key).sort(), ["a", "b", "extra"])
  })

  it("fails an artificially slowed benchmark (3x) and nothing else", () => {
    const result = compareToBaseline(baseline, { a: stat(3), b: stat(1.1), c: stat(0.9) }, 0.25)
    assert.deepEqual(result.regressions.map((row) => row.key), ["a"])
    assert.ok(result.regressions[0].change > 1.9)
  })
})

describe("noise handling", () => {
  it("medianOf handles odd and even counts", () => {
    assert.equal(medianOf([3, 1, 2]), 2)
    assert.equal(medianOf([4, 1, 3, 2]), 2.5)
  })

  it("combineRuns takes the median of the per-run medians, so one noisy run does not move the baseline", () => {
    const combined = combineRuns([{ a: stat(1) }, { a: stat(1.05) }, { a: stat(9) }])
    assert.equal(combined.a.medianMs, 1.05)
  })

  it("combineRuns keeps a benchmark that errored in any run as an error", () => {
    assert.ok(combineRuns([{ a: stat(1) }, { a: { error: "boom" } }]).a.error)
  })

  it("bestOf keeps the faster median on re-measurement and ignores an errored second measurement", () => {
    assert.equal(bestOf({ a: stat(2), b: stat(1) }, { a: stat(1.1), b: { error: "boom" } }).a.medianMs, 1.1)
    assert.equal(bestOf({ a: stat(2), b: stat(1) }, { a: stat(1.1), b: { error: "boom" } }).b.medianMs, 1)
    assert.equal(bestOf({ a: stat(1) }, { a: stat(2) }).a.medianMs, 1)
  })

  it("a transient slow window passes after re-measurement but a real regression does not", () => {
    const baseline = { noisy: stat(1), slow: stat(1) }
    const first = { noisy: stat(1.6), slow: stat(2) }
    const second = { noisy: stat(1.05), slow: stat(1.9) }
    const result = compareToBaseline(baseline, bestOf(first, second), 0.25)
    assert.deepEqual(result.regressions.map((row) => row.key), ["slow"])
  })
})
