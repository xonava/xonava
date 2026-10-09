/**
 * DF1: differential/property certification.
 *
 * Shared by the DF1 gate (verifyDF1Certification.mjs), the final release
 * verifier (verifyFinalCertification.mjs), and the DF1 self-test. The gate runs
 * every differential suite at elevated volume with a fresh, recorded seed and
 * collects the per-property success lines the harness writes when
 * `DIFFERENTIAL_REPORT_DIR` is set; this module derives what MUST have been
 * reported by scanning the suites' `forAll`/`forAllAsync` call sites, builds
 * the `differential-conformance.json` artifact, and validates it again at
 * final certification against the current sources.
 */
import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import ts from "typescript"

export const DF1_PHASE = "df1"
export const DF1_ARTIFACT = "differential-conformance.json"
export const DF1_SCHEMA_VERSION = 1

/** Default (and release-minimum) case-count multipliers. */
export const DF1_DEFAULT_SCALES = Object.freeze({ core: 5, database: 2 })
export const DF1_MINIMUM_SCALES = Object.freeze({ core: 5, database: 2 })
/** No property may be declared with fewer base cases than this. */
export const DF1_MIN_BASE_RUNS = 50
/**
 * Floors on distinct passing properties per suite. Scanning makes every
 * current call site mandatory; these floors catch deleted call sites. Lower a
 * floor only together with a reviewed removal of the property it counted.
 */
export const DF1_MIN_PROPERTIES = Object.freeze({ core: 136, pg: 4, mysql: 6, d1: 2 })

const CORE_DIFFERENTIAL_DIR = "packages/core/src/__tests__/differential"
const HARNESS = `${CORE_DIFFERENTIAL_DIR}/harness.ts`
/** Harness self-tests plant failing properties on purpose; they are not certification properties. */
const HARNESS_SELF_TEST = `${CORE_DIFFERENTIAL_DIR}/harness.test.ts`
const SHARED_PARITY = ["packages/testing/integration/shared/richParity.ts", "packages/testing/integration/shared/predicateParity.ts"]
const DATABASE_ADAPTERS = ["pg", "mysql", "d1"]
/** Roots scanned for harness call sites that are not part of any DF1 suite. */
const CALL_SITE_SCAN_ROOTS = ["packages/core/src", "packages/adapters/src", "packages/testing"]
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", "artifacts", "ci-artifacts", ".git"])

/** Core sources the differential suites exercise, as [directory, file filter] or exact files. */
const COVERED_SOURCES = [
  ["packages/core/src/domain", name => /^(?:predicate|evaluatePredicate|predicateSimplifier|trustedPredicate|fieldAccess|abac[A-Za-z]*)\.ts$/.test(name)],
  "packages/core/src/operation/authorizationPlanEnforcement.ts",
  ["packages/core/src/query", isProductionTs],
  ["packages/core/src/serialization", isProductionTs],
  ["packages/core/src/cache", isProductionTs],
  ["packages/core/src/quota", isProductionTs],
  ["packages/core/src/sequence", isProductionTs],
  "packages/core/src/execution/jobFingerprint.ts",
  ["packages/core/src/entity", isProductionTs],
  "packages/core/src/persistence/scoped.ts",
  "packages/adapters/src/drizzle-shared/predicateCompiler.ts",
  "packages/adapters/src/drizzle-shared/cursorPagination.ts",
  "packages/adapters/src/drizzle-shared/pagination.ts",
  "packages/adapters/src/drizzle-pg/postgresPredicate.ts",
  "packages/adapters/src/drizzle-pg/drizzleRepository.ts",
  "packages/adapters/src/drizzle-mysql/mysqlPredicate.ts",
  "packages/adapters/src/drizzle-mysql/drizzleRepository.ts",
  "packages/adapters/src/drizzle-d1/sqlitePredicate.ts",
  "packages/adapters/src/drizzle-d1/drizzleRepository.ts",
  "docs/spec/persistence/predicates.md",
  "docs/spec/query.md",
  "docs/spec/domain.md",
  "docs/spec/certification.md",
  "docs/guides/certification.md",
  "scripts/verification/differentialCertification.mjs",
  "scripts/verification/verifyDF1Certification.mjs",
]

