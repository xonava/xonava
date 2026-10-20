/**
 * Self-test for the DF1 validator (run by `npm run test:verification` and at
 * the start of every DF1 gate). It proves the refusals final certification
 * relies on: missing, stale, foreign-run, under-volume, incomplete, and
 * source-drifted differential evidence is never accepted.
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { after, before, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import {
  DF1_ARTIFACT,
  DF1_MINIMUM_SCALES,
  DF1_PHASE,
  Df1Refusal,
  STORE_DIFFERENTIAL_AREAS,
  aggregateSuiteReports,
  composeDf1Artifact,
  createDf1SourceManifest,
  deriveDf1Seed,
  df1OutputDirectory,
  df1SourcePaths,
  df1StoreDifferential,
  df1Suites,
  loadAndValidateDf1Evidence,
  readDf1Baseline,
  readPropertyReports,
  requiredCallSites,
  scanPropertyCallSites,
  siteKey,
  suiteScale,
} from "./differentialCertification.mjs"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const scales = { ...DF1_MINIMUM_SCALES }
const refused = pattern => error => error instanceof Df1Refusal && pattern.test(error.message)

/** Synthetic passing reports for every call site, each template expanded as often as the baseline expects. */
function syntheticReports(sites, seed, scale, expected = {}) {
  const reports = []
  for (const site of sites) {
    const count = expected[siteKey(site)] ?? 1
    const names = site.template ? Array.from({ length: count }, (_, variant) => site.display.replaceAll("${…}", `variant ${variant + 1}`)) : [site.display]
    for (const name of names) reports.push({ property: name, seed, scale, baseRuns: 100, runs: Math.round(100 * scale), replayRun: null, passed: true, recordedAt: new Date().toISOString() })
  }
  return reports
}

describe("DF1 property call-site scanning", () => {
  const file = "packages/core/src/__tests__/differential/example.test.ts"
  const header = "import { forAll, forAllAsync, type Rng } from \"./harness\"\n"

  it("requires literal names exactly and template names by pattern", () => {
    const sites = scanPropertyCallSites(header + [
      "forAll(\"plain law\", gen, check)",
      "await forAllAsync(`parity (${driver.label})`, gen, check)",
      "forAllAsync<Case>('typed', gen, check)",
      "other.forAll(\"not the harness\", gen, check)",
    ].join("\n"), file)
    assert.deepEqual(sites.map(site => site.display), ["plain law", "parity (${…})", "typed"])
    assert.ok(new RegExp(sites[1].pattern, "u").test("parity (PostgreSQL)"))
    assert.ok(!new RegExp(sites[1].pattern, "u").test("parity ()"))
  })

  it("resolves the harness from other directories", () => {
    const sites = scanPropertyCallSites("import { forAllAsync } from \"../../../core/src/__tests__/differential/harness.js\"\nawait forAllAsync(\"remote\", gen, check)", "packages/testing/integration/shared/example.ts")
    assert.deepEqual(sites.map(site => site.display), ["remote"])
  })

  it("ignores functions named forAll that are not the harness", () => {
    assert.deepEqual(scanPropertyCallSites("import { forAll } from \"fast-check\"\nforAll(\"other\", gen, check)", file), [])
  })

  it("refuses property names it cannot require", () => {
    assert.throws(() => scanPropertyCallSites(header + "forAll(name, gen, check)", file), refused(/non-literal/))
  })

  it("refuses aliased, namespace, default, dynamic, and re-exported harness imports", () => {
    const cases = [
      ["import { forAll as check } from \"./harness\"\ncheck(\"hidden\", gen, p)", /imports harness forAll as check/],
      ["import { createRng as forAll } from \"./harness\"", /imports harness createRng as forAll/],
      ["import * as h from \"./harness\"\nh.forAll(\"hidden\", gen, p)", /namespace-imports/],
      ["import h from \"./harness.js\"", /default-imports/],
      ["const h = await import(\"./harness\")", /dynamically/],
      ["export { forAll } from \"./harness\"", /re-exports/],
      ["export * from \"./harness\"", /re-exports/],
    ]
    for (const [source, pattern] of cases) assert.throws(() => scanPropertyCallSites(source, file), refused(pattern), source)
    assert.deepEqual(scanPropertyCallSites("import type { Rng } from \"./harness\"\nexport type { Rng } from \"./harness\"", file), [])
  })

  it("refuses indirect uses of the harness functions", () => {
    for (const source of ["const check = forAll\ncheck(\"hidden\", gen, p)", "run(forAllAsync)", "export { forAll }", "const table = { forAll }"]) {
      assert.throws(() => scanPropertyCallSites(header + source, file), refused(/other than as a direct call/), source)
    }
  })
})

