/**
 * Differential/property suites: runner support.
 *
 * Shared by the differential runner (differentials.mjs), the release
 * check (runReleaseCheck.mjs), and the differential self-test. The gate runs
 * every differential suite at elevated volume with a fresh, recorded seed and
 * collects the per-property success lines the harness writes when
 * `DIFFERENTIAL_REPORT_DIR` is set; this module derives what MUST have been
 * reported by scanning the suites' `forAll`/`forAllAsync` call sites, builds
 * the `differential-conformance.json` artifact, and validates it again at
 * the release check against the current sources.
 */
import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix, relative, resolve } from "node:path"
import ts from "typescript"

export const DIFFERENTIAL_PHASE = "differentials"
export const DIFFERENTIAL_ARTIFACT = "differential-conformance.json"
export const DIFFERENTIAL_SCHEMA_VERSION = 1
/** File-name prefix of the artifact one share of a parallel release check writes (DIFFERENTIAL_SUITES). */
export const DIFFERENTIAL_PARTIAL_PREFIX = "differential-conformance.partial-"

/** Default (and release-minimum) case-count multipliers. */
export const DIFFERENTIAL_DEFAULT_SCALES = Object.freeze({ core: 5, database: 2 })
export const DIFFERENTIAL_MINIMUM_SCALES = Object.freeze({ core: 5, database: 2 })
/** No property may be declared with fewer base cases than this. */
export const DIFFERENTIAL_MIN_BASE_RUNS = 50
/**
 * The checked-in property baseline: every known call site per suite with the
 * number of distinct properties it expanded to. Scanning makes every current
 * call site mandatory; the baseline makes a deleted call site, or a template
 * site that expands to fewer properties (a scenario loop losing iterations),
 * a refusal until the baseline is lowered deliberately
 * (`node scripts/verification/differentials.mjs --update-baseline`).
 */
export const DIFFERENTIAL_BASELINE = "scripts/verification/differentialBaseline.json"
const CORE_DIFFERENTIAL_DIR = "packages/core/src/__tests__/differential"
const HARNESS = `${CORE_DIFFERENTIAL_DIR}/harness.ts`
/** Harness self-tests plant failing properties on purpose; they are not release properties. */
const HARNESS_SELF_TEST = `${CORE_DIFFERENTIAL_DIR}/harness.test.ts`
/** HTTP fuzz suites: hostile-input properties over the CRUD and write handlers through the Express, Fastify and Hono adapters. */
const HTTP_FUZZ_DIRECTORY = "packages/adapters/src/http/__tests__/fuzz"
const HTTP_FUZZ_TESTS = name => name.endsWith(".test.ts") && name.endsWith("HttpFuzz.test.ts")
const SHARED_PARITY = ["packages/testing/integration/shared/richParity.ts", "packages/testing/integration/shared/predicateParity.ts"]
const DATABASE_ADAPTERS = ["pg", "mysql", "d1"]
/**
 * Real-database lifecycle-store differentials (each store area versus the core reference) and the workflow
 * signal-buffering suite. Their shared files declare the properties; each adapter has one integration entry point
 * per area. An area whose shared file or per-database test file does not exist yet is skipped on that database:
 * its declarations are not required until both files exist.
 */
const SHARED_DIRECTORY = "packages/testing/integration/shared"
export const STORE_DIFFERENTIAL_AREAS = ["job", "schedule", "workflow", "idempotency", "delivery", "lease", "sequence", "temporal", "jobProgress", "tagGeneration"]
const STORE_SIGNAL_BUFFERING = "workflowSignalBuffering"
const STORE_DIFFERENTIAL_SHARED_PATTERN = new RegExp(`^(?:${STORE_DIFFERENTIAL_AREAS.join("|")})StoreDifferential[A-Za-z]*\\.ts$`)
const STORE_DIFFERENTIAL_SHARED = name => STORE_DIFFERENTIAL_SHARED_PATTERN.test(name) || name === `${STORE_SIGNAL_BUFFERING}.ts`
/**
 * Shared-store properties that apply only to some databases, keyed by "<shared file>::<property display>". Every
 * other shared property must have evidence on every database whose runner exists. An entry that matches no call
 * site is refused, so the list cannot go stale.
 */
