// Hot-path benchmark gate (Quality gates, "Performance"): runs the vitest 5 bench suites (benchmarks are tests using the `bench` fixture; results come from the json reporter) of every package and compares the median
// time of each benchmark with benchmarks/baseline.json. A benchmark more than 25 % slower than its baseline fails the gate.
//
//   npm run bench                         run all suites and compare
//   npm run bench:update-baseline         run every suite 3 times and rewrite the baseline (review the diff)
//   node scripts/verification/verifyBenchmarks.mjs --threshold 0.4 --results <dir>
//
// Noise: this machine is shared. The statistic is the median (robust to outlier samples); a benchmark that exceeds the threshold
// is re-measured once (its whole file is re-run) and the faster of the two medians counts. The baseline is the median of three
// runs. A baseline recorded on another machine is not comparable: the script warns when the CPU or Node major differs.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DEFAULT_REGRESSION_THRESHOLD, bestOf, combineRuns, compareToBaseline, flattenBenchReport } from "./benchmarkComparison.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const baselinePath = path.join(root, "benchmarks", "baseline.json")
const SUITES = [
  { name: "@xonava/core", dir: "packages/core" },
  { name: "@xonava/adapters", dir: "packages/adapters" },
  { name: "@xonava/testing", dir: "packages/testing" },
]
const BASELINE_RUNS = 3

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const threshold = option("--threshold") === undefined ? DEFAULT_REGRESSION_THRESHOLD : Number(option("--threshold"))
if (!Number.isFinite(threshold) || threshold <= 0) { console.error("--threshold must be a positive fraction, for example 0.25"); process.exit(2) }

const scratch = mkdtempSync(path.join(os.tmpdir(), "xonava-bench-"))
let invocation = 0
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }))

/** Runs one package's bench suite (optionally only some files) and returns its flattened results. */
function runSuite(suite, files = []) {
  invocation += 1
  const output = path.join(scratch, `bench-${invocation}.json`)
  const command = process.platform === "win32" ? "npm.cmd" : "npm"
  const result = spawnSync(command, ["run", "bench", "-w", suite.name, "--", "--reporter=default", "--reporter=json", `--outputFile.json=${output}`, ...files], { cwd: root, stdio: "inherit", shell: process.platform === "win32" })
  if (result.status !== 0 || !existsSync(output)) { console.error(`benchmark run failed for ${suite.name} (exit ${result.status})`); process.exit(1) }
  return flattenBenchReport(JSON.parse(readFileSync(output, "utf8")), suite.name, path.join(root, suite.dir))
}

function readResultsDirectory(directory) {
  const measured = {}
  for (const suite of SUITES) {
    const file = path.join(directory, `${suite.dir.split("/").pop()}.json`)
    Object.assign(measured, flattenBenchReport(JSON.parse(readFileSync(file, "utf8")), suite.name, path.join(root, suite.dir)))
  }
  return measured
}

function runAll() {
  const measured = {}
  for (const suite of SUITES) Object.assign(measured, runSuite(suite))
  return measured
}

function environment() {
  const cpus = os.cpus()
  return { node: process.version, platform: `${process.platform}-${process.arch}`, cpu: cpus[0]?.model ?? "unknown", cpuCount: cpus.length, loadAverage1m: Number(os.loadavg()[0].toFixed(2)) }
}

const format = (ms) => ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(2)} us`

if (flag("--update-baseline")) {
  const runs = []
  for (let run = 1; run <= BASELINE_RUNS; run += 1) { console.log(`\n== baseline run ${run}/${BASELINE_RUNS} ==`); runs.push(runAll()) }
  const benchmarks = combineRuns(runs)
  const broken = Object.entries(benchmarks).filter(([, entry]) => entry.error !== undefined)
  if (broken.length > 0) { for (const [key, entry] of broken) console.error(`FAIL ${key}: ${entry.error}`); process.exit(1) }
  mkdirSync(path.dirname(baselinePath), { recursive: true })
  writeFileSync(baselinePath, JSON.stringify({
    note: "Median time per operation (ms) of each hot-path benchmark, the median of 3 runs. Regenerate with `npm run bench:update-baseline` after an intentional performance change and review the diff. Numbers are only comparable on a similar machine; the gate allows a 25 % regression.",
    statistic: "median of per-run medians, milliseconds per operation",
    thresholdFraction: DEFAULT_REGRESSION_THRESHOLD,
    recordedAt: new Date().toISOString(),
    environment: environment(),
    benchmarks,
  }, null, 2) + "\n")
  console.log(`\nwrote ${path.relative(root, baselinePath)} (${Object.keys(benchmarks).length} benchmarks)`)
  process.exit(0)
}

if (!existsSync(baselinePath)) { console.error("benchmarks/baseline.json is missing; run npm run bench:update-baseline"); process.exit(1) }
const baselineFile = JSON.parse(readFileSync(baselinePath, "utf8"))
const here = environment()
const recorded = baselineFile.environment ?? {}
if (recorded.cpu !== here.cpu || String(recorded.node).split(".")[0] !== here.node.split(".")[0]) {
  console.warn(`warning: the baseline was recorded on "${recorded.cpu}" with Node ${recorded.node}; this machine is "${here.cpu}" with Node ${here.node}. Regressions may be machine differences: re-record with npm run bench:update-baseline if so.`)
}
if (here.loadAverage1m > here.cpuCount) console.warn(`warning: 1-minute load average ${here.loadAverage1m} exceeds ${here.cpuCount} CPUs; timings are noisy and a failing benchmark is re-measured once.`)

const resultsDirectory = option("--results")
let measured = resultsDirectory === undefined ? runAll() : readResultsDirectory(path.resolve(resultsDirectory))
let comparison = compareToBaseline(baselineFile.benchmarks, measured, threshold)

if (comparison.regressions.length > 0 && resultsDirectory === undefined) {
  console.log(`\n${comparison.regressions.length} benchmark(s) exceed the ${threshold * 100} % threshold; re-measuring once (the faster median counts).`)
  for (const suite of SUITES) {
    const files = [...new Set(comparison.regressions.filter((row) => row.key.startsWith(`${suite.name} > `)).map((row) => row.file))]
    if (files.length > 0) measured = bestOf(measured, runSuite(suite, files))
  }
  comparison = compareToBaseline(baselineFile.benchmarks, measured, threshold)
}

console.log(`\nBenchmark comparison (median per operation, threshold +${threshold * 100} %)`)
for (const row of [...comparison.ok, ...comparison.improvements, ...comparison.regressions].sort((a, b) => a.key.localeCompare(b.key))) {
  const mark = comparison.regressions.includes(row) ? "FAIL" : comparison.improvements.includes(row) ? "fast" : "ok  "
  console.log(`${mark} ${(row.change * 100 >= 0 ? "+" : "") + (row.change * 100).toFixed(1)}%  ${format(row.baselineMs)} -> ${format(row.measuredMs)}  ${row.key}`)
}
for (const error of comparison.errors) console.error(`FAIL ${error.key}: ${error.reason}`)
if (comparison.improvements.length > 0) console.log(`\n${comparison.improvements.length} benchmark(s) are more than ${threshold * 100} % faster than the baseline; consider re-recording it.`)
if (comparison.regressions.length > 0 || comparison.errors.length > 0) {
  console.error(`\nbenchmark gate failed: ${comparison.regressions.length} regression(s), ${comparison.errors.length} error(s)`)
  process.exit(1)
}
console.log(`\nbenchmark gate passed: ${comparison.ok.length + comparison.improvements.length} benchmark(s) within ${threshold * 100} % of the baseline`)