function isProductionTs(name) {
  return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")
}

function posix(path) {
  return path.replaceAll("\\", "/")
}

export class Df1Refusal extends Error {
  constructor(message) {
    super(`DF1 certification refused: ${message}`)
    this.name = "Df1Refusal"
  }
}

function refuse(message) {
  throw new Df1Refusal(message)
}

async function listDirectory(repositoryRoot, directory, filter) {
  const entries = await readdir(resolve(repositoryRoot, directory), { withFileTypes: true })
  return entries.filter(entry => entry.isFile() && filter(entry.name)).map(entry => `${directory}/${entry.name}`).sort()
}

/** The DF1 suites: what runs, how, and which files declare its required properties. */
export async function df1Suites(repositoryRoot) {
  const differentialFiles = await listDirectory(repositoryRoot, CORE_DIFFERENTIAL_DIR, name => name.endsWith(".ts"))
  const coreTests = differentialFiles.filter(path => path.endsWith(".test.ts") && path !== HARNESS_SELF_TEST)
  const suites = [{
    id: "core",
    kind: "core",
    workspace: "core",
    workspaceDirectory: "packages/core",
    config: undefined,
    testFiles: coreTests,
    propertySources: differentialFiles.filter(path => path !== HARNESS && path !== HARNESS_SELF_TEST),
  }]
  for (const adapter of DATABASE_ADAPTERS) {
    const testFiles = [`packages/testing/integration/${adapter}/richParity.integration.test.ts`, `packages/testing/integration/${adapter}/predicateParity.integration.test.ts`]
    suites.push({
      id: adapter,
      kind: "database",
      workspace: "testing",
      workspaceDirectory: "packages/testing",
      config: "vitest.integration.config.ts",
      testFiles,
      propertySources: [...SHARED_PARITY, ...testFiles],
    })
  }
  return suites
}

/** Vitest arguments (after `npm run test -w <workspace> --`) for one suite. */
export function suiteVitestArgs(suite) {
  const files = suite.testFiles.map(path => relative(suite.workspaceDirectory, path).replaceAll("\\", "/"))
  // Elevated volume outgrows the default 5 s per-test budget; tests with an
  // explicit budget (the real-database parity tests) keep their own.
  return [...(suite.config ? ["--config", suite.config] : []), "--testTimeout=1800000", ...files]
}