export const DATABASE_SPECIFIC_PROPERTIES = {
  [`${SHARED_DIRECTORY}/sequenceStoreDifferential.ts::sequence store concurrent transactions (\${…})`]: {
    databases: ["pg", "mysql"],
    reason: "D1 has no interactive transactions; its runner defines no `transact` driver",
  },
}
/** Fixture migration directory per database adapter. */
const FIXTURE_MIGRATIONS = { pg: "postgres", mysql: "mysql", d1: "d1" }
/** Roots scanned for harness call sites that are not part of any differential suite. */
const CALL_SITE_SCAN_ROOTS = ["packages/core/src", "packages/adapters/src", "packages/testing"]
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", "artifacts", ".git"])

/** Core sources the differential suites exercise, as [directory, file filter] or exact files. */
const COVERED_SOURCES = [
  ["packages/core/src/domain", name => /^(?:predicate|evaluatePredicate|predicateSimplifier|trustedPredicate|fieldAccess|abac[A-Za-z]*)\.ts$/.test(name)],
  "packages/core/src/operation/authorizationPlanEnforcement.ts",
  ["packages/core/src/query", isProductionTs],
  ["packages/core/src/serialization", isProductionTs],
  ["packages/core/src/cache", isProductionTs],
  ["packages/core/src/quota", isProductionTs],
  ["packages/core/src/sequence", isProductionTs],
  ["packages/core/src/execution", isProductionTs],
  ["packages/core/src/workflow", isProductionTs],
  ["packages/core/src/resilience", isProductionTs],
  ["packages/core/src/rate-limit", isProductionTs],
  ["packages/core/src/temporal", isProductionTs],
  ["packages/core/src/business-calendar", isProductionTs],
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
  ...DATABASE_ADAPTERS.flatMap(adapter => ["Job", "Schedule", "Workflow"].map(store => `packages/adapters/src/drizzle-${adapter}/drizzle${store}Store.ts`)),
  ...DATABASE_ADAPTERS.map(adapter => [`packages/testing/fixtures/${FIXTURE_MIGRATIONS[adapter]}/migrations`, name => name.endsWith(".sql")]),
  "docs/spec/persistence/predicates.md",
  "docs/spec/query.md",
  "docs/spec/execution.md",
  "docs/spec/sequence.md",
  "docs/spec/resilience.md",
  "docs/spec/workflow.md",
  "docs/spec/rate-limit.md",
  "docs/spec/temporal.md",
  "docs/spec/quota.md",
  "docs/spec/business-calendar.md",
  "docs/spec/domain.md",
  "scripts/verification/differentialSupport.mjs",
  "scripts/verification/differentials.mjs",
]

function isProductionTs(name) {
  return name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")
}

function toPosix(path) {
  return path.replaceAll("\\", "/")
}

export class DifferentialRefusal extends Error {
  constructor(message) {
    super(`Differential run refused: ${message}`)
    this.name = "DifferentialRefusal"
  }
}

function refuse(message) {
  throw new DifferentialRefusal(message)
}

async function listDirectory(repositoryRoot, directory, filter) {
  const entries = await readdir(resolve(repositoryRoot, directory), { withFileTypes: true })
  return entries.filter(entry => entry.isFile() && filter(entry.name)).map(entry => `${directory}/${entry.name}`).sort()
}