describe("DF1 real-database store differential suites", () => {
  it("refuses a store area that declares properties but runs on no database, and requires them once one runner exists", async () => {
    const shared = join(repositoryRoot, "packages/testing/integration/shared/leaseStoreDifferential.ts")
    const runner = join(repositoryRoot, "packages/testing/integration/d1/leaseStoreDifferential.integration.test.ts")
    await writeFile(shared, `import { forAllAsync } from "../../../core/src/__tests__/differential/harness.js"\nforAllAsync("lease probe", { runs: 50 }, async () => {})\n`)
    try {
      await assert.rejects(requiredCallSites(repositoryRoot, await df1Suites(repositoryRoot)), /has no per-database test file/)
      await writeFile(runner, "")
      const sites = await requiredCallSites(repositoryRoot, await df1Suites(repositoryRoot))
      assert.ok(sites.d1.some(site => site.display.includes("lease probe")))
      assert.ok(!sites.pg.some(site => site.display.includes("lease probe")))
    } finally {
      await rm(shared, { force: true })
      await rm(runner, { force: true })
    }
  })

  it("runs every store area and the signal-buffering suite that exist on every database, and requires their properties", async () => {
    const suites = await df1Suites(repositoryRoot)
    const sites = await requiredCallSites(repositoryRoot, suites)
    const { databases } = await df1StoreDifferential(repositoryRoot)
    for (const suite of suites.filter(candidate => candidate.kind === "database")) {
      for (const unit of ["job", "schedule", "workflow", "workflowSignalBuffering"]) assert.ok(databases[suite.id].includes(unit), `${suite.id} runs ${unit}`)
      for (const unit of [...STORE_DIFFERENTIAL_AREAS, "workflowSignalBuffering"]) {
        const stem = unit === "workflowSignalBuffering" ? unit : `${unit}StoreDifferential`
        assert.equal(suite.testFiles.includes(`packages/testing/integration/${suite.id}/${stem}.integration.test.ts`), databases[suite.id].includes(unit), `${suite.id} ${stem} runs only when present`)
      }
      const names = sites[suite.id].map(site => site.display)
      for (const fragment of ["job store lifecycle differential", "job store concurrent transitions", "job store concurrent claim", "core job dispatcher", "schedule store lifecycle differential", "schedule store concurrent claims", "workflow store differential lifecycle", "workflow store differential concurrent dispatch"]) {
        assert.ok(names.some(name => name.includes(fragment)), `${suite.id} requires "${fragment}"`)
      }
    }
  })

  it("covers the adapter store sources and every fixture migration", async () => {
    const paths = await df1SourcePaths(repositoryRoot)
    for (const adapter of ["pg", "mysql", "d1"]) {
      for (const store of ["Job", "Schedule", "Workflow"]) assert.ok(paths.includes(`packages/adapters/src/drizzle-${adapter}/drizzle${store}Store.ts`), `${adapter} ${store} store`)
    }
    for (const directory of ["postgres", "mysql", "d1"]) {
      for (const migration of ["0001_framework.sql", "0002_workflow_signal_buffering.sql"]) assert.ok(paths.includes(`packages/testing/fixtures/${directory}/migrations/${migration}`), `${directory} ${migration}`)
    }
  })
})

describe("DF1 output directory", () => {
  const releaseDirectory = resolve("artifacts/framework-conformance/release-a/df1")

  it("keeps the governed artifacts path for release runs, whatever else is set", () => {
    assert.equal(df1OutputDirectory({ release: true, releaseDirectory, explicitDirectory: "/elsewhere", id: "x" }), releaseDirectory)
  })

  it("defaults non-release runs to an OS temp directory outside the repository", () => {
    const directory = df1OutputDirectory({ release: false, releaseDirectory: resolve("artifacts/framework-conformance/local-df1/df1"), id: "ab12cd34" })
    assert.equal(directory, join(tmpdir(), "framework-df1-ab12cd34"))
    assert.ok(!resolve(directory).startsWith(resolve("artifacts")))
    assert.equal(df1OutputDirectory({ release: false, releaseDirectory, id: "r1", tempRoot: "/tmp/t" }), join("/tmp/t", "framework-df1-r1"))
  })

  it("honours an explicit output path and rejects unsafe ad-hoc ids", () => {
    assert.equal(df1OutputDirectory({ release: false, releaseDirectory, explicitDirectory: "out/df1", id: "r1" }), resolve("out/df1"))
    assert.throws(() => df1OutputDirectory({ release: false, releaseDirectory, id: "../escape" }), refused(/unsafe path characters/))
  })
})