export function suiteScale(suite, scales) {
  return suite.kind === "core" ? scales.core : scales.database
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Every `forAll(...)` / `forAllAsync(...)` call site in `source`. A literal
 * name is required exactly; a template name becomes a pattern whose
 * substitutions match any non-empty text, so each call site must be covered
 * by at least one reported property.
 */
export function scanPropertyCallSites(source, path) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const sites = []
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "forAll" || node.expression.text === "forAllAsync")) {
      const [nameNode] = node.arguments
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      const location = `${path}:${line}`
      if (nameNode && (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode))) {
        sites.push({ location, display: nameNode.text, pattern: `^${escapeRegExp(nameNode.text)}$` })
      } else if (nameNode && ts.isTemplateExpression(nameNode)) {
        let display = nameNode.head.text
        let pattern = escapeRegExp(nameNode.head.text)
        for (const span of nameNode.templateSpans) {
          display += "${…}" + span.literal.text
          pattern += ".+" + escapeRegExp(span.literal.text)
        }
        sites.push({ location, display, pattern: `^${pattern}$` })
      } else {
        refuse(`${location} names a differential property with a non-literal expression; use a string or template literal so DF1 can require it`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

async function filesUnder(repositoryRoot, directory) {
  const result = []
  let entries
  try {
    entries = await readdir(resolve(repositoryRoot, directory), { withFileTypes: true })
  } catch (error) {
    if (error.code === "ENOENT") return result
    throw error
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
    const child = `${directory}/${entry.name}`
    if (entry.isDirectory()) result.push(...await filesUnder(repositoryRoot, child))
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) result.push(child)
  }
  return result
}

/** Required call sites per suite; refuses when a harness consumer lives outside every DF1 suite. */
export async function requiredCallSites(repositoryRoot, suites) {
  const bySuite = {}
  const covered = new Set([HARNESS, HARNESS_SELF_TEST])
  for (const suite of suites) {
    const sites = []
    for (const path of suite.propertySources) {
      covered.add(path)
      sites.push(...scanPropertyCallSites(await readFile(resolve(repositoryRoot, path), "utf8"), path))
    }
    if (sites.length === 0) refuse(`suite ${suite.id} declares no differential properties`)
    bySuite[suite.id] = sites
  }
  for (const root of CALL_SITE_SCAN_ROOTS) {
    for (const path of await filesUnder(repositoryRoot, root)) {
      if (covered.has(path)) continue
      const source = await readFile(resolve(repositoryRoot, path), "utf8")
      if (!/\bforAll(?:Async)?\s*[(<]/.test(source)) continue
      if (scanPropertyCallSites(source, path).length > 0) refuse(`${path} declares differential properties but is not part of any DF1 suite`)
    }
  }
  return bySuite
}

/** The DF1 source manifest paths, recomputed from the current tree. */
export async function df1SourcePaths(repositoryRoot) {
  const suites = await df1Suites(repositoryRoot)
  const paths = new Set([HARNESS, HARNESS_SELF_TEST])
  for (const suite of suites) for (const path of [...suite.propertySources, ...suite.testFiles]) paths.add(path)
  for (const entry of COVERED_SOURCES) {
    if (typeof entry === "string") paths.add(entry)
    else for (const path of await listDirectory(repositoryRoot, entry[0], entry[1])) paths.add(path)
  }
  return [...paths].sort()
}

export async function createDf1SourceManifest(repositoryRoot) {
  return Promise.all((await df1SourcePaths(repositoryRoot)).map(async path => ({
    path,
    sha256: createHash("sha256").update(await readFile(resolve(repositoryRoot, path))).digest("hex"),
  })))
}

/** Seed policy: an explicit `DIFFERENTIAL_SEED`, else a deterministic function of the run ID. */
export function deriveDf1Seed(runId, explicitSeed) {
  if (explicitSeed !== undefined && explicitSeed.trim() !== "") {
    const text = explicitSeed.trim()
    if (!/^\d{1,10}$/.test(text) || Number(text) > 0xffffffff) refuse("DIFFERENTIAL_SEED must be an unsigned 32-bit integer")
    return { seed: Number(text), seedSource: "DIFFERENTIAL_SEED" }
  }
  const digest = createHash("sha256").update(`framework-df1:${runId}`).digest("hex")
  return { seed: Number.parseInt(digest.slice(0, 8), 16), seedSource: "run-id" }
}

export function parseScale(name, text, fallback) {
  if (text === undefined || text.trim() === "") return fallback
  const value = Number(text)
  if (!Number.isFinite(value) || value < 1 || value > 1000) refuse(`${name} must be a number between 1 and 1000`)
  return value
}

export function expectedRuns(baseRuns, scale) {
  return Math.max(1, Math.round(baseRuns * scale))
}

/** Reads every JSON line the harness wrote below `directory`. */
export async function readPropertyReports(directory) {
  let names
  try {
    names = (await readdir(directory)).filter(name => name.endsWith(".jsonl")).sort()
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const reports = []
  for (const name of names) {
    const lines = (await readFile(join(directory, name), "utf8")).split("\n").filter(line => line.trim() !== "")
    for (const [index, line] of lines.entries()) {
      try {
        reports.push(JSON.parse(line))
      } catch {
        refuse(`${name}:${index + 1} is not a valid property report`)
      }
    }
  }
  return reports
}

/**
 * Aggregates one suite's harness reports into property records and checks
 * them: recorded seed and scale, no replay mode, case counts at the scaled
 * minimum, every call site covered, nothing unexpected, and the count floor.
 */
export function aggregateSuiteReports({ suite, sites, reports, seed, scale, startedAt }) {
  const compiled = sites.map(site => ({ ...site, regex: new RegExp(site.pattern, "u") }))
  const properties = new Map()
  for (const report of reports) {
    const name = report?.property
    if (typeof name !== "string" || name === "") refuse(`${suite} reported a property without a name`)
    if (report.passed !== true) refuse(`${suite} property "${name}" did not pass`)
    if (report.seed !== seed) refuse(`${suite} property "${name}" ran with seed ${String(report.seed)}, not the recorded seed ${seed}`)
    if (report.scale !== scale) refuse(`${suite} property "${name}" ran at scale ${String(report.scale)}, not the recorded scale ${scale}`)
    if (report.replayRun !== null) refuse(`${suite} property "${name}" ran in single-case replay mode (DIFFERENTIAL_RUN)`)
    if (!Number.isInteger(report.baseRuns) || report.baseRuns < DF1_MIN_BASE_RUNS) refuse(`${suite} property "${name}" declares ${String(report.baseRuns)} base cases; the minimum is ${DF1_MIN_BASE_RUNS}`)
    if (!Number.isInteger(report.runs) || report.runs < expectedRuns(report.baseRuns, scale)) refuse(`${suite} property "${name}" ran ${String(report.runs)} cases; the scaled minimum is ${expectedRuns(report.baseRuns, scale)}`)
    if (startedAt !== undefined) {
      const recordedAt = Date.parse(report.recordedAt)
      if (!Number.isFinite(recordedAt) || recordedAt + 1000 < startedAt) refuse(`${suite} property "${name}" was not recorded by this run`)
    }
    const matches = compiled.filter(site => site.regex.test(name))
    if (matches.length === 0) refuse(`${suite} reported "${name}", which matches no differential call site in its suite`)
    const existing = properties.get(name)
    if (existing) {
      existing.executions++
      existing.runs += report.runs
      existing.baseRuns = Math.min(existing.baseRuns, report.baseRuns)
    } else {
      properties.set(name, { suite, name, sources: [...new Set(matches.map(site => site.location))], executions: 1, baseRuns: report.baseRuns, runs: report.runs })
    }
  }
  const missing = compiled.filter(site => ![...properties.keys()].some(name => site.regex.test(name)))
  if (missing.length > 0) refuse(`${suite} has no passing evidence for ${missing.map(site => `"${site.display}" (${site.location})`).join(", ")}`)
  const floor = DF1_MIN_PROPERTIES[suite] ?? 1
  if (properties.size < floor) refuse(`${suite} proved ${properties.size} distinct properties; at least ${floor} are required`)
  return [...properties.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function replayInstructions(seed, scales) {
  return {
    seed,
    environment: "DIFFERENTIAL_SEED=<seed> DIFFERENTIAL_SCALE=<suite scale> [DIFFERENTIAL_RUN=<run from the failure report>]",
    core: `DIFFERENTIAL_SEED=${seed} DIFFERENTIAL_SCALE=${scales.core} npm run test -w core -- --testTimeout=1800000 src/__tests__/differential`,
    database: `DIFFERENTIAL_SEED=${seed} DIFFERENTIAL_SCALE=${scales.database} npm run test -w testing -- --config vitest.integration.config.ts --testTimeout=1800000 integration/<pg|mysql|d1>/richParity.integration.test.ts`,
    singleCase: "Add DIFFERENTIAL_RUN=<n> from a failure's 'Replay:' line to rerun exactly that (shrunk) case.",
  }
}

/** The `differential-conformance.json` document. */
export function composeDf1Artifact({ runId, seed, seedSource, scales, suites, properties, sourceManifest, gateStartedAt, recordedAt = new Date() }) {
  return {
    schemaVersion: DF1_SCHEMA_VERSION,
    phase: "DF1",
    status: "proven",
    runId,
    recordedAt: recordedAt.toISOString(),
    gateStartedAt: new Date(gateStartedAt).toISOString(),
    seed,
    seedSource,
    scales,
    minimums: { baseRuns: DF1_MIN_BASE_RUNS, properties: DF1_MIN_PROPERTIES, releaseScales: DF1_MINIMUM_SCALES },
    suites,
    properties,
    totals: {
      suites: suites.length,
      properties: properties.length,
      callSites: suites.reduce((sum, suite) => sum + suite.callSites, 0),
      cases: suites.reduce((sum, suite) => sum + suite.cases, 0),
      durationMs: recordedAt.getTime() - new Date(gateStartedAt).getTime(),
    },
    replay: replayInstructions(seed, scales),
    sourceManifest,
  }
}

/** Validates a DF1 artifact against the current tree (used by final certification). */
export async function validateDf1Artifact(artifact, { repositoryRoot, runId, startedAt, minimumScales = DF1_MINIMUM_SCALES }) {
  if (artifact?.schemaVersion !== DF1_SCHEMA_VERSION || artifact.phase !== "DF1") refuse("evidence has the wrong schema or phase")
  if (artifact.runId !== runId) refuse(`evidence belongs to run ${String(artifact.runId)}, not ${runId}`)
  if (artifact.status !== "proven") refuse("evidence is not proven")
  const recordedAt = Date.parse(artifact.recordedAt)
  if (!Number.isFinite(recordedAt)) refuse("evidence has no valid timestamp")
  if (startedAt !== undefined && recordedAt + 1000 < startedAt) refuse("evidence predates this certification run")
  if (!Number.isInteger(artifact.seed) || artifact.seed < 0 || artifact.seed > 0xffffffff) refuse("evidence has no valid recorded seed")
  if (artifact.seedSource === "run-id" && deriveDf1Seed(runId).seed !== artifact.seed) refuse("recorded seed does not match the seed derived from the run ID")
  if (artifact.seedSource !== "run-id" && artifact.seedSource !== "DIFFERENTIAL_SEED") refuse("evidence does not record its seed source")
  const scales = artifact.scales ?? {}
  if (!(scales.core >= minimumScales.core) || !(scales.database >= minimumScales.database)) {
    refuse(`differential volume below the release minimum (core ${String(scales.core)} < ${minimumScales.core} or database ${String(scales.database)} < ${minimumScales.database})`)
  }
  const suites = await df1Suites(repositoryRoot)
  const sites = await requiredCallSites(repositoryRoot, suites)
  if (!Array.isArray(artifact.properties)) refuse("evidence lists no properties")
  for (const suite of suites) {
    const recorded = artifact.properties.filter(property => property?.suite === suite.id)
    const reports = recorded.map(property => ({
      property: property.name,
      seed: artifact.seed,
      scale: suiteScale(suite, scales),
      baseRuns: property.baseRuns,
      runs: property.runs,
      replayRun: null,
      passed: true,
    }))
    aggregateSuiteReports({ suite: suite.id, sites: sites[suite.id], reports, seed: artifact.seed, scale: suiteScale(suite, scales), startedAt: undefined })
  }
  const unknownSuites = artifact.properties.filter(property => !suites.some(suite => suite.id === property?.suite))
  if (unknownSuites.length > 0) refuse("evidence contains properties of unknown suites")
  const expectedPaths = await df1SourcePaths(repositoryRoot)
  const manifest = Array.isArray(artifact.sourceManifest) ? artifact.sourceManifest : []
  const recordedPaths = manifest.map(entry => entry?.path).sort()
  if (JSON.stringify(recordedPaths) !== JSON.stringify(expectedPaths)) refuse("source manifest does not cover exactly the current differential suites and covered sources")
  for (const entry of manifest) {
    let current
    try {
      current = createHash("sha256").update(await readFile(resolve(repositoryRoot, entry.path))).digest("hex")
    } catch {
      refuse(`source manifest names a missing file ${entry.path}`)
    }
    if (current !== entry.sha256) refuse(`${entry.path} changed after the differential evidence was recorded`)
  }
}

/** Reads, freshness-checks, and validates `<artifactRoot>/<runId>/df1/differential-conformance.json`. */
export async function loadAndValidateDf1Evidence({ repositoryRoot, artifactRoot, runId, startedAt, minimumScales }) {
  const path = resolve(artifactRoot, runId, DF1_PHASE, DF1_ARTIFACT)
  let text
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    refuse(`no differential evidence at ${posix(relative(repositoryRoot, path))} (${error.code ?? error.message}); run npm run verify:framework:df1 in this certification run`)
  }
  if (startedAt !== undefined && (await stat(path)).mtimeMs + 1000 < startedAt) refuse("differential evidence predates this certification run")
  let artifact
  try {
    artifact = JSON.parse(text)
  } catch (error) {
    refuse(`differential evidence is not valid JSON (${error.message})`)
  }
  await validateDf1Artifact(artifact, { repositoryRoot, runId, startedAt, minimumScales })
  return { path, artifact, sha256: createHash("sha256").update(text).digest("hex") }
}
