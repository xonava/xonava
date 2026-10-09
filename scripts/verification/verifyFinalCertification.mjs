import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadAndValidateDf1Evidence } from "./differentialCertification.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, "../..")
const adapters = ["pg", "mysql", "d1"]
const excludedDirectories = new Set(["node_modules", "dist", "coverage", "artifacts", "ci-artifacts", ".git"])
const sourceRoots = ["packages/core", "packages/adapters", "packages/testing", "scripts/verification"]
const sourceFiles = ["package.json", "package-lock.json", "docs/governance/public-api-manifest.json"]

function fail(message) {
  throw new Error(`Release certification refused: ${message}`)
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

async function digestFiles(paths) {
  const digest = createHash("sha256")
  const entries = []
  for (const path of paths.sort((a, b) => a.localeCompare(b))) {
    const content = await readFile(path)
    const name = relative(repositoryRoot, path).replaceAll("\\", "/")
    const sha256 = createHash("sha256").update(content).digest("hex")
    entries.push({ path: name, sha256 })
    digest.update(name).update("\0").update(content).update("\0")
  }
  return { sha256: digest.digest("hex"), fileCount: entries.length, entries }
}

async function currentSourceSnapshot() {
  const paths = sourceFiles.map(path => resolve(repositoryRoot, path))
  for (const root of sourceRoots) paths.push(...await filesUnder(resolve(repositoryRoot, root)))
  return digestFiles([...new Set(paths)])
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
    if (startedAt !== undefined && recordedAt + 1000 < startedAt) fail(`${adapter} guarantee evidence predates this certification run`)
  }
  const ids = new Set(value.records.map(record => record.guaranteeId))
  for (const required of ["temporal.atomicAppend", "temporal.monotonicRevision", "sequence.atomicGapless"]) {
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
  if (!Number.isInteger(value.repetitions) || value.repetitions < 20 || value.requiredRepetitions !== 20) {
    fail(`${adapter} crash evidence does not meet the 20-repetition floor`)
  }
  if (!Array.isArray(value.failpoints) || value.failpoints.length !== 6) fail(`${adapter} must prove exactly six crash failpoints`)
  const names = new Set()
  for (const point of value.failpoints) {
    if (!point.name || names.has(point.name) || point.status !== "proven" || point.partialCommitViolations !== 0) {
      fail(`${adapter} has duplicate, invalid, unproven, or partially committed crash evidence`)
    }
    names.add(point.name)
  }
  const recordedAt = Date.parse(value.recordedAt)
  if (!Number.isFinite(recordedAt)) fail(`${adapter} crash evidence has no valid timestamp`)
  if (startedAt !== undefined && recordedAt + 1000 < startedAt) fail(`${adapter} crash evidence predates this certification run`)
}

async function validateFreshness(path, startedAt) {
  if (startedAt === undefined) return
  const modified = (await stat(path)).mtimeMs
  if (modified + 1000 < startedAt) fail(`${relative(repositoryRoot, path)} predates this certification run`)
}

if (process.argv.includes("--source-digest")) {
  console.log((await currentSourceSnapshot()).sha256)
  process.exit(0)
}

const runId = process.env.FRAMEWORK_CONFORMANCE_RUN_ID?.trim()
if (!runId) fail("FRAMEWORK_CONFORMANCE_RUN_ID is required; implicit or historical runs cannot be certified")
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) fail("FRAMEWORK_CONFORMANCE_RUN_ID contains unsafe path characters")
const phase = process.env.FRAMEWORK_CONFORMANCE_PHASE?.trim() || "release"
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(phase)) fail("FRAMEWORK_CONFORMANCE_PHASE contains unsafe path characters")
const startedAtText = process.env.FRAMEWORK_CERTIFICATION_STARTED_AT?.trim()
const startedAt = startedAtText ? Date.parse(startedAtText) : undefined
if (!startedAtText || !Number.isFinite(startedAt)) fail("a valid FRAMEWORK_CERTIFICATION_STARTED_AT from the release runner is required")
const expectedSourceDigest = process.env.FRAMEWORK_CERTIFICATION_SOURCE_DIGEST?.trim()
if (!expectedSourceDigest || !/^[a-f0-9]{64}$/.test(expectedSourceDigest)) fail("a valid FRAMEWORK_CERTIFICATION_SOURCE_DIGEST from the release runner is required")

