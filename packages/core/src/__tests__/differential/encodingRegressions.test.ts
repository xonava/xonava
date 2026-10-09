import { describe, expect, it } from "vitest"
import { CanonicalJsonError, canonicalJsonString, canonicalSha256Hex, decodeCanonicalJson } from "../../serialization/canonicalJson"
import { sha256Hex } from "../../serialization/sha256"
import { parseEnvelope } from "../../serialization/formatEnvelope"
import { createVersionedCodec, decodeFromString } from "../../serialization/versionedCodec"
import { buildKey } from "../../cache/cache"
import { encodeQuotaSubject } from "../../quota/quota"
import { sequencePeriod } from "../../sequence/sequence"
import { encodeCursor, type CursorIntegrityPort } from "../../query/cursorCodec"
import type { CursorPayloadV1 } from "../../query/cursor"
import { ConfigurationError, ValidationError } from "../../domain/errors"

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
})
