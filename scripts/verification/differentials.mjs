/**
 * differential runner: runs every differential/property suite (core and the PostgreSQL,
 * MySQL, and D1 real-database parity suites) at elevated volume with a fresh
 * but recorded seed, then refuses unless every required
 * property reported success with that seed and scale.
 *
 * Environment:
 * - FRAMEWORK_CONFORMANCE_RUN_ID       run ID (default local-differential); names the run directory
 * - FRAMEWORK_DIFFERENTIAL_OUTPUT_DIR           output directory of a non-release run (default:
 *                                      <os tmpdir>/framework-differential-<run ID, or a random id>);
 *                                      ignored by release runs, which use .release-check/<run ID>/differentials
 * - DIFFERENTIAL_SEED                  explicit base seed; default derives from the run ID
 * - FRAMEWORK_DIFFERENTIAL_SCALE       core case multiplier (default 5)
 * - FRAMEWORK_DIFFERENTIAL_DB_SCALE    real-database case multiplier (default 2)
 * - FRAMEWORK_TEST_PG_URL / FRAMEWORK_TEST_MYSQL_URL  real databases (required)
 * - DIFFERENTIAL_SUITES                comma-separated suite IDs (core, http-fuzz, pg, mysql, d1) to run as one share of a
 *                                      parallel release check; default all. A share writes
 *                                      differential-conformance.partial-<ids>.json (not a complete artifact), needs only the
 *                                      URLs of the databases it runs, and the release check's summary step merges the shares.
 *
 * `--update-baseline` runs every suite, then rewrites differentialBaseline.json
 * from the observed per-site property counts instead of checking. Use it
 * only for a reviewed addition or removal of properties.
 */
import { spawn, execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DIFFERENTIAL_ARTIFACT,
  DIFFERENTIAL_BASELINE,
  DIFFERENTIAL_PARTIAL_PREFIX,
  DIFFERENTIAL_DEFAULT_SCALES,
  DIFFERENTIAL_MINIMUM_SCALES,
  DIFFERENTIAL_PHASE,
  DifferentialRefusal,
  aggregateSuiteReports,
  composeDifferentialArtifact,
  composeDifferentialBaseline,
  createDifferentialSourceManifest,
  deriveDifferentialSeed,
  differentialOutputDirectory,
  differentialSuites,
  parseScale,
  readDifferentialBaseline,
  readPropertyReports,
  requiredCallSites,
  suiteScale,
  suiteVitestArgs,
  validateDifferentialArtifact,
} from "./differentialSupport.mjs"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const startedAt = Date.now()

function refuse(message) {
  throw new DifferentialRefusal(message)
}

/** Runs npm, streaming output while keeping it for replay extraction. */
function npmStreaming(args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npm", args, { cwd: repositoryRoot, env, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" })
    let output = ""
    const keep = chunk => {
      output += chunk.toString("utf8")
      if (output.length > 4_000_000) output = output.slice(-2_000_000)
    }
    child.stdout.on("data", chunk => { process.stdout.write(chunk); keep(chunk) })
    child.stderr.on("data", chunk => { process.stderr.write(chunk); keep(chunk) })
    child.on("error", reject)
    child.on("close", code => resolvePromise({ code, output }))
  })
}

function failureReplays(output) {
  // Vitest may print a failure more than once; keep each property/run once.
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "")
  const found = new Map()
  for (const match of plain.matchAll(/Property "([^"\n]+)" failed \(run (\d+)[^\n]*\n\s*Replay: (DIFFERENTIAL_SEED=\d+ DIFFERENTIAL_RUN=\d+)/g)) {
    found.set(`${match[1]}\0${match[2]}`, { property: match[1], replay: match[3] })
  }
  return [...found.values()]
}

/** Test files Vitest marked as failed (relative to the suite's workspace). */
function failingFiles(output, suite) {
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "")
  const known = new Set(suiteVitestArgs(suite).filter(arg => arg.endsWith(".ts")))
  return [...new Set([...plain.matchAll(/FAIL\s+(\S+\.test\.ts)/g)].map(match => match[1]).filter(file => known.has(file)))]
}