describe("DF1 seed policy", () => {
  it("derives a stable, run-specific seed unless DIFFERENTIAL_SEED is set", () => {
    const first = deriveDf1Seed("release-a")
    assert.equal(first.seedSource, "run-id")
    assert.deepEqual(deriveDf1Seed("release-a"), first)
    assert.notEqual(deriveDf1Seed("release-b").seed, first.seed)
    assert.deepEqual(deriveDf1Seed("release-a", "42"), { seed: 42, seedSource: "DIFFERENTIAL_SEED" })
    assert.throws(() => deriveDf1Seed("release-a", "-1"), refused(/unsigned 32-bit/))
    assert.throws(() => deriveDf1Seed("release-a", "4294967296"), refused(/unsigned 32-bit/))
  })

  it("refuses an explicit seed in a release run", () => {
    assert.throws(() => deriveDf1Seed("release-a", "42", { release: true }), refused(/release run must use the seed derived from its run ID/))
    assert.equal(deriveDf1Seed("release-a", undefined, { release: true }).seedSource, "run-id")
  })
})

describe("DF1 report aggregation", () => {
  const site = (line, display) => {
    const template = display.includes("${…}")
    const pattern = `^${display.split("${…}").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`
    return { file: "a.ts", location: `a.ts:${line}`, display, template, pattern, literalLength: display.replaceAll("${…}", "").length }
  }
  const sites = [site(1, "law one"), site(2, "parity (${…})")]
  const base = { property: "law one", seed: 7, scale: 2, baseRuns: 100, runs: 200, replayRun: null, passed: true, recordedAt: new Date().toISOString() }
  const valid = [base, { ...base, property: "parity (PostgreSQL)" }, { ...base, property: "parity (PostgreSQL icu)" }]
  const aggregate = (reports, options = {}) => aggregateSuiteReports({ suite: "unit", sites, reports, seed: 7, scale: 2, startedAt: Date.now() - 60_000, ...options })

  it("accepts complete evidence and counts each site's own properties", () => {
    const { properties, siteCounts } = aggregate(valid, { baseline: { "a.ts::law one": 1, "a.ts::parity (${…})": 2 } })
    assert.deepEqual(properties.map(property => property.name), ["law one", "parity (PostgreSQL icu)", "parity (PostgreSQL)"])
    assert.deepEqual(siteCounts, { "a.ts::law one": 1, "a.ts::parity (${…})": 2 })
  })

  it("refuses a missing property", () => {
    assert.throws(() => aggregate(valid.filter(report => report.property !== "law one")), refused(/no passing evidence for "law one"/))
  })

  it("does not let a literal site's property satisfy a template site", () => {
    const overlapping = [site(1, "simplifier folds constant trees"), site(2, "simplifier ${…}")]
    const reports = [{ ...base, property: "simplifier folds constant trees" }]
    assert.throws(() => aggregateSuiteReports({ suite: "unit", sites: overlapping, reports, seed: 7, scale: 2 }), refused(/no passing evidence for "simplifier \$\{…\}"/))
    const { siteCounts } = aggregateSuiteReports({ suite: "unit", sites: overlapping, reports: [...reports, { ...base, property: "simplifier few literals" }], seed: 7, scale: 2 })
    assert.deepEqual(siteCounts, { "a.ts::simplifier folds constant trees": 1, "a.ts::simplifier ${…}": 1 })
  })

  it("assigns a name to the most specific template and refuses ambiguous templates", () => {
    const nested = [site(1, "abac ${…}"), site(2, "abac read ${…}")]
    const { siteCounts } = aggregateSuiteReports({ suite: "unit", sites: nested, reports: [{ ...base, property: "abac read maps" }, { ...base, property: "abac write maps" }], seed: 7, scale: 2 })
    assert.deepEqual(siteCounts, { "a.ts::abac ${…}": 1, "a.ts::abac read ${…}": 1 })
    const ambiguous = [site(1, "x ${…} a"), site(2, "x a ${…}")]
    assert.throws(() => aggregateSuiteReports({ suite: "unit", sites: ambiguous, reports: [{ ...base, property: "x a a" }], seed: 7, scale: 2 }), refused(/equally/))
  })

  it("refuses a template site that expands to fewer properties than the baseline", () => {
    assert.throws(() => aggregate(valid.slice(0, 2), { baseline: { "a.ts::law one": 1, "a.ts::parity (${…})": 2 } }), refused(/fewer properties than the baseline: "a\.ts::parity \(\$\{…\}\)" 1 < 2/))
  })

  it("refuses a baselined call site that was deleted, even when another property was added", () => {
    assert.throws(() => aggregate(valid, { baseline: { "a.ts::law one": 1, "a.ts::parity (${…})": 2, "a.ts::law two": 1 } }), refused(/no longer exist: "a\.ts::law two"/))
  })

  it("accepts new call sites that the baseline does not list yet", () => {
    assert.equal(aggregate(valid, { baseline: { "a.ts::law one": 1 } }).properties.length, 3)
  })

  it("refuses evidence from another seed, scale, replay mode, or volume", () => {
    assert.throws(() => aggregate([...valid.slice(1), { ...base, seed: 8 }]), refused(/recorded seed/))
    assert.throws(() => aggregate([...valid.slice(1), { ...base, scale: 1 }]), refused(/recorded scale/))
    assert.throws(() => aggregate([...valid.slice(1), { ...base, replayRun: 3 }]), refused(/replay mode/))
    assert.throws(() => aggregate([...valid.slice(1), { ...base, runs: 199 }]), refused(/scaled minimum/))
    assert.throws(() => aggregate([...valid.slice(1), { ...base, baseRuns: 10, runs: 20 }]), refused(/base cases/))
    assert.throws(() => aggregate([...valid.slice(1), { ...base, passed: false }]), refused(/did not pass/))
  })

  it("refuses stale and unexpected reports", () => {
    assert.throws(() => aggregate([...valid.slice(1), { ...base, recordedAt: "2000-01-01T00:00:00.000Z" }]), refused(/not recorded by this run/))
    assert.throws(() => aggregate([...valid, { ...base, property: "unknown law" }]), refused(/matches no differential call site/))
  })

  it("reads per-worker report files and refuses corrupt lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "df1-reports-"))
    try {
      assert.deepEqual(await readPropertyReports(join(directory, "absent")), [])
      await writeFile(join(directory, "properties-1-0.jsonl"), `${JSON.stringify(base)}\n`)
      await writeFile(join(directory, "properties-2-0.jsonl"), `${JSON.stringify(valid[1])}\n${JSON.stringify(valid[2])}\n`)
      assert.equal((await readPropertyReports(directory)).length, 3)
      await writeFile(join(directory, "properties-3-0.jsonl"), "{\"property\":\n")
      await assert.rejects(readPropertyReports(directory), refused(/not a valid property report/))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("final certification DF1 evidence", () => {
  const runId = "df1-self-test"
  let artifactRoot
  let validArtifact
  let baseline
  const startedAt = Date.now() - 60_000

  before(async () => {
    artifactRoot = await mkdtemp(join(tmpdir(), "df1-artifacts-"))
    const suites = await df1Suites(repositoryRoot)
    const sites = await requiredCallSites(repositoryRoot, suites)
    baseline = await readDf1Baseline(repositoryRoot)
    const { seed, seedSource } = deriveDf1Seed(runId)
    const properties = []
    const suiteResults = []
    for (const suite of suites) {
      const scale = suiteScale(suite, scales)
      const expected = baseline.suites[suite.id] ?? {}
      const { properties: suiteProperties } = aggregateSuiteReports({ suite: suite.id, sites: sites[suite.id], reports: syntheticReports(sites[suite.id], seed, scale, expected), seed, scale, startedAt, baseline: expected })
      properties.push(...suiteProperties)
      suiteResults.push({ id: suite.id, kind: suite.kind, scale, testFiles: suite.testFiles, callSites: sites[suite.id].length, properties: suiteProperties.length, cases: suiteProperties.reduce((sum, property) => sum + property.runs, 0), durationMs: 1 })
    }
    validArtifact = composeDf1Artifact({ runId, seed, seedSource, scales, suites: suiteResults, properties, sourceManifest: await createDf1SourceManifest(repositoryRoot), gateStartedAt: startedAt, baseline })
  })

  after(async () => {
    await rm(artifactRoot, { recursive: true, force: true })
  })

  /** Writes one artifact into its own artifact root (always under this run ID's directory). */
  async function write(artifact, name) {
    const root = join(artifactRoot, name)
    const directory = join(root, runId, DF1_PHASE)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, DF1_ARTIFACT), `${JSON.stringify(artifact, null, 2)}\n`)
    return { root, path: join(directory, DF1_ARTIFACT) }
  }

  const load = ({ root }) => loadAndValidateDf1Evidence({ repositoryRoot, artifactRoot: root, runId, startedAt })

  it("accepts fresh, proven, complete evidence for this run", async () => {
    const { artifact } = await load(await write(validArtifact, "valid"))
    assert.equal(artifact.status, "proven")
  })

  it("refuses when the DF1 artifact is missing", async () => {
    await assert.rejects(load({ root: join(artifactRoot, "absent") }), refused(/no differential evidence/))
  })

  it("refuses evidence recorded for another run ID", async () => {
    await assert.rejects(load(await write({ ...validArtifact, runId: "some-other-run" }, "df1-self-test-foreign")), refused(/belongs to run some-other-run/))
  })

  it("refuses stale evidence", async () => {
    await assert.rejects(load(await write({ ...validArtifact, recordedAt: new Date(startedAt - 3_600_000).toISOString() }, "df1-self-test-stale")), refused(/predates this certification run/))
    const oldFile = await write(validArtifact, "old-file")
    const old = new Date(startedAt - 3_600_000)
    await utimes(oldFile.path, old, old)
    await assert.rejects(load(oldFile), refused(/predates this certification run/))
  })

  it("refuses evidence missing a property", async () => {
    const dropped = validArtifact.properties.find(property => property.suite === "core" && !property.name.includes("variant"))
    await assert.rejects(load(await write({ ...validArtifact, properties: validArtifact.properties.filter(property => property !== dropped) }, "df1-self-test-missing")), refused(/no passing evidence/))
    await assert.rejects(load(await write({ ...validArtifact, properties: validArtifact.properties.filter(property => property.suite !== "mysql") }, "df1-self-test-no-mysql")), refused(/mysql has no passing evidence/))
  })

  it("refuses unproven, under-volume, or reseeded evidence", async () => {
    await assert.rejects(load(await write({ ...validArtifact, status: "failed" }, "df1-self-test-unproven")), refused(/not proven/))
    await assert.rejects(load(await write({ ...validArtifact, scales: { ...scales, core: 1 } }, "df1-self-test-volume")), refused(/below the release minimum/))
    await assert.rejects(load(await write({ ...validArtifact, seed: (validArtifact.seed + 1) >>> 0 }, "df1-self-test-seed")), refused(/derived from the run ID/))
  })

  it("refuses a fixed DIFFERENTIAL_SEED in release evidence", async () => {
    await assert.rejects(load(await write({ ...validArtifact, seed: 42, seedSource: "DIFFERENTIAL_SEED" }, "df1-self-test-fixed-seed")), refused(/must use the seed derived from its run ID/))
  })

  it("refuses a scenario loop that lost an iteration", async () => {
    const template = validArtifact.properties.find(property => property.name.endsWith("variant 2"))
    assert.ok(template, "the baseline lists at least one template site expanding to two or more properties")
    await assert.rejects(load(await write({ ...validArtifact, properties: validArtifact.properties.filter(property => property !== template) }, "df1-self-test-lost-scenario")), refused(/fewer properties than the baseline/))
  })

  it("refuses a source manifest that is incomplete or no longer matches the sources", async () => {
    await assert.rejects(load(await write({ ...validArtifact, sourceManifest: validArtifact.sourceManifest.slice(1) }, "df1-self-test-partial")), refused(/does not cover exactly/))
    const tampered = validArtifact.sourceManifest.map((entry, index) => index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry)
    await assert.rejects(load(await write({ ...validArtifact, sourceManifest: tampered }, "df1-self-test-drift")), refused(/changed after the differential evidence was recorded/))
  })
})
