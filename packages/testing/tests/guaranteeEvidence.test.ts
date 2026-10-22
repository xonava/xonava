import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { writeCrashEvidence, writeGuaranteeEvidence } from "../src/conformance/guaranteeEvidence"

// The writers resolve evidence relative to process.cwd(), so every case runs from a throwaway
// directory two levels below the evidence root. The repository's real artifacts/ tree is never touched.
const runId = `vitest-evidence-${process.pid}`
const phase = "f2-unit"
let sandbox = ""
let originalCwd = ""
let evidenceRoot = ""

beforeAll(async () => {
  originalCwd = process.cwd()
  sandbox = await mkdtemp(resolve(tmpdir(), "xonava-evidence-"))
  const workDirectory = resolve(sandbox, "pkg", "nested")
  await mkdir(workDirectory, { recursive: true })
  process.chdir(workDirectory)
  evidenceRoot = resolve(sandbox, "artifacts", "framework-conformance")
})

afterAll(async () => {
  process.chdir(originalCwd)
  await rm(sandbox, { recursive: true, force: true })
})

async function withEnv<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await action()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

const configured = { FRAMEWORK_CONFORMANCE_RUN_ID: runId, FRAMEWORK_CONFORMANCE_PHASE: phase }

describe("guarantee evidence writers", () => {
  it("writes proven guarantee records under the configured run and phase", async () => {
    const path = await withEnv(configured, () => writeGuaranteeEvidence("pg", "suite-a", ["outbox.atomic", "audit.atomic"], 7))
    expect(path).toBe(resolve(evidenceRoot, runId, phase, "pg-guarantees.json"))
    const document = await readJson(path)
    expect(document).toMatchObject({ schemaVersion: 1, runId, adapter: "pg" })
    const records = document.records as Array<Record<string, unknown>>
    expect(records.map((record) => record.guaranteeId)).toEqual(["outbox.atomic", "audit.atomic"])
    for (const record of records) {
      expect(record).toMatchObject({ adapter: "pg", status: "proven", suite: "suite-a", assertions: 7 })
      expect(String(record.sourceDigest)).toMatch(/^[0-9a-f]{64}$/)
      expect(Number.isNaN(Date.parse(String(record.recordedAt)))).toBe(false)
    }
  })

  it("derives the source digest from adapter, suite and guarantee list", async () => {
    const digestOf = async (path: string) => ((await readJson(path)).records as Array<{ sourceDigest: string }>)[0]?.sourceDigest
    const original = await digestOf(await withEnv(configured, () => writeGuaranteeEvidence("d1", "suite-b", ["g.one"], 1)))
    const sameInputs = await digestOf(await withEnv(configured, () => writeGuaranteeEvidence("d1", "suite-b", ["g.one"], 9)))
    const otherGuarantee = await digestOf(await withEnv(configured, () => writeGuaranteeEvidence("d1", "suite-b", ["g.two"], 1)))
    expect(sameInputs).toBe(original)
    expect(otherGuarantee).not.toBe(original)
  })

  it("marks crash evidence proven only after twenty repetitions", async () => {
    const proven = await withEnv(configured, () => writeCrashEvidence("mysql", ["after-commit"], 20))
    expect(proven).toBe(resolve(evidenceRoot, runId, phase, "mysql-crash-replay.json"))
    expect(await readJson(proven)).toMatchObject({
      schemaVersion: 1,
      runId,
      adapter: "mysql",
      status: "proven",
      processIsolation: true,
      freshVerifier: true,
      repetitions: 20,
      requiredRepetitions: 20,
      failpoints: [{ name: "after-commit", status: "proven", partialCommitViolations: 0 }],
    })

    const incomplete = await withEnv(configured, () => writeCrashEvidence("pg", ["before-commit", "after-lease"], 19))
    expect(await readJson(incomplete)).toMatchObject({
      status: "incomplete",
      repetitions: 19,
      failpoints: [
        { name: "before-commit", status: "incomplete", partialCommitViolations: 0 },
        { name: "after-lease", status: "incomplete", partialCommitViolations: 0 },
      ],
    })
  })

  it("falls back to the local-latest run and f2 phase when the environment does not set them", async () => {
    const path = await withEnv({ FRAMEWORK_CONFORMANCE_RUN_ID: undefined, FRAMEWORK_CONFORMANCE_PHASE: undefined }, () =>
      writeCrashEvidence("d1", [], 0),
    )
    expect(path).toBe(resolve(evidenceRoot, "local-latest", "f2", "d1-crash-replay.json"))
    expect(await readJson(path)).toMatchObject({ runId: "local-latest", status: "incomplete", failpoints: [] })
  })
})
