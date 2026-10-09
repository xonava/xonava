import { describe, expect, it } from "vitest"
import { CanonicalJsonError, canonicalJsonString, canonicalSha256Hex, canonicalizeValue, decodeCanonicalJson, legacyJavaScriptOrderJsonString } from "../../serialization/canonicalJson"
import { sha256Hex } from "../../serialization/sha256"
import { createEnvelope, parseEnvelope } from "../../serialization/formatEnvelope"
import { createVersionedCodec, decodeFromString } from "../../serialization/versionedCodec"
import { buildKey } from "../../cache/cache"
import { encodeQuotaSubject } from "../../quota/quota"
import { sequencePeriod } from "../../sequence/sequence"
import { encodeCursor, type CursorIntegrityPort } from "../../query/cursorCodec"
import type { CursorPayloadV1 } from "../../query/cursor"
import { ConfigurationError, ValidationError } from "../../domain/errors"
import { defaultEntityNamespace } from "../../entity/compileEntity"
import { JOB_FINGERPRINT_VERSION, fingerprintJob, jobFingerprintMatches, type JobFingerprintInput } from "../../execution/jobFingerprint"

/** Minimal counterexamples found by the encoding property suites, pinned after their fixes. */
describe("encoding regressions", () => {
  it("canonical JSON orders integer-like keys by UTF-16 code units (RFC 8785), not JavaScript property order", () => {
    // Found by "canonical vs JCS model": JSON.stringify of the canonical object wrote {"9":..,"10":..}.
    expect(canonicalJsonString({ "9": 2, "10": 1 })).toBe("{\"10\":1,\"9\":2}")
    expect(canonicalJsonString({ b: 1, "2": 1, "10": 1, a: { "1": 0, "01": 0 } })).toBe("{\"10\":1,\"2\":1,\"a\":{\"01\":0,\"1\":0},\"b\":1}")
    expect(canonicalSha256Hex({ "9": 2, "10": 1 })).toBe(sha256Hex(new TextEncoder().encode("{\"10\":1,\"9\":2}")))
    expect(canonicalJsonString(decodeCanonicalJson("{\"9\":2,\"10\":1}"))).toBe("{\"10\":1,\"9\":2}")
  })

  it("buildKey reports a lone surrogate as a canonicalization error instead of a raw URIError", () => {
    expect(() => buildKey("a\ud800", "scope", "suffix")).toThrow(CanonicalJsonError)
  })

  it("quota subjects with lone surrogates fail validation instead of throwing URIError", () => {
    const scope = { kind: "tenant", tenantId: "t1" } as const
    expect(() => encodeQuotaSubject({ scope, principal: { kind: "human", id: "\ud800" } })).toThrow(ValidationError)
    expect(() => encodeQuotaSubject({ scope, planKey: "pro\udc00" })).toThrow(ValidationError)
  })

  it("sequence periods never alias a BCE year onto the CE year with the same number", () => {
    const bce = new Date(Date.UTC(2000, 5, 1))
    bce.setUTCFullYear(-43) // 44 BCE, which Intl formats as era year "44"
    const ce = new Date(Date.UTC(2000, 5, 1))
    ce.setUTCFullYear(44)
    expect(sequencePeriod("year", ce)).toBe("0044")
    expect(() => sequencePeriod("year", bce)).toThrow(ConfigurationError)
  })

  it("durable envelopes must carry a payload and no unknown members", () => {
    expect(() => parseEnvelope({ format: "framework.test", version: 1 })).toThrow(CanonicalJsonError)
    expect(() => parseEnvelope({ format: "framework.test", version: 1, payload: null, extra: 1 })).toThrow(CanonicalJsonError)
    const codec = createVersionedCodec<unknown>({ format: "framework.test", currentVersion: 1, readableVersions: [1], encode: (value) => value as null, decode: (value) => value })
    expect(() => decodeFromString(codec, "{\"format\":\"framework.test\",\"version\":1}")).toThrow(CanonicalJsonError)
    expect(decodeFromString(codec, "{\"format\":\"framework.test\",\"payload\":null,\"version\":1}")).toBeNull()
  })

  it("cursor direction must be the string itself, not anything whose String() matches", async () => {
    const integrity: CursorIntegrityPort = { sign: async () => new Uint8Array([1]), verify: async () => true }
    const payload = { format: "framework.cursor", version: 1, direction: ["after"], values: [], routeHash: "r", queryHash: "q", scopeHash: "s", sortHash: "o" }
    await expect(encodeCursor(payload as unknown as CursorPayloadV1, integrity)).rejects.toThrow(ValidationError)
  })

  it("createEnvelope rejects an undefined payload (JSON would silently drop the member)", () => {
    expect(() => createEnvelope("framework.test", 1, undefined)).toThrow(CanonicalJsonError)
    expect(createEnvelope("framework.test", 1, null)).toEqual({ format: "framework.test", version: 1, payload: null })
  })
})

describe("fingerprint compatibility across the RFC 8785 key-order fix", () => {
  const numericKeyed = { "10": "ten", "9": "nine", a: { "2": 0, "11": 1 } }

  it("keeps the pre-fix JavaScript-order serializer for compatibility checks only", () => {
    expect(legacyJavaScriptOrderJsonString(numericKeyed)).toBe(JSON.stringify(canonicalizeValue(numericKeyed)))
    expect(legacyJavaScriptOrderJsonString(numericKeyed)).not.toBe(canonicalJsonString(numericKeyed))
    // Same validation as canonical JSON: it is not a general-purpose escape hatch.
    expect(() => legacyJavaScriptOrderJsonString({ at: new Date(0) })).toThrow(CanonicalJsonError)
  })

  const input: JobFingerprintInput = {
    executionScope: { kind: "tenant", tenantId: "t1" }, jobType: "billing.sync", jobVersion: 1, payload: numericKeyed,
    runAt: new Date("2026-01-01T00:00:00.000Z"), maxAttempts: 3, priority: 0, correlationId: null, partitionKey: null, metadata: null,
  }
  /** What version 3 persisted: sha256 of the JavaScript-order serialization of { version: 3, job }. */
  const storedV3 = async (job: JobFingerprintInput): Promise<string> => {
    const text = JSON.stringify(canonicalizeValue({ version: 3, job: { ...job, runAt: job.runAt.toISOString() } }))
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("")
  }

  it("bumps the job fingerprint version and still matches a version-3 fingerprint of the same job", async () => {
    expect(JOB_FINGERPRINT_VERSION).toBe(4)
    const legacy = await storedV3(input)
    expect(await fingerprintJob(input)).not.toBe(legacy)
    await expect(jobFingerprintMatches(await fingerprintJob(input), input)).resolves.toBe(true)
    await expect(jobFingerprintMatches(legacy, input)).resolves.toBe(true)
    await expect(jobFingerprintMatches(await storedV3({ ...input, jobType: "billing.other" }), input)).resolves.toBe(false)
    await expect(jobFingerprintMatches("", input)).resolves.toBe(false)
  })
})

describe("default entity namespace", () => {
  it("keeps `module:name` for entities without a persistence namespace (pre-existing idempotency namespaces)", () => {
    expect(defaultEntityNamespace("billing", { name: "invoice" })).toBe("billing:invoice")
    expect(defaultEntityNamespace("billing", { name: "invoice", namespace: "" })).toBe("billing:invoice")
    expect(defaultEntityNamespace("billing", { name: "invoice", namespace: "eu" })).toBe("billing:eu:invoice")
  })
})
