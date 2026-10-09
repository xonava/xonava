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
  aggregateSuiteReports,
  composeDf1Artifact,
  createDf1SourceManifest,
  deriveDf1Seed,
  df1Suites,
  loadAndValidateDf1Evidence,
  readPropertyReports,
  requiredCallSites,
  scanPropertyCallSites,
  suiteScale,
} from "./differentialCertification.mjs"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const scales = { ...DF1_MINIMUM_SCALES }
const refused = pattern => error => error instanceof Df1Refusal && pattern.test(error.message)

/** Synthetic passing reports for every call site (template names get several instances). */
function syntheticReports(sites, seed, scale) {
  const reports = []
  for (const site of sites) {
    const names = site.display.includes("${…}") ? [1, 2, 3, 4].map(variant => site.display.replaceAll("${…}", `variant ${variant}`)) : [site.display]
    for (const name of names) reports.push({ property: name, seed, scale, baseRuns: 100, runs: Math.round(100 * scale), replayRun: null, passed: true, recordedAt: new Date().toISOString() })
  }
  return reports
}

describe("DF1 property call-site scanning", () => {
  it("requires literal names exactly and template names by pattern", () => {
    const sites = scanPropertyCallSites([
      "forAll(\"plain law\", gen, check)",
      "await forAllAsync(`parity (${driver.label})`, gen, check)",
      "forAllAsync<Case>('typed', gen, check)",
      "other.forAll(\"not the harness\", gen, check)",
    ].join("\n"), "example.ts")
    assert.deepEqual(sites.map(site => site.display), ["plain law", "parity (${…})", "typed"])
    assert.ok(new RegExp(sites[1].pattern, "u").test("parity (PostgreSQL)"))
    assert.ok(!new RegExp(sites[1].pattern, "u").test("parity ()"))
  })

  it("refuses property names it cannot require", () => {
    assert.throws(() => scanPropertyCallSites("forAll(name, gen, check)", "dynamic.ts"), refused(/non-literal/))
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
})

describe("DF1 report aggregation", () => {
  const sites = [
    { location: "a.ts:1", display: "law one", pattern: "^law one$" },
    { location: "a.ts:2", display: "parity (${…})", pattern: "^parity \\(.+\\)$" },
  ]
  const base = { property: "law one", seed: 7, scale: 2, baseRuns: 100, runs: 200, replayRun: null, passed: true, recordedAt: new Date().toISOString() }
  const valid = [base, { ...base, property: "parity (PostgreSQL)" }, { ...base, property: "parity (PostgreSQL icu)" }]
  const aggregate = reports => aggregateSuiteReports({ suite: "unit", sites, reports, seed: 7, scale: 2, startedAt: Date.now() - 60_000 })

  it("accepts complete evidence", () => {
    assert.deepEqual(aggregate(valid).map(property => property.name), ["law one", "parity (PostgreSQL icu)", "parity (PostgreSQL)"])
  })

  it("refuses a missing property", () => {
    assert.throws(() => aggregate(valid.filter(report => report.property !== "law one")), refused(/no passing evidence for "law one"/))
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
  const startedAt = Date.now() - 60_000

  before(async () => {
    artifactRoot = await mkdtemp(join(tmpdir(), "df1-artifacts-"))
    const suites = await df1Suites(repositoryRoot)
    const sites = await requiredCallSites(repositoryRoot, suites)
    const { seed, seedSource } = deriveDf1Seed(runId)
    const properties = []
    const suiteResults = []
    for (const suite of suites) {
      const scale = suiteScale(suite, scales)
      const suiteProperties = aggregateSuiteReports({ suite: suite.id, sites: sites[suite.id], reports: syntheticReports(sites[suite.id], seed, scale), seed, scale, startedAt })
      properties.push(...suiteProperties)
      suiteResults.push({ id: suite.id, kind: suite.kind, scale, testFiles: suite.testFiles, callSites: sites[suite.id].length, properties: suiteProperties.length, cases: suiteProperties.reduce((sum, property) => sum + property.runs, 0), durationMs: 1 })
    }
    validArtifact = composeDf1Artifact({ runId, seed, seedSource, scales, suites: suiteResults, properties, sourceManifest: await createDf1SourceManifest(repositoryRoot), gateStartedAt: startedAt })
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

  it("refuses a source manifest that is incomplete or no longer matches the sources", async () => {
    await assert.rejects(load(await write({ ...validArtifact, sourceManifest: validArtifact.sourceManifest.slice(1) }, "df1-self-test-partial")), refused(/does not cover exactly/))
    const tampered = validArtifact.sourceManifest.map((entry, index) => index === 0 ? { ...entry, sha256: "0".repeat(64) } : entry)
    await assert.rejects(load(await write({ ...validArtifact, sourceManifest: tampered }, "df1-self-test-drift")), refused(/changed after the differential evidence was recorded/))
  })
})