/** The differential suites: what runs, how, and which files declare its required properties. */
export async function differentialSuites(repositoryRoot) {
  const differentialFiles = await listDirectory(repositoryRoot, CORE_DIFFERENTIAL_DIR, name => name.endsWith(".ts"))
  const coreTests = differentialFiles.filter(path => path.endsWith(".test.ts") && path !== HARNESS_SELF_TEST)
  const suites = [{
    id: "core",
    kind: "core",
    workspace: "@xonava/core",
    workspaceDirectory: "packages/core",
    config: undefined,
    testFiles: coreTests,
    propertySources: differentialFiles.filter(path => path !== HARNESS && path !== HARNESS_SELF_TEST),
  }]
  // The fuzz generators and invariants carry no properties; only the *HttpFuzz.test.ts files declare them. The
  // regression file in the same directory runs with the ordinary adapters tests.
  const httpFuzzTests = await listDirectory(repositoryRoot, HTTP_FUZZ_DIRECTORY, HTTP_FUZZ_TESTS)
  suites.push({
    id: "http-fuzz",
    kind: "core",
    workspace: "@xonava/adapters",
    workspaceDirectory: "packages/adapters",
    config: undefined,
    testFiles: httpFuzzTests,
    propertySources: httpFuzzTests,
  })
  const { shared: storeDifferentialShared, databases } = await differentialStoreDifferential(repositoryRoot)
  for (const adapter of DATABASE_ADAPTERS) {
    const units = databases[adapter]
    const testFiles = [
      `packages/testing/integration/${adapter}/richParity.integration.test.ts`,
      `packages/testing/integration/${adapter}/predicateParity.integration.test.ts`,
      ...units.map(unit => storeUnitFiles(unit, adapter).test),
    ]
    suites.push({
      id: adapter,
      kind: "database",
      workspace: "@xonava/testing",
      workspaceDirectory: "packages/testing",
      config: "vitest.integration.config.ts",
      testFiles,
      propertySources: [...SHARED_PARITY, ...storeDifferentialShared.filter(path => units.includes(storeUnitOf(path))), ...testFiles],
    })
  }
  return suites
}

/** The shared file and the per-database test file of one store-differential unit (a store area, or signal buffering). */
function storeUnitFiles(unit, adapter) {
  const stem = unit === STORE_SIGNAL_BUFFERING ? unit : `${unit}StoreDifferential`
  return { shared: `${SHARED_DIRECTORY}/${stem}.ts`, test: `packages/testing/integration/${adapter}/${stem}.integration.test.ts` }
}

/** The unit a shared store file belongs to: the store area its name starts with (suffixed helpers included). */
function storeUnitOf(path) {
  const name = posix.basename(path)
  return name === `${STORE_SIGNAL_BUFFERING}.ts` ? STORE_SIGNAL_BUFFERING : STORE_DIFFERENTIAL_AREAS.find(area => name.startsWith(`${area}StoreDifferential`))
}

