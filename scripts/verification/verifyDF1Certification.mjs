/**
 * DF1 gate: runs every differential/property suite (core and the PostgreSQL,
 * MySQL, and D1 real-database parity suites) at elevated volume with a fresh
 * but recorded seed, then refuses certification unless every required
 * property reported success with that seed and scale.
 *
 * Environment:
 * - FRAMEWORK_CONFORMANCE_RUN_ID       run ID (default local-df1); names the run directory
 * - FRAMEWORK_DF1_OUTPUT_DIR           output directory of a non-release run (default:
 *                                      <os tmpdir>/framework-df1-<run ID, or a random id>);
 *                                      ignored by release runs, which use artifacts/framework-conformance/<run ID>/df1
 * - DIFFERENTIAL_SEED                  explicit base seed; default derives from the run ID
 * - FRAMEWORK_DIFFERENTIAL_SCALE       core case multiplier (default 5)
 * - FRAMEWORK_DIFFERENTIAL_DB_SCALE    real-database case multiplier (default 2)
 * - FRAMEWORK_TEST_PG_URL / FRAMEWORK_TEST_MYSQL_URL  real databases (required)
 *
 * `--update-baseline` runs every suite, then rewrites differentialBaseline.json
 * from the observed per-site property counts instead of certifying. Use it
 * only for a reviewed addition or removal of properties.
 */