const directory = resolve(repositoryRoot, "artifacts/framework-conformance", runId, phase)
const evidence = []
const coreCapabilityEvidence = [
  ["rl1", "business-rules-conformance.json"],
  ["ag1", "aggregate-consistency-conformance.json"],
  ["th1", "temporal-history-conformance.json"],
  ["n1", "sequence-numbering-conformance.json"],
  ["ht1", "http-adapters-conformance.json"],
]
for (const [capabilityPhase, file] of coreCapabilityEvidence) {
  const path = resolve(repositoryRoot, "artifacts/framework-conformance", runId, capabilityPhase, file)
  await validateFreshness(path, startedAt)
  const artifact = await readJson(path)
  if (artifact.runId !== runId || artifact.status !== "proven" || String(artifact.phase).toLowerCase() !== capabilityPhase) fail(`${capabilityPhase} capability evidence is invalid`)
  evidence.push({ adapter: "core", kind: capabilityPhase, path: relative(repositoryRoot, path).replaceAll("\\", "/"), sha256: createHash("sha256").update(await readFile(path)).digest("hex") })
}
// DF1: the differential/property suites must have run in this certification
// run at release volume with a recorded seed, over the current sources.
let differential
try {
  differential = await loadAndValidateDf1Evidence({ repositoryRoot, artifactRoot: resolve(repositoryRoot, "artifacts/framework-conformance"), runId, startedAt })
} catch (error) {
  fail(error.message)
}
evidence.push({ adapter: "core", kind: "df1", path: relative(repositoryRoot, differential.path).replaceAll("\\", "/"), sha256: differential.sha256 })
for (const adapter of adapters) {
  const guaranteePath = join(directory, `${adapter}-guarantees.json`)
  const crashPath = join(directory, `${adapter}-crash-replay.json`)
  await validateFreshness(guaranteePath, startedAt)
  await validateFreshness(crashPath, startedAt)
  const guarantee = await readJson(guaranteePath)
  const crash = await readJson(crashPath)
  validateGuarantees(guarantee, adapter, runId, startedAt)
  validateCrash(crash, adapter, runId, startedAt)
  for (const [kind, path] of [["guarantees", guaranteePath], ["crash-replay", crashPath]]) {
    evidence.push({ adapter, kind, path: relative(repositoryRoot, path).replaceAll("\\", "/"), sha256: createHash("sha256").update(await readFile(path)).digest("hex") })
  }
}

const packages = []
for (const packageDirectory of ["packages/core", "packages/adapters", "packages/testing"]) {
  const value = await readJson(resolve(repositoryRoot, packageDirectory, "package.json"))
  if (value.version !== "2.0.0-rc.2") fail(`${value.name ?? packageDirectory} is not at approved release candidate 2.0.0-rc.2`)
  packages.push({ name: value.name, version: value.version })
}
const source = await currentSourceSnapshot()
if (source.sha256 !== expectedSourceDigest) fail("certification-relevant source changed while the release gate was running")
const lockfilePath = resolve(repositoryRoot, "package-lock.json")
const manifest = {
  schema: "framework.aggregate-release-certification",
  schemaVersion: 2,
  status: "certified",
  runId,
  phase,
  frameworkLine: "2.0",
  releaseCandidate: "2.0.0-rc.2",
  generatedAt: new Date().toISOString(),
  startedAt: startedAtText,
  packages,
  source: { sha256: source.sha256, fileCount: source.fileCount },
  lockfile: { path: "package-lock.json", sha256: createHash("sha256").update(await readFile(lockfilePath)).digest("hex") },
  evidence,
  differential: {
    seed: differential.artifact.seed,
    seedSource: differential.artifact.seedSource,
    scales: differential.artifact.scales,
    properties: differential.artifact.totals.properties,
    cases: differential.artifact.totals.cases,
  },
  certificationScope: {
    level: "local-multi-backend",
    providers: ["PostgreSQL", "MySQL", "D1 Miniflare"],
    productionTopologyCertified: false,
    customAdaptersCertified: false,
    externalAdvisories: "not-assessed-offline",
  },
}
const serialized = `${JSON.stringify(manifest, null, 2)}\n`
const digest = createHash("sha256").update(serialized).digest("hex")
await mkdir(directory, { recursive: true })
await writeFile(join(directory, "framework-release-manifest.json"), serialized, "utf8")
await writeFile(join(directory, "framework-release-manifest.sha256"), `${digest}  framework-release-manifest.json\n`, "utf8")
await writeFile(join(directory, "framework-release-source-files.json"), `${JSON.stringify(source, null, 2)}\n`, "utf8")
console.log(`Fresh release certification verified: ${relative(repositoryRoot, directory)} (${digest})`)