async function fileExists(repositoryRoot, path) {
  try {
    return (await stat(resolve(repositoryRoot, path))).isFile()
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

/** The store-differential shared files, and per database the units that run (a unit needs both its files). */
export async function differentialStoreDifferential(repositoryRoot) {
  const shared = await listDirectory(repositoryRoot, SHARED_DIRECTORY, STORE_DIFFERENTIAL_SHARED)
  const databases = {}
  for (const adapter of DATABASE_ADAPTERS) {
    databases[adapter] = []
    for (const unit of [...STORE_DIFFERENTIAL_AREAS, STORE_SIGNAL_BUFFERING]) {
      const { shared: sharedFile, test } = storeUnitFiles(unit, adapter)
      if (await fileExists(repositoryRoot, sharedFile) && await fileExists(repositoryRoot, test)) databases[adapter].push(unit)
    }
  }
  return { shared, databases }
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

const HARNESS_FUNCTIONS = new Set(["forAll", "forAllAsync"])

function isHarnessSpecifier(specifier, path) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return false
  const target = posix.normalize(posix.join(posix.dirname(path), specifier)).replace(/\.(?:[cm]?js|ts)$/, "")
  return target === HARNESS.replace(/\.ts$/, "")
}

/**
 * Every harness property call site in `source`. Only the bare named imports
 * `forAll` / `forAllAsync` of the harness may declare properties, and they may
 * only be called directly: aliased, namespace, default, dynamic, or re-exported
 * harness imports, and indirect uses of the functions, are refused because they
 * would hide properties from differential. A literal name is required exactly; a
 * template name becomes a pattern whose substitutions match any non-empty text.
 */
export function scanPropertyCallSites(source, path) {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const where = node => `${path}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`
  const violations = []
  const imported = new Set()
  const checkImports = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && isHarnessSpecifier(node.moduleSpecifier.text, path)) {
      const clause = node.importClause
      if (clause?.name) violations.push(`${where(node)} default-imports the differential harness`)
      const bindings = clause?.namedBindings
      if (bindings && ts.isNamespaceImport(bindings)) violations.push(`${where(node)} namespace-imports the differential harness; import forAll/forAllAsync by name`)
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = (element.propertyName ?? element.name).text
          const localName = element.name.text
          if ((HARNESS_FUNCTIONS.has(importedName) || HARNESS_FUNCTIONS.has(localName)) && importedName !== localName) {
            violations.push(`${where(element)} imports harness ${importedName} as ${localName}; import forAll/forAllAsync without an alias`)
          } else if (HARNESS_FUNCTIONS.has(importedName) && !clause.isTypeOnly && !element.isTypeOnly) {
            imported.add(importedName)
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && isHarnessSpecifier(node.moduleSpecifier.text, path) && !node.isTypeOnly) {
      violations.push(`${where(node)} re-exports the differential harness`)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression) && isHarnessSpecifier(node.moduleReference.expression.text, path)) {
      violations.push(`${where(node)} imports the differential harness with import =`)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const [specifier] = node.arguments
      if (specifier && ts.isStringLiteralLike(specifier) && isHarnessSpecifier(specifier.text, path)) violations.push(`${where(node)} loads the differential harness dynamically`)
    }
    ts.forEachChild(node, checkImports)
  }
  checkImports(sourceFile)

  const sites = []
  const visit = node => {
    if (ts.isIdentifier(node) && imported.has(node.text)) {
      const parent = node.parent
      if (ts.isCallExpression(parent) && parent.expression === node) {
        const [nameNode] = parent.arguments
        const location = where(parent)
        if (nameNode && (ts.isStringLiteral(nameNode) || ts.isNoSubstitutionTemplateLiteral(nameNode))) {
          sites.push({ file: path, location, display: nameNode.text, template: false, pattern: `^${escapeRegExp(nameNode.text)}$`, literalLength: nameNode.text.length })
        } else if (nameNode && ts.isTemplateExpression(nameNode)) {
          let display = nameNode.head.text
          let pattern = escapeRegExp(nameNode.head.text)
          let literalLength = nameNode.head.text.length
          for (const span of nameNode.templateSpans) {
            display += "${…}" + span.literal.text
            pattern += ".+" + escapeRegExp(span.literal.text)
            literalLength += span.literal.text.length
          }
          sites.push({ file: path, location, display, template: true, pattern: `^${pattern}$`, literalLength })
        } else {
          violations.push(`${location} names a differential property with a non-literal expression; use a string or template literal so differential can require it`)
        }
      } else if (!ts.isImportSpecifier(parent) && !(ts.isPropertyAccessExpression(parent) && parent.name === node) && !(ts.isPropertyAssignment(parent) && parent.name === node)) {
        violations.push(`${where(node)} uses harness ${node.text} other than as a direct call; differential cannot require properties declared that way`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (violations.length > 0) refuse(violations.join("; "))
  return sites
}

/** Baseline identity of a call site (file and name, not line, so edits elsewhere do not churn it). */
export function siteKey(site) {
  return `${site.file}::${site.display}`
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

/** Required call sites per suite; refuses when a harness consumer lives outside every differential suite. */
export async function requiredCallSites(repositoryRoot, suites) {
  const bySuite = {}
  const covered = new Set([HARNESS, HARNESS_SELF_TEST])
  const scanned = new Set()
  for (const suite of suites) {
    const sites = []
    for (const path of suite.propertySources) {
      covered.add(path)
      sites.push(...scanPropertyCallSites(await readFile(resolve(repositoryRoot, path), "utf8"), path))
    }
    if (sites.length === 0) refuse(`suite ${suite.id} declares no differential properties`)
    for (const site of sites) scanned.add(`${site.file}::${site.display}`)
    bySuite[suite.id] = suite.kind === "database" ? sites.filter(site => appliesToDatabase(site, suite.id)) : sites
  }
  for (const key of Object.keys(DATABASE_SPECIFIC_PROPERTIES)) {
    if (!scanned.has(key)) refuse(`database-specific property ${key} matches no differential call site`)
  }
  // A shared store file of an area that runs on no database yet still follows the harness rules, but it may not
  // declare properties: they would never run. An area that runs on at least one database is a differential suite there.
  for (const path of await listDirectory(repositoryRoot, SHARED_DIRECTORY, STORE_DIFFERENTIAL_SHARED)) {
    if (covered.has(path)) continue
    covered.add(path)
    const sites = scanPropertyCallSites(await readFile(resolve(repositoryRoot, path), "utf8"), path)
    if (sites.length > 0) refuse(`${path} declares differential properties but its store area has no per-database test file`)
  }
  for (const root of CALL_SITE_SCAN_ROOTS) {
    for (const path of await filesUnder(repositoryRoot, root)) {
      if (covered.has(path)) continue
      const source = await readFile(resolve(repositoryRoot, path), "utf8")
      if (!source.includes("harness")) continue
      if (scanPropertyCallSites(source, path).length > 0) refuse(`${path} declares differential properties but is not part of any differential suite`)
    }
  }
  return bySuite
}

/** Whether a call site is required on a database: every site is, unless DATABASE_SPECIFIC_PROPERTIES limits it. */
export function appliesToDatabase(site, database) {
  const entry = DATABASE_SPECIFIC_PROPERTIES[`${site.file}::${site.display}`]
  return entry === undefined || entry.databases.includes(database)
}

/** The differential source manifest paths, recomputed from the current tree. */
export async function differentialSourcePaths(repositoryRoot) {
  const suites = await differentialSuites(repositoryRoot)
  const paths = new Set([HARNESS, HARNESS_SELF_TEST, DIFFERENTIAL_BASELINE])
  for (const suite of suites) for (const path of [...suite.propertySources, ...suite.testFiles]) paths.add(path)
  for (const entry of COVERED_SOURCES) {
    if (typeof entry === "string") paths.add(entry)
    else for (const path of await listDirectory(repositoryRoot, entry[0], entry[1])) paths.add(path)
  }
  return [...paths].sort()
}

export async function createDifferentialSourceManifest(repositoryRoot) {
  return Promise.all((await differentialSourcePaths(repositoryRoot)).map(async path => ({
    path,
    sha256: createHash("sha256").update(await readFile(resolve(repositoryRoot, path))).digest("hex"),
  })))
}

export async function readDifferentialBaseline(repositoryRoot) {
  let baseline
  try {
    baseline = JSON.parse(await readFile(resolve(repositoryRoot, DIFFERENTIAL_BASELINE), "utf8"))
  } catch (error) {
    refuse(`cannot read the property baseline ${DIFFERENTIAL_BASELINE} (${error.message})`)
  }
  if (baseline?.schemaVersion !== 1 || typeof baseline.suites !== "object" || baseline.suites === null) refuse(`${DIFFERENTIAL_BASELINE} has the wrong schema`)
  for (const [suite, entries] of Object.entries(baseline.suites)) {
    for (const [key, count] of Object.entries(entries ?? {})) {
      if (!Number.isInteger(count) || count < 1) refuse(`${DIFFERENTIAL_BASELINE} ${suite} "${key}" must expect a positive integer number of properties`)
    }
  }
  return baseline
}

/** A baseline document from per-suite site expansion counts. */
export function composeDifferentialBaseline(siteCounts) {
  const suites = {}
  for (const [suite, counts] of Object.entries(siteCounts)) {
    suites[suite] = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  }
  return {
    schemaVersion: 1,
    description: "Differential property baseline: distinct passing properties per differential call site (file::name). Lower or remove an entry only with a reviewed removal; regenerate with node scripts/verification/differentials.mjs --update-baseline.",
    suites,
  }
}

/**
 * Where a differential run writes its reports and artifact. Release runs keep the
 * governed `releaseDirectory`. Any other run is ad hoc and must not write into
 * the repository (see .gitignore), so it defaults to
 * `<os tmpdir>/framework-differential-<id>` unless `explicitDirectory`
 * (FRAMEWORK_DIFFERENTIAL_OUTPUT_DIR) is given.
 */
export function differentialOutputDirectory({ release, releaseDirectory, explicitDirectory, id, tempRoot = tmpdir() }) {
  if (release) return releaseDirectory
  const explicit = explicitDirectory?.trim()
  if (explicit) return resolve(explicit)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id ?? "")) refuse("differential ad-hoc output id contains unsafe path characters")
  return join(tempRoot, `framework-differential-${id}`)
}

/** Seed policy: an explicit `DIFFERENTIAL_SEED`, else a deterministic function of the run ID. */
export function deriveDifferentialSeed(runId, explicitSeed, { release = false } = {}) {
  if (explicitSeed !== undefined && explicitSeed.trim() !== "") {
    if (release) refuse("DIFFERENTIAL_SEED is set; a release run must use the seed derived from its run ID so each release explores new cases")
    const text = explicitSeed.trim()
    if (!/^\d{1,10}$/.test(text) || Number(text) > 0xffffffff) refuse("DIFFERENTIAL_SEED must be an unsigned 32-bit integer")
    return { seed: Number(text), seedSource: "DIFFERENTIAL_SEED" }
  }
  const digest = createHash("sha256").update(`framework-differential:${runId}`).digest("hex")
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
 * Assigns a reported property name to exactly one call site: a literal site
 * with that exact name first, else the most specific matching template site
 * (most literal text). Two equally specific template sites are ambiguous.
 */
function assignSite(compiled, name, suite) {
  const literal = compiled.filter(site => !site.template && site.display === name)
  if (literal.length > 1) refuse(`${suite} declares "${name}" at more than one call site (${literal.map(site => site.location).join(", ")}); property names must be unique`)
  if (literal.length === 1) return literal[0]
  const templates = compiled.filter(site => site.template && site.regex.test(name)).sort((a, b) => b.literalLength - a.literalLength)
  if (templates.length === 0) return undefined
  if (templates.length > 1 && templates[0].literalLength === templates[1].literalLength) {
    refuse(`${suite} property "${name}" matches template call sites ${templates[0].location} and ${templates[1].location} equally; make their names distinguishable`)
  }
  return templates[0]
}

/**
 * Aggregates one suite's harness reports into property records and checks
 * them: recorded seed and scale, no replay mode, case counts at the scaled
 * minimum, nothing unexpected, every call site covered by its own properties,
 * and (unless `baseline` is undefined, as when regenerating it) no baselined
 * site deleted or expanding to fewer properties than recorded.
 */
export function aggregateSuiteReports({ suite, sites, reports, seed, scale, startedAt, baseline }) {
  const compiled = sites.map(site => ({ ...site, regex: new RegExp(site.pattern, "u") }))
  const properties = new Map()
  for (const report of reports) {
    const name = report?.property
    if (typeof name !== "string" || name === "") refuse(`${suite} reported a property without a name`)
    if (report.passed !== true) refuse(`${suite} property "${name}" did not pass`)
    if (report.seed !== seed) refuse(`${suite} property "${name}" ran with seed ${String(report.seed)}, not the recorded seed ${seed}`)
    if (report.scale !== scale) refuse(`${suite} property "${name}" ran at scale ${String(report.scale)}, not the recorded scale ${scale}`)
    if (report.replayRun !== null) refuse(`${suite} property "${name}" ran in single-case replay mode (DIFFERENTIAL_RUN)`)
    if (!Number.isInteger(report.baseRuns) || report.baseRuns < DIFFERENTIAL_MIN_BASE_RUNS) refuse(`${suite} property "${name}" declares ${String(report.baseRuns)} base cases; the minimum is ${DIFFERENTIAL_MIN_BASE_RUNS}`)
    if (!Number.isInteger(report.runs) || report.runs < expectedRuns(report.baseRuns, scale)) refuse(`${suite} property "${name}" ran ${String(report.runs)} cases; the scaled minimum is ${expectedRuns(report.baseRuns, scale)}`)
    if (startedAt !== undefined) {
      const recordedAt = Date.parse(report.recordedAt)
      if (!Number.isFinite(recordedAt) || recordedAt + 1000 < startedAt) refuse(`${suite} property "${name}" was not recorded by this run`)
    }
    const existing = properties.get(name)
    if (existing) {
      existing.executions++
      existing.runs += report.runs
      existing.baseRuns = Math.min(existing.baseRuns, report.baseRuns)
      continue
    }
    const site = assignSite(compiled, name, suite)
    if (site === undefined) refuse(`${suite} reported "${name}", which matches no differential call site in its suite`)
    properties.set(name, { suite, name, site: site.location, siteKey: siteKey(site), executions: 1, baseRuns: report.baseRuns, runs: report.runs })
  }
  const siteCounts = {}
  for (const site of compiled) siteCounts[siteKey(site)] = 0
  for (const property of properties.values()) siteCounts[property.siteKey]++
  const missing = compiled.filter(site => siteCounts[siteKey(site)] === 0)
  if (missing.length > 0) refuse(`${suite} has no passing evidence for ${missing.map(site => `"${site.display}" (${site.location})`).join(", ")}`)
  if (baseline !== undefined) {
    const expected = baseline ?? {}
    const deleted = Object.keys(expected).filter(key => !(key in siteCounts))
    if (deleted.length > 0) refuse(`${suite} baselined call site(s) no longer exist: ${deleted.map(key => `"${key}"`).join(", ")}; remove them from ${DIFFERENTIAL_BASELINE} only with a reviewed removal`)
    const dropped = Object.entries(expected).filter(([key, count]) => siteCounts[key] < count)
    if (dropped.length > 0) refuse(`${suite} call site(s) expanded to fewer properties than the baseline: ${dropped.map(([key, count]) => `"${key}" ${siteCounts[key]} < ${count}`).join(", ")}; lower ${DIFFERENTIAL_BASELINE} only with a reviewed removal`)
  }
  return { properties: [...properties.values()].sort((a, b) => a.name.localeCompare(b.name)), siteCounts }
}

export function replayInstructions(seed, scales) {
  return {
    seed,
    environment: "DIFFERENTIAL_SEED=<seed> DIFFERENTIAL_SCALE=<suite scale> [DIFFERENTIAL_RUN=<run from the failure report>]",
    core: `DIFFERENTIAL_SEED=${seed} DIFFERENTIAL_SCALE=${scales.core} npm run test -w @xonava/core -- --testTimeout=1800000 src/__tests__/differential`,
    database: `DIFFERENTIAL_SEED=${seed} DIFFERENTIAL_SCALE=${scales.database} npm run test -w @xonava/testing -- --config vitest.integration.config.ts --testTimeout=1800000 integration/<pg|mysql|d1>/richParity.integration.test.ts`,
    singleCase: "Add DIFFERENTIAL_RUN=<n> from a failure's 'Replay:' line to rerun exactly that (shrunk) case.",
  }
}

/** The `differential-conformance.json` document. */
export function composeDifferentialArtifact({ runId, seed, seedSource, scales, suites, properties, sourceManifest, gateStartedAt, baseline, recordedAt = new Date() }) {
  return {
    schemaVersion: DIFFERENTIAL_SCHEMA_VERSION,
    phase: "differential",
    status: "proven",
    runId,
    recordedAt: recordedAt.toISOString(),
    gateStartedAt: new Date(gateStartedAt).toISOString(),
    seed,
    seedSource,
    scales,
    minimums: { baseRuns: DIFFERENTIAL_MIN_BASE_RUNS, releaseScales: DIFFERENTIAL_MINIMUM_SCALES, baseline: { path: DIFFERENTIAL_BASELINE, sites: Object.values(baseline.suites).reduce((sum, entries) => sum + Object.keys(entries).length, 0) } },
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

/**
 * Merges the artifacts of the shares of a parallel release check into the one complete artifact. The shares must agree
 * on run, seed, scales and source manifest, and no suite may appear twice; completeness is then checked by
 * validateDifferentialArtifact, exactly as for a single run.
 */
export function mergeDifferentialArtifacts(partials, baseline) {
  if (partials.length === 0) refuse("no differential shares to merge")
  const [first] = partials
  const suites = []
  const properties = []
  for (const partial of partials) {
    for (const key of ["schemaVersion", "phase", "status", "runId", "seed", "seedSource"]) {
      if (partial?.[key] !== first[key]) refuse(`differential shares disagree on ${key}`)
    }
    if (JSON.stringify(partial.scales) !== JSON.stringify(first.scales)) refuse("differential shares disagree on scales")
    if (JSON.stringify(partial.sourceManifest) !== JSON.stringify(first.sourceManifest)) refuse("differential shares were taken over different sources")
    if (!Array.isArray(partial.suites) || !Array.isArray(partial.properties)) refuse("a differential share lists no suites or properties")
    for (const suite of partial.suites) {
      if (suites.some(known => known.id === suite.id)) refuse(`differential suite ${suite.id} appears in more than one share`)
      suites.push(suite)
    }
    properties.push(...partial.properties)
  }
  const times = partials.map(partial => Date.parse(partial.recordedAt))
  const starts = partials.map(partial => Date.parse(partial.gateStartedAt))
  if ([...times, ...starts].some(time => !Number.isFinite(time))) refuse("a differential share has no valid timestamp")
  return composeDifferentialArtifact({
    runId: first.runId,
    seed: first.seed,
    seedSource: first.seedSource,
    scales: first.scales,
    suites,
    properties,
    sourceManifest: first.sourceManifest,
    gateStartedAt: Math.min(...starts),
    baseline,
    recordedAt: new Date(Math.max(...times)),
  })
}

/** Validates a differential artifact against the current tree (used by the release check). */
export async function validateDifferentialArtifact(artifact, { repositoryRoot, runId, startedAt, minimumScales = DIFFERENTIAL_MINIMUM_SCALES, requireRunIdSeed = false }) {
  if (artifact?.schemaVersion !== DIFFERENTIAL_SCHEMA_VERSION || artifact.phase !== "differential") refuse("evidence has the wrong schema or phase")
  if (artifact.runId !== runId) refuse(`evidence belongs to run ${String(artifact.runId)}, not ${runId}`)
  if (artifact.status !== "proven") refuse("evidence is not proven")
  const recordedAt = Date.parse(artifact.recordedAt)
  if (!Number.isFinite(recordedAt)) refuse("evidence has no valid timestamp")
  if (startedAt !== undefined && recordedAt + 1000 < startedAt) refuse("evidence predates this release run")
  if (!Number.isInteger(artifact.seed) || artifact.seed < 0 || artifact.seed > 0xffffffff) refuse("evidence has no valid recorded seed")
  if (artifact.seedSource === "run-id" && deriveDifferentialSeed(runId).seed !== artifact.seed) refuse("recorded seed does not match the seed derived from the run ID")
  if (artifact.seedSource !== "run-id" && artifact.seedSource !== "DIFFERENTIAL_SEED") refuse("evidence does not record its seed source")
  if (requireRunIdSeed && artifact.seedSource !== "run-id") refuse(`release evidence must use the seed derived from its run ID, not ${String(artifact.seedSource)}`)
  const scales = artifact.scales ?? {}
  if (!(scales.core >= minimumScales.core) || !(scales.database >= minimumScales.database)) {
    refuse(`differential volume below the release minimum (core ${String(scales.core)} < ${minimumScales.core} or database ${String(scales.database)} < ${minimumScales.database})`)
  }
  const suites = await differentialSuites(repositoryRoot)
  const sites = await requiredCallSites(repositoryRoot, suites)
  const baseline = await readDifferentialBaseline(repositoryRoot)
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
    aggregateSuiteReports({ suite: suite.id, sites: sites[suite.id], reports, seed: artifact.seed, scale: suiteScale(suite, scales), startedAt: undefined, baseline: baseline.suites[suite.id] ?? null })
  }
  const unknownSuites = artifact.properties.filter(property => !suites.some(suite => suite.id === property?.suite))
  if (unknownSuites.length > 0) refuse("evidence contains properties of unknown suites")
  const unknownBaselineSuites = Object.keys(baseline.suites).filter(id => !suites.some(suite => suite.id === id))
  if (unknownBaselineSuites.length > 0) refuse(`${DIFFERENTIAL_BASELINE} names unknown suites ${unknownBaselineSuites.join(", ")}`)
  const expectedPaths = await differentialSourcePaths(repositoryRoot)
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

/**
 * Reads, freshness-checks, and validates `<artifactRoot>/<runId>/differentials/differential-conformance.json`.
 * This is the release check, so the seed must be the run-derived one unless a caller opts out.
 */
export async function loadAndValidateDifferentialEvidence({ repositoryRoot, artifactRoot, runId, startedAt, minimumScales, requireRunIdSeed = true }) {
  const path = resolve(artifactRoot, runId, DIFFERENTIAL_PHASE, DIFFERENTIAL_ARTIFACT)
  let text
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    refuse(`no differential evidence at ${toPosix(relative(repositoryRoot, path))} (${error.code ?? error.message}); run node scripts/verification/differentials.mjs in this release run`)
  }
  if (startedAt !== undefined && (await stat(path)).mtimeMs + 1000 < startedAt) refuse("differential evidence predates this release run")
  let artifact
  try {
    artifact = JSON.parse(text)
  } catch (error) {
    refuse(`differential evidence is not valid JSON (${error.message})`)
  }
  await validateDifferentialArtifact(artifact, { repositoryRoot, runId, startedAt, minimumScales, requireRunIdSeed })
  return { path, artifact, sha256: createHash("sha256").update(text).digest("hex") }
}
