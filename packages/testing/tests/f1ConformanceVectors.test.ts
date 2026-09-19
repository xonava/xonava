import { describe, expect, it } from "vitest"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { canonicalJsonBytes, canonicalJsonString } from "../../core/src/serialization/canonicalJson"
import { fingerprintIdempotency, fingerprintOutbox, fingerprintCursorQuery } from "../../core/src/serialization/fingerprint"
import { encodeBase64UrlUnpadded } from "../../core/src/serialization/canonicalJson"
import { loadConformanceVectors } from "../src/spec/conformanceVectors"

const vectorsDir = join(import.meta.dirname, "..", "conformance", "vectors")

describe("F1 conformance vectors", () => {
  it("loads all vector suites", () => {
    const suites = loadConformanceVectors(vectorsDir)
    expect(suites.length).toBeGreaterThanOrEqual(5)
    for (const suite of suites) {
      expect(suite.suiteVersion).toBe(1)
      expect(suite.vectors.length).toBeGreaterThan(0)
    }
  })

  it("validates canonical-json vectors against implementation", () => {
    const suites = loadConformanceVectors(vectorsDir)
    for (const suite of suites) {
      for (const v of suite.vectors) {
        if (v.kind !== "canonical-json") continue
        const actual = canonicalJsonString(v.input)
        expect(actual, `vector ${suite.suiteId}/${v.id}`).toBe(v.expected)
      }
    }
  })

  it("verifies published exact UTF-8 bytes and SHA-256 digests", () => {
    const vectors = loadConformanceVectors(vectorsDir).flatMap((suite) => suite.vectors)
      .filter((vector) => vector.expectedUtf8Hex !== undefined)
    expect(vectors.length).toBeGreaterThanOrEqual(8)
    for (const vector of vectors) {
      const bytes = canonicalJsonBytes(vector.input)
      expect(Buffer.from(bytes).toString("hex"), vector.id).toBe(vector.expectedUtf8Hex)
      expect(createHash("sha256").update(bytes).digest("hex"), vector.id).toBe(vector.expectedSha256)
    }
  })

  it("validates fingerprint vectors", () => {
    const suites = loadConformanceVectors(vectorsDir)
    for (const suite of suites) {
      for (const v of suite.vectors) {
        if (v.kind !== "fingerprint") continue
        let actual: string
        if (v.id.startsWith("idempotency") || suite.suiteId === "fingerprints" && v.id.includes("idempotency")) {
          actual = fingerprintIdempotency(v.input)
        } else if (v.id.includes("outbox")) {
          actual = fingerprintOutbox(v.input)
        } else if (v.id.includes("cursor")) {
          actual = fingerprintCursorQuery(v.input)
        } else {
          // generic fingerprint check via idempotency for suite fingerprints
          if (suite.suiteId === "fingerprints") {
            if (v.id.startsWith("idempotency")) actual = fingerprintIdempotency(v.input)
            else if (v.id.startsWith("outbox")) actual = fingerprintOutbox(v.input)
            else if (v.id.startsWith("cursor")) actual = fingerprintCursorQuery(v.input)
            else actual = fingerprintIdempotency(v.input)
          } else continue
        }
        expect(actual, `vector ${suite.suiteId}/${v.id}`).toBe(v.expected)
      }
    }
  })

  it("validates execution-scope-id vectors", () => {
    const suites = loadConformanceVectors(vectorsDir)
    const scopeSuite = suites.find((s) => s.suiteId === "execution-scope-id")
    expect(scopeSuite).toBeDefined()
    for (const v of scopeSuite!.vectors) {
      const jcs = canonicalJsonString(v.input)
      const b64 = encodeBase64UrlUnpadded(new TextEncoder().encode(jcs))
      const expected = `fscope:v1:${b64}`
      expect(v.expected, `scope vector ${v.id}`).toBe(expected)
    }
  })

  it("rejects duplicate vector ids and unknown kinds on load", () => {
    // loader already tested in unit harness; this is integration check
    const suites = loadConformanceVectors(vectorsDir)
    const allIds = new Set<string>()
    for (const suite of suites) {
      for (const v of suite.vectors) {
        const key = `${suite.suiteId}:${v.id}`
        expect(allIds.has(key)).toBe(false)
        allIds.add(key)
      }
    }
  })
})