async function main() {
  const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID ?? "local-differential"
  const releaseDirectory = resolve(repositoryRoot, ".release-check", runId, DIFFERENTIAL_PHASE)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) refuse("FRAMEWORK_CONFORMANCE_RUN_ID contains unsafe path characters")
  if (process.env.DIFFERENTIAL_RUN?.trim()) refuse("DIFFERENTIAL_RUN is set; single-case replay mode cannot run in a release check")
  const selected = process.env.DIFFERENTIAL_SUITES?.trim() ? process.env.DIFFERENTIAL_SUITES.split(",").map(id => id.trim()).filter(Boolean) : undefined
  if (selected && selected.length === 0) refuse("DIFFERENTIAL_SUITES names no suite")
  if (selected && process.argv.includes("--update-baseline")) refuse("--update-baseline needs every suite; do not set DIFFERENTIAL_SUITES")
  if ((!selected || selected.includes("pg")) && !process.env.FRAMEWORK_TEST_PG_URL?.trim() && !process.env.DATABASE_URL?.trim()) refuse("FRAMEWORK_TEST_PG_URL (or DATABASE_URL) is required for the PostgreSQL parity suite")
  if ((!selected || selected.includes("mysql")) && !process.env.FRAMEWORK_TEST_MYSQL_URL?.trim()) refuse("FRAMEWORK_TEST_MYSQL_URL is required for the MySQL parity suite")
  const updateBaseline = process.argv.includes("--update-baseline")
  const releaseStartedAtText = process.env.FRAMEWORK_RELEASE_STARTED_AT?.trim()
  const releaseStartedAt = releaseStartedAtText ? Date.parse(releaseStartedAtText) : undefined
  if (releaseStartedAt !== undefined && !Number.isFinite(releaseStartedAt)) refuse("FRAMEWORK_RELEASE_STARTED_AT is not a valid timestamp")
  // A release run (started by the release runner) must explore new cases: no fixed seed, no baseline rewrite.
  const releaseRun = releaseStartedAt !== undefined || process.env.FRAMEWORK_CONFORMANCE_PHASE?.trim() === "release"
  if (releaseRun && updateBaseline) refuse("--update-baseline cannot run inside a release check")
  // Ad-hoc runs (including --update-baseline) write outside the repository.
  const directory = differentialOutputDirectory({
    release: releaseRun,
    releaseDirectory,
    explicitDirectory: process.env.FRAMEWORK_DIFFERENTIAL_OUTPUT_DIR,
    id: process.env.FRAMEWORK_CONFORMANCE_RUN_ID?.trim() || randomBytes(4).toString("hex"),
  })
  const { seed, seedSource } = deriveDifferentialSeed(runId, process.env.DIFFERENTIAL_SEED, { release: releaseRun })
  const scales = {
    core: parseScale("FRAMEWORK_DIFFERENTIAL_SCALE", process.env.FRAMEWORK_DIFFERENTIAL_SCALE, DIFFERENTIAL_DEFAULT_SCALES.core),
    database: parseScale("FRAMEWORK_DIFFERENTIAL_DB_SCALE", process.env.FRAMEWORK_DIFFERENTIAL_DB_SCALE, DIFFERENTIAL_DEFAULT_SCALES.database),
  }

  // The validator's own refusal cases run first: a broken validator must not pass.
  // (Skipped when rewriting the baseline: its fixtures are derived from the baseline being replaced.)
  if (!updateBaseline) execFileSync(process.execPath, ["--test", "--test-reporter=dot", fileURLToPath(new URL("./differentialSupport.test.mjs", import.meta.url))], { cwd: repositoryRoot, stdio: "inherit" })

  const allSuites = await differentialSuites(repositoryRoot)
  if (selected) {
    const unknown = selected.filter(id => !allSuites.some(suite => suite.id === id))
    if (unknown.length > 0) refuse(`DIFFERENTIAL_SUITES names unknown suites ${unknown.join(", ")} (known: ${allSuites.map(suite => suite.id).join(", ")})`)
  }
  const suites = selected ? allSuites.filter(suite => selected.includes(suite.id)) : allSuites
  const sites = await requiredCallSites(repositoryRoot, suites)
  const baseline = await readDifferentialBaseline(repositoryRoot)
  const sourceManifestBefore = await createDifferentialSourceManifest(repositoryRoot)
  const reportRoot = join(directory, "property-reports")
  await rm(reportRoot, { recursive: true, force: true })
  console.log(`differential run ${runId}: seed ${seed} (${seedSource}), scale core ${scales.core} / database ${scales.database}`)

  const suiteResults = []
  const properties = []
  const siteCounts = {}
  for (const suite of suites) {
    const scale = suiteScale(suite, scales)
    const reportDirectory = join(reportRoot, suite.id)
    const env = { ...process.env, DIFFERENTIAL_SEED: String(seed), DIFFERENTIAL_SCALE: String(scale), DIFFERENTIAL_REPORT_DIR: reportDirectory }
    delete env.DIFFERENTIAL_RUN
    const args = ["run", "test", "-w", suite.workspace, "--", ...suiteVitestArgs(suite)]
    const replayCommand = `DIFFERENTIAL_SEED=${seed} DIFFERENTIAL_SCALE=${scale} npm ${args.join(" ")}`
    console.log(`\ndifferential suite ${suite.id}: ${suite.testFiles.length} file(s), ${sites[suite.id].length} property call site(s)`)
    const began = Date.now()
    const { code, output } = await npmStreaming(args, env)
    const durationMs = Date.now() - began
    if (code !== 0) {
      const failures = failureReplays(output)
      console.error(`\ndifferential suite ${suite.id} failed after ${(durationMs / 1000).toFixed(1)} s.`)
      const files = failingFiles(output, suite)
      const suiteFiles = new Set(suite.testFiles.map(path => relative(suite.workspaceDirectory, path).replaceAll("\\", "/")))
      const replayArgs = files.length === 0 ? args : ["run", "test", "-w", suite.workspace, "--", ...suiteVitestArgs(suite).filter(arg => !suiteFiles.has(arg)), ...files]
      for (const failure of failures) console.error(`  Property "${failure.property}" counterexample. Replay exactly: ${failure.replay} npm ${replayArgs.join(" ")}`)
      if (failures.length === 0) console.error("  No property counterexample was reported (a non-property test or setup failed).")
      console.error(`  Rerun the whole suite with the same cases: ${replayCommand}`)
      refuse(`suite ${suite.id} failed with seed ${seed}`)
    }
    const reports = await readPropertyReports(reportDirectory)
    const aggregated = aggregateSuiteReports({ suite: suite.id, sites: sites[suite.id], reports, seed, scale, startedAt, baseline: updateBaseline ? undefined : baseline.suites[suite.id] ?? null })
    const suiteProperties = aggregated.properties
    siteCounts[suite.id] = aggregated.siteCounts
    for (const [key, count] of Object.entries(aggregated.siteCounts)) {
      if (!updateBaseline && !(key in (baseline.suites[suite.id] ?? {}))) console.log(`differential note: ${suite.id} "${key}" (${count} properties) is not in ${DIFFERENTIAL_BASELINE} yet; it is required now, and --update-baseline records it`)
    }
    properties.push(...suiteProperties)
    const cases = suiteProperties.reduce((sum, property) => sum + property.runs, 0)
    suiteResults.push({ id: suite.id, kind: suite.kind, scale, testFiles: suite.testFiles, command: `npm ${args.join(" ")}`, callSites: sites[suite.id].length, properties: suiteProperties.length, cases, durationMs })
    console.log(`differential suite ${suite.id}: ${suiteProperties.length} properties, ${cases} cases, ${(durationMs / 1000).toFixed(1)} s`)
  }

  const sourceManifest = await createDifferentialSourceManifest(repositoryRoot)
  if (JSON.stringify(sourceManifest) !== JSON.stringify(sourceManifestBefore)) refuse("differential sources changed while the gate was running")
  if (updateBaseline) {
    await writeFile(resolve(repositoryRoot, DIFFERENTIAL_BASELINE), `${JSON.stringify(composeDifferentialBaseline(siteCounts), null, 2)}\n`)
    console.log(`\ndifferential baseline rewritten: ${DIFFERENTIAL_BASELINE}. Review the diff (every lowered or removed entry is a removed property), then rerun the runner.`)
    return
  }
  const artifact = composeDifferentialArtifact({ runId, seed, seedSource, scales, suites: suiteResults, properties, sourceManifest, gateStartedAt: startedAt, baseline })
  // Under the release runner the release volume floors apply; a standalone
  // run may use a lower volume but its artifact will not satisfy the release check.
  if (!releaseRun && (scales.core < DIFFERENTIAL_MINIMUM_SCALES.core || scales.database < DIFFERENTIAL_MINIMUM_SCALES.database)) {
    console.warn(`differential warning: scale below the release minimum (core ${DIFFERENTIAL_MINIMUM_SCALES.core}, database ${DIFFERENTIAL_MINIMUM_SCALES.database}); the release check will refuse this evidence.`)
  }
  if (selected) {
    // One share of a parallel release check: the complete artifact is merged and validated by the release check's summary step.
    if (!releaseRun) refuse("DIFFERENTIAL_SUITES is only for a share of a release check")
    await mkdir(directory, { recursive: true })
    const partialPath = join(directory, `${DIFFERENTIAL_PARTIAL_PREFIX}${selected.join("+")}.json`)
    await writeFile(partialPath, `${JSON.stringify(artifact, null, 2)}\n`)
    console.log(`\ndifferential share verified: ${partialPath} (suites ${selected.join(", ")}; ${artifact.totals.properties} properties, ${artifact.totals.cases} cases, seed ${seed})`)
    return
  }
  await validateDifferentialArtifact(artifact, { repositoryRoot, runId, startedAt: releaseStartedAt, minimumScales: releaseRun ? DIFFERENTIAL_MINIMUM_SCALES : scales, requireRunIdSeed: releaseRun })
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, DIFFERENTIAL_ARTIFACT), `${JSON.stringify(artifact, null, 2)}\n`)
  console.log(`\ndifferential run verified: ${directory} (${artifact.totals.properties} properties, ${artifact.totals.cases} cases, seed ${seed}, ${(artifact.totals.durationMs / 1000).toFixed(1)} s)`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof DifferentialRefusal ? error.message : error)
  process.exitCode = 1
}
