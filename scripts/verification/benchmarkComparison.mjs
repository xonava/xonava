// Pure helpers for verifyBenchmarks.mjs: flatten vitest 5 bench JSON reporter output, pick a stable statistic, and compare with a baseline.
//
// The statistic is the MEDIAN time per operation (milliseconds) of the samples one benchmark collected. The median ignores the
// long tail of samples that landed on a descheduled or garbage-collecting thread, which is what makes a loaded shared machine
// noisy; the mean (and `hz`, which is 1 / mean) does not.

export const DEFAULT_REGRESSION_THRESHOLD = 0.25

/** @typedef {{ medianMs: number, meanMs: number, rmePercent: number, samples: number }} BenchmarkStat */

/**
 * Flattens vitest 5 `vitest bench --reporter=json` output into `{ [key]: BenchmarkStat | { error } }`. Every benchmark runs inside
 * a test; the test result carries its `benchmarks` (named "<describe names> > <test name>") whose tasks hold the latency statistics
 * in milliseconds (`p50` is the median).
 * @param {{ testResults?: Array<{ name: string, assertionResults?: Array<{ status: string, fullName: string, benchmarks?: Array<{ name: string, tasks?: any[] }> }> }> }} report
 * @param {string} packageName
 * @param {string} packageDir absolute directory the vitest process ran in
 */
export function flattenBenchReport(report, packageName, packageDir) {
  const result = {}
  const dir = packageDir.replaceAll("\\", "/").replace(/\/$/, "") + "/"
  for (const file of report.testResults ?? []) {
    const filepath = file.name.replaceAll("\\", "/")
    const relativePath = filepath.startsWith(dir) ? filepath.slice(dir.length) : filepath
    for (const test of file.assertionResults ?? []) {
      const key = (name) => [packageName, relativePath, name].join(" > ")
      if (test.status !== "passed" || !test.benchmarks?.length) {
        // A benchmark that threw (or was skipped) never records a benchmark: keep it in the report as an error.
        result[key(test.ancestorTitles ? [...test.ancestorTitles, test.title].join(" > ") : test.fullName)] = { error: "the benchmark produced no samples (it threw, or never ran)", file: relativePath }
        continue
      }
      for (const benchmark of test.benchmarks) {
        for (const task of benchmark.tasks ?? []) {
          const median = task.latency?.p50
          const name = benchmark.tasks.length === 1 ? benchmark.name : `${benchmark.name} > ${task.name}`
          if (typeof median !== "number" || !Number.isFinite(median) || median <= 0 || !(task.latency.samplesCount > 0)) {
            result[key(name)] = { error: "the benchmark produced no samples (it threw, or never ran)", file: relativePath }
          } else {
            result[key(name)] = { medianMs: median, meanMs: task.latency.mean, rmePercent: task.latency.rme, samples: task.latency.samplesCount, file: relativePath }
          }
        }
      }
    }
  }
  return result
}

/** Median of several measurements of one benchmark (used to record a baseline from repeated runs). */
export function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Combines repeated runs into one baseline entry per benchmark: the median of the per-run medians. */
export function combineRuns(runs) {
  const keys = new Set(runs.flatMap((run) => Object.keys(run)))
  const combined = {}
  for (const key of [...keys].sort()) {
    const entries = runs.map((run) => run[key]).filter((entry) => entry !== undefined)
    const failed = entries.find((entry) => entry.error !== undefined)
    if (failed || entries.length !== runs.length) { combined[key] = failed ?? { error: "missing from a run" }; continue }
    combined[key] = {
      medianMs: medianOf(entries.map((entry) => entry.medianMs)),
      meanMs: medianOf(entries.map((entry) => entry.meanMs)),
      rmePercent: medianOf(entries.map((entry) => entry.rmePercent)),
      samples: Math.min(...entries.map((entry) => entry.samples)),
      file: entries[0].file,
    }
  }
  return combined
}

/**
 * Compares measured benchmarks with the baseline.
 * - `regressions`: slower than baseline by more than `threshold` (relative increase of the median).
 * - `errors`: a benchmark that produced no samples, one the baseline has but the run lacks, or one the baseline lacks.
 * - `improvements`: faster by more than `threshold` (informational: the baseline may be stale).
 * @returns {{ regressions: any[], errors: any[], improvements: any[], ok: any[] }}
 */
export function compareToBaseline(baseline, measured, threshold = DEFAULT_REGRESSION_THRESHOLD) {
  const regressions = []
  const errors = []
  const improvements = []
  const ok = []
  for (const [key, base] of Object.entries(baseline)) {
    const now = measured[key]
    if (now === undefined) { errors.push({ key, reason: "in the baseline but not measured (renamed or removed? run npm run bench:update-baseline)" }); continue }
    if (now.error !== undefined) { errors.push({ key, reason: now.error }); continue }
    const change = now.medianMs / base.medianMs - 1
    const row = { key, baselineMs: base.medianMs, measuredMs: now.medianMs, change, file: now.file ?? base.file }
    if (change > threshold) regressions.push(row)
    else if (change < -threshold) improvements.push(row)
    else ok.push(row)
  }
  for (const key of Object.keys(measured)) {
    if (baseline[key] === undefined) errors.push({ key, reason: "measured but not in the baseline (run npm run bench:update-baseline and review the diff)" })
  }
  return { regressions, errors, improvements, ok }
}

/** Re-measurement: keeps the faster median of two measurements of each benchmark, so one noisy window cannot fail the gate. */
export function bestOf(first, second) {
  const merged = { ...first }
  for (const [key, entry] of Object.entries(second)) {
    const previous = merged[key]
    if (previous === undefined || previous.error !== undefined || (entry.error === undefined && entry.medianMs < previous.medianMs)) merged[key] = entry
  }
  return merged
}