import { spawn, execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { certificationContext, writeCertificationArtifact } from "./certificationSupport.mjs"
import {
  DF1_ARTIFACT,
  DF1_BASELINE,
  DF1_DEFAULT_SCALES,
  DF1_MINIMUM_SCALES,
  DF1_PHASE,
  Df1Refusal,
  aggregateSuiteReports,
  composeDf1Artifact,
  composeDf1Baseline,
  createDf1SourceManifest,
  deriveDf1Seed,
  df1OutputDirectory,
  df1Suites,
  parseScale,
  readDf1Baseline,
  readPropertyReports,
  requiredCallSites,
  suiteScale,
  suiteVitestArgs,
  validateDf1Artifact,
} from "./differentialCertification.mjs"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const startedAt = Date.now()

function refuse(message) {
  throw new Df1Refusal(message)
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
  const { runId, directory: releaseDirectory } = certificationContext("local-df1", DF1_PHASE)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) refuse("FRAMEWORK_CONFORMANCE_RUN_ID contains unsafe path characters")
  if (process.env.DIFFERENTIAL_RUN?.trim()) refuse("DIFFERENTIAL_RUN is set; single-case replay mode cannot certify")
  if (!process.env.FRAMEWORK_TEST_PG_URL?.trim() && !process.env.DATABASE_URL?.trim()) refuse("FRAMEWORK_TEST_PG_URL (or DATABASE_URL) is required for the PostgreSQL parity suite")
  if (!process.env.FRAMEWORK_TEST_MYSQL_URL?.trim()) refuse("FRAMEWORK_TEST_MYSQL_URL is required for the MySQL parity suite")
  const updateBaseline = process.argv.includes("--update-baseline")
  const certificationStartedAtText = process.env.FRAMEWORK_CERTIFICATION_STARTED_AT?.trim()
  const certificationStartedAt = certificationStartedAtText ? Date.parse(certificationStartedAtText) : undefined
  if (certificationStartedAt !== undefined && !Number.isFinite(certificationStartedAt)) refuse("FRAMEWORK_CERTIFICATION_STARTED_AT is not a valid timestamp")
  // A release run (started by the release runner) must explore new cases: no fixed seed, no baseline rewrite.
  const releaseRun = certificationStartedAt !== undefined || process.env.FRAMEWORK_CONFORMANCE_PHASE?.trim() === "release"
  if (releaseRun && updateBaseline) refuse("--update-baseline cannot run inside a release certification")
  // Ad-hoc runs (including --update-baseline) write outside the repository.
  const directory = df1OutputDirectory({
    release: releaseRun,
    releaseDirectory,
    explicitDirectory: process.env.FRAMEWORK_DF1_OUTPUT_DIR,
    id: process.env.FRAMEWORK_CONFORMANCE_RUN_ID?.trim() || randomBytes(4).toString("hex"),
  })
  const { seed, seedSource } = deriveDf1Seed(runId, process.env.DIFFERENTIAL_SEED, { release: releaseRun })
  const scales = {
    core: parseScale("FRAMEWORK_DIFFERENTIAL_SCALE", process.env.FRAMEWORK_DIFFERENTIAL_SCALE, DF1_DEFAULT_SCALES.core),
    database: parseScale("FRAMEWORK_DIFFERENTIAL_DB_SCALE", process.env.FRAMEWORK_DIFFERENTIAL_DB_SCALE, DF1_DEFAULT_SCALES.database),
  }

  // The validator's own refusal cases run first: a broken validator must not certify.
  // (Skipped when rewriting the baseline: its fixtures are derived from the baseline being replaced.)
  if (!updateBaseline) execFileSync(process.execPath, ["--test", "--test-reporter=dot", fileURLToPath(new URL("./differentialCertification.test.mjs", import.meta.url))], { cwd: repositoryRoot, stdio: "inherit" })

  const suites = await df1Suites(repositoryRoot)
  const sites = await requiredCallSites(repositoryRoot, suites)
  const baseline = await readDf1Baseline(repositoryRoot)
  const sourceManifestBefore = await createDf1SourceManifest(repositoryRoot)
  const reportRoot = join(directory, "property-reports")
  await rm(reportRoot, { recursive: true, force: true })
  console.log(`DF1 run ${runId}: seed ${seed} (${seedSource}), scale core ${scales.core} / database ${scales.database}`)

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
    console.log(`\nDF1 suite ${suite.id}: ${suite.testFiles.length} file(s), ${sites[suite.id].length} property call site(s)`)
    const began = Date.now()
    const { code, output } = await npmStreaming(args, env)
    const durationMs = Date.now() - began
    if (code !== 0) {
      const failures = failureReplays(output)
      console.error(`\nDF1 suite ${suite.id} failed after ${(durationMs / 1000).toFixed(1)} s.`)
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
      if (!updateBaseline && !(key in (baseline.suites[suite.id] ?? {}))) console.log(`DF1 note: ${suite.id} "${key}" (${count} properties) is not in ${DF1_BASELINE} yet; it is required now, and --update-baseline records it`)
    }
    properties.push(...suiteProperties)
    const cases = suiteProperties.reduce((sum, property) => sum + property.runs, 0)
    suiteResults.push({ id: suite.id, kind: suite.kind, scale, testFiles: suite.testFiles, command: `npm ${args.join(" ")}`, callSites: sites[suite.id].length, properties: suiteProperties.length, cases, durationMs })
    console.log(`DF1 suite ${suite.id}: ${suiteProperties.length} properties, ${cases} cases, ${(durationMs / 1000).toFixed(1)} s`)
  }

  const sourceManifest = await createDf1SourceManifest(repositoryRoot)
  if (JSON.stringify(sourceManifest) !== JSON.stringify(sourceManifestBefore)) refuse("differential sources changed while the gate was running")
  if (updateBaseline) {
    await writeFile(resolve(repositoryRoot, DF1_BASELINE), `${JSON.stringify(composeDf1Baseline(siteCounts), null, 2)}\n`)
    console.log(`\nDF1 baseline rewritten: ${DF1_BASELINE}. Review the diff (every lowered or removed entry is a removed property), then rerun the gate to certify.`)
    return
  }
  const artifact = composeDf1Artifact({ runId, seed, seedSource, scales, suites: suiteResults, properties, sourceManifest, gateStartedAt: startedAt, baseline })
  // Under the release runner the release volume floors apply; a standalone
  // run may use a lower volume but its artifact will not satisfy final certification.
  if (!releaseRun && (scales.core < DF1_MINIMUM_SCALES.core || scales.database < DF1_MINIMUM_SCALES.database)) {
    console.warn(`DF1 warning: scale below the release minimum (core ${DF1_MINIMUM_SCALES.core}, database ${DF1_MINIMUM_SCALES.database}); final certification will refuse this evidence.`)
  }
  await validateDf1Artifact(artifact, { repositoryRoot, runId, startedAt: certificationStartedAt, minimumScales: releaseRun ? DF1_MINIMUM_SCALES : scales, requireRunIdSeed: releaseRun })
  await writeCertificationArtifact(directory, DF1_ARTIFACT, artifact)
  console.log(`\nDF1 certification verified: ${directory} (${artifact.totals.properties} properties, ${artifact.totals.cases} cases, seed ${seed}, ${(artifact.totals.durationMs / 1000).toFixed(1)} s)`)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Df1Refusal ? error.message : error)
  process.exitCode = 1
}
