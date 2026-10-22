import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { loadConformanceVectors } from "../src/spec/conformanceVectors"

const validVector = { id: "vector-1", kind: "canonical-json", formatVersion: 1, input: { b: 1, a: 2 }, expected: "{\"a\":2,\"b\":1}" }

let root = ""
let caseCounter = 0

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "xonava-vectors-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Writes one vector file (or raw text) into a fresh directory and returns that directory. */
async function vectorDirectory(files: Record<string, unknown>): Promise<string> {
  const directory = join(root, `case-${++caseCounter}`)
  await mkdir(directory, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), typeof content === "string" ? content : JSON.stringify(content), "utf8")
  }
  return directory
}

function suiteFile(overrides: Record<string, unknown> = {}, vectors: unknown[] = [validVector]): Record<string, unknown> {
  return {
    schema: "framework.conformance-vectors",
    schemaVersion: 1,
    suiteId: "suite-under-test",
    suiteVersion: 1,
    vectors,
    ...overrides,
  }
}

describe("loadConformanceVectors", () => {
  it("returns an empty list when the vector directory does not exist", () => {
    expect(loadConformanceVectors(join(root, "does-not-exist"))).toEqual([])
  })

  it("loads each JSON suite sorted by suite id and ignores other files", async () => {
    const directory = await vectorDirectory({
      "zeta.json": suiteFile({ suiteId: "zeta" }),
      "alpha.json": suiteFile({ suiteId: "alpha", suiteVersion: 3 }),
      "notes.txt": "not a vector file",
    })
    const suites = loadConformanceVectors(directory)
    expect(suites.map((suite) => suite.suiteId)).toEqual(["alpha", "zeta"])
    expect(suites[0]).toEqual({ suiteId: "alpha", suiteVersion: 3, vectors: [validVector] })
  })

  it("accepts optional lowercase hexadecimal byte and digest fields", async () => {
    const withDigests = {
      ...validVector,
      id: "vector-digest",
      kind: "fingerprint",
      expectedUtf8Hex: "616263",
      expectedSha256: "a".repeat(64),
    }
    const suites = loadConformanceVectors(await vectorDirectory({ "digests.json": suiteFile({}, [withDigests]) }))
    expect(suites[0]?.vectors).toEqual([withDigests])
  })

  it.each<[string, Record<string, unknown> | string, string]>([
    ["a file that is not a JSON object", "[]", "conformance vector file must be a JSON object"],
    ["an unexpected schema", suiteFile({ schema: "other" }), "unexpected schema other"],
    ["an unsupported schema version", suiteFile({ schemaVersion: 2 }), "unsupported schemaVersion 2"],
    ["an empty suite id", suiteFile({ suiteId: "" }), "suiteId must be a non-empty string"],
    ["a zero suite version", suiteFile({ suiteVersion: 0 }), "suiteVersion must be a positive integer"],
    ["a fractional suite version", suiteFile({ suiteVersion: 1.5 }), "suiteVersion must be a positive integer"],
    ["a non-array vector list", suiteFile({ vectors: "nope" }), "vectors must be an array"],
    ["a vector that is not an object", suiteFile({}, ["text"]), "each vector must be an object"],
    ["an empty vector id", suiteFile({}, [{ ...validVector, id: "" }]), "vector id must be a non-empty string"],
    ["a duplicate vector id", suiteFile({}, [validVector, { ...validVector }]), "duplicate vector id vector-1"],
    ["an unknown vector kind", suiteFile({}, [{ ...validVector, kind: "bogus" }]), "vector vector-1 has unknown kind bogus"],
    ["a zero format version", suiteFile({}, [{ ...validVector, formatVersion: 0 }]), "formatVersion must be a positive integer"],
    ["uppercase hexadecimal bytes", suiteFile({}, [{ ...validVector, expectedUtf8Hex: "ABCD" }]), "expectedUtf8Hex must be lowercase hexadecimal"],
    ["odd-length hexadecimal bytes", suiteFile({}, [{ ...validVector, expectedUtf8Hex: "abc" }]), "expectedUtf8Hex must be lowercase hexadecimal"],
    ["a non-hexadecimal digest", suiteFile({}, [{ ...validVector, expectedSha256: "z".repeat(64) }]), "expectedSha256 must be lowercase hexadecimal"],
    ["a digest of the wrong length", suiteFile({}, [{ ...validVector, expectedSha256: "ab".repeat(31) }]), "expectedSha256 must contain 32 bytes"],
  ])("rejects a suite with %s", async (_label, content, message) => {
    const directory = await vectorDirectory({ "bad.json": content })
    expect(() => loadConformanceVectors(directory)).toThrow(message)
  })
})
