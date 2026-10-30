/**
 * The release check: `npm run verify:release`.
 *
 * Runs the whole suite on all three databases (PostgreSQL, MySQL, D1), the
 * differential suites at release volume with a seed derived from the run ID,
 * and the crash failpoints with 20 repetitions, then re-reads the evidence the
 * suites recorded and refuses (non-zero exit) unless all of it is present,
 * fresh, complete and taken over the sources as they are now.
 *
 * Nothing here is committed. The summary goes to `.release-check/<run ID>/`
 * (git-ignored); keep that directory with the release as a CI artifact or a
 * release attachment. The suites write their raw evidence to
 * `artifacts/framework-conformance/<run ID>/release/` (also git-ignored).
 *
 * Environment: FRAMEWORK_TEST_PG_URL and FRAMEWORK_TEST_MYSQL_URL are required.
 * FRAMEWORK_CONFORMANCE_RUN_ID names the run (default release-<timestamp>).
 * FRAMEWORK_RELEASE_SOAK=1 adds the 30-minute soak on every database.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadAndValidateDifferentialEvidence } from "./differentialSupport.mjs"
import { FRAMEWORK_PACKAGE_DIRECTORIES, lockstepViolations } from "./frameworkVersionPolicy.mjs"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const adapters = ["pg", "mysql", "d1"]
const excludedDirectories = new Set(["node_modules", "dist", "coverage", "artifacts", ".release-check", ".git"])
const sourceRoots = ["packages/core", "packages/adapters", "packages/testing", "scripts/verification"]
const sourceFiles = ["package.json", "package-lock.json", "docs/governance/public-api-manifest.json"]
const requiredGuarantees = ["temporal.atomicAppend", "temporal.monotonicRevision", "sequence.atomicGapless"]
const crashRepetitions = 20
const crashFailpoints = 6

function fail(message) {
  throw new Error(`Release check refused: ${message}`)
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    fail(`cannot read valid JSON evidence at ${relative(repositoryRoot, path)} (${error.message})`)
  }
}

async function filesUnder(path) {
  const result = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (excludedDirectories.has(entry.name)) continue
    const child = join(path, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(child))
    else if (entry.isFile() && !entry.name.endsWith(".tsbuildinfo")) result.push(child)
  }
  return result
}

async function sourceSnapshot() {
  const paths = sourceFiles.map(path => resolve(repositoryRoot, path))
  for (const root of sourceRoots) paths.push(...await filesUnder(resolve(repositoryRoot, root)))
  const digest = createHash("sha256")
  let fileCount = 0
  for (const path of [...new Set(paths)].sort((a, b) => a.localeCompare(b))) {
    digest.update(relative(repositoryRoot, path).replaceAll("\\", "/")).update("\0").update(await readFile(path)).update("\0")
    fileCount += 1
  }
  return { sha256: digest.digest("hex"), fileCount }
}

function validateGuarantees(value, adapter, runId, startedAt) {
  if (value.schemaVersion !== 1 || value.runId !== runId || value.adapter !== adapter) {
    fail(`${adapter} guarantee evidence has the wrong schema, run ID, or adapter`)
  }
  if (!Array.isArray(value.records) || value.records.length === 0) fail(`${adapter} has no guarantee records`)
  for (const record of value.records) {
    if (record.adapter !== adapter || record.status !== "proven" || !record.guaranteeId || !record.sourceDigest) {
      fail(`${adapter} contains an invalid or unproven guarantee record`)
    }
    const recordedAt = Date.parse(record.recordedAt)
    if (!Number.isFinite(recordedAt)) fail(`${adapter} guarantee record has no valid timestamp`)
    if (recordedAt + 1000 < startedAt) fail(`${adapter} guarantee evidence predates this release check`)
  }
  const ids = new Set(value.records.map(record => record.guaranteeId))
  for (const required of requiredGuarantees) {
    if (!ids.has(required)) fail(`${adapter} guarantee evidence is missing ${required}`)
  }
}

function validateCrash(value, adapter, runId, startedAt) {
  if (value.schemaVersion !== 1 || value.runId !== runId || value.adapter !== adapter) {
    fail(`${adapter} crash evidence has the wrong schema, run ID, or adapter`)
  }
  if (value.status !== "proven" || value.processIsolation !== true || value.freshVerifier !== true) {
    fail(`${adapter} crash evidence is not proven with isolated fresh verifiers`)
  }
  if (!Number.isInteger(value.repetitions) || value.repetitions < crashRepetitions || value.requiredRepetitions !== crashRepetitions) {
    fail(`${adapter} crash evidence does not meet the ${crashRepetitions}-repetition floor`)
  }
  if (!Array.isArray(value.failpoints) || value.failpoints.length !== crashFailpoints) fail(`${adapter} must prove exactly ${crashFailpoints} crash failpoints`)
  const names = new Set()
  for (const point of value.failpoints) {
    if (!point.name || names.has(point.name) || point.status !== "proven" || point.partialCommitViolations !== 0) {
      fail(`${adapter} has duplicate, invalid, unproven, or partially committed crash evidence`)
    }
    names.add(point.name)
  }
  const recordedAt = Date.parse(value.recordedAt)
  if (!Number.isFinite(recordedAt)) fail(`${adapter} crash evidence has no valid timestamp`)
  if (recordedAt + 1000 < startedAt) fail(`${adapter} crash evidence predates this release check`)
}

async function validateFreshness(path, startedAt) {
  if ((await stat(path)).mtimeMs + 1000 < startedAt) fail(`${relative(repositoryRoot, path)} predates this release check`)
}

for (const name of ["FRAMEWORK_TEST_PG_URL", "FRAMEWORK_TEST_MYSQL_URL"]) {
  if (!process.env[name]?.trim()) fail(`${name} is required`)
}
const generatedRunId = `release-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`
const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID?.trim() || generatedRunId
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) fail("FRAMEWORK_CONFORMANCE_RUN_ID contains unsafe path characters")
const outputDirectory = resolve(repositoryRoot, ".release-check", runId)
const evidenceDirectory = resolve(repositoryRoot, "artifacts/framework-conformance", runId, "release")
for (const directory of [outputDirectory, resolve(repositoryRoot, "artifacts/framework-conformance", runId)]) {
  try {
    await access(directory)
    fail(`run directory already exists: ${relative(repositoryRoot, directory)}`)
  } catch (error) {
    if (error.message.startsWith("Release check refused:")) throw error
    if (error.code !== "ENOENT") throw error
  }
}

const startedAtText = new Date().toISOString()
const startedAt = Date.parse(startedAtText)
const sourceBefore = await sourceSnapshot()
// The release explores cases chosen by its own run ID: never inherit a fixed
// seed, a single-case replay, a volume override, or a report directory.
const inherited = { ...process.env }
for (const name of ["DIFFERENTIAL_SEED", "DIFFERENTIAL_RUN", "DIFFERENTIAL_SCALE", "DIFFERENTIAL_REPORT_DIR"]) delete inherited[name]
const env = {
  ...inherited,
  FRAMEWORK_CONFORMANCE_RUN_ID: runId,
  FRAMEWORK_CONFORMANCE_PHASE: "release",
  FRAMEWORK_RELEASE_STARTED_AT: startedAtText,
}

function npm(args, additions = {}) {
  execFileSync("npm", args, { cwd: repositoryRoot, stdio: "inherit", env: { ...env, ...additions }, shell: process.platform === "win32" })
}

console.log(`Starting release check ${runId}`)
for (const script of ["lint", "build", "verify", "verify:isolation", "test"]) npm(["run", script])
npm(["run", "test:coverage", "-w", "@xonava/core"])
// D1 first (no external service), then PostgreSQL and MySQL.
for (const adapter of ["d1", "pg", "mysql"]) {
  for (const kind of ["integration", "upgrade", "conformance", "race"]) npm(["run", `test:${kind}:${adapter}`, "-w", "@xonava/testing"])
}
// Differential/property suites at release volume with a run-derived seed.
npm(["run", "verify:differentials"])
for (const adapter of adapters) npm(["run", `test:crash:${adapter}`, "-w", "@xonava/testing"], { FRAMEWORK_CRASH_REPETITIONS: String(crashRepetitions) })
// Optional 1.0.0 quality gate: the 30-minute soak (SOAK_MINUTES, default 30) on D1, PostgreSQL and MySQL. It adds about
// 1.5 hours, so it only runs when FRAMEWORK_RELEASE_SOAK=1. Its output goes to <evidence>/../soak/ and is not part of the summary.
if (process.env.FRAMEWORK_RELEASE_SOAK === "1") npm(["run", "soak"], { FRAMEWORK_CONFORMANCE_PHASE: "soak" })
else console.log("Soak skipped (set FRAMEWORK_RELEASE_SOAK=1 to run the 30-minute soak as part of the release check)")

// Re-read what the suites recorded; fail closed on anything missing, stale or incomplete.
const evidence = []
const hashFile = async path => createHash("sha256").update(await readFile(path)).digest("hex")
let differential
try {
  differential = await loadAndValidateDifferentialEvidence({ repositoryRoot, artifactRoot: resolve(repositoryRoot, ".release-check"), runId, startedAt })
} catch (error) {
  fail(error.message)
}
evidence.push({ adapter: "core", kind: "differentials", path: relative(repositoryRoot, differential.path).replaceAll("\\", "/"), sha256: differential.sha256 })
for (const adapter of adapters) {
  const guaranteePath = join(evidenceDirectory, `${adapter}-guarantees.json`)
  const crashPath = join(evidenceDirectory, `${adapter}-crash-replay.json`)
  await validateFreshness(guaranteePath, startedAt)
  await validateFreshness(crashPath, startedAt)
  validateGuarantees(await readJson(guaranteePath), adapter, runId, startedAt)
  validateCrash(await readJson(crashPath), adapter, runId, startedAt)
  for (const [kind, path] of [["guarantees", guaranteePath], ["crash-replay", crashPath]]) {
    evidence.push({ adapter, kind, path: relative(repositoryRoot, path).replaceAll("\\", "/"), sha256: await hashFile(path) })
  }
}

const packageManifests = []
for (const packageDirectory of FRAMEWORK_PACKAGE_DIRECTORIES) packageManifests.push(await readJson(resolve(repositoryRoot, packageDirectory, "package.json")))
const versionViolations = lockstepViolations(packageManifests)
if (versionViolations.length > 0) fail(`framework packages are not in lockstep: ${versionViolations.join("; ")}`)
const sourceAfter = await sourceSnapshot()
if (sourceAfter.sha256 !== sourceBefore.sha256) fail("sources changed while the release check was running")

const summary = {
  status: "passed",
  runId,
  frameworkVersion: packageManifests[0].version,
  startedAt: startedAtText,
  finishedAt: new Date().toISOString(),
  packages: packageManifests.map(manifest => ({ name: manifest.name, version: manifest.version })),
  source: sourceAfter,
  lockfileSha256: await hashFile(resolve(repositoryRoot, "package-lock.json")),
  providers: ["PostgreSQL", "MySQL", "D1 (Miniflare)"],
  evidence,
  differential: {
    seed: differential.artifact.seed,
    seedSource: differential.artifact.seedSource,
    scales: differential.artifact.scales,
    properties: differential.artifact.totals.properties,
    cases: differential.artifact.totals.cases,
  },
}
await mkdir(outputDirectory, { recursive: true })
await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8")
console.log(`Release check passed for ${runId} (version ${summary.frameworkVersion}, ${summary.differential.properties} differential properties, seed ${summary.differential.seed}).`)
console.log(`Summary: ${relative(repositoryRoot, join(outputDirectory, "summary.json"))}. Keep .release-check/${runId} and artifacts/framework-conformance/${runId} with the release.`)
