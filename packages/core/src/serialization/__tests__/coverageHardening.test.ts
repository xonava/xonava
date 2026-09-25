import { describe, expect, it } from "vitest"
import { ConfigurationError, ValidationError } from "../../domain/errors"
import {
  assertEnvelopeVersionSupported,
  assertReadableVersion,
  createEnvelope,
  isEnvelopeReadable,
  isReadableVersion,
  isValidFormatId,
  isValidVersion,
  isVersionSupported,
  parseEnvelope,
  validateEnvelope,
} from "../formatEnvelope"
import {
  assertDurableRoundTrip,
  decodeDurableValue,
  encodeDurableValue,
  resolveDurableCodec,
  type DurableCodec,
} from "../durableCodec"
import {
  assertCodecReadable,
  createVersionedCodec,
  decodeWithCodec,
  encodeWithCodec,
  isCodecVersionReadable,
} from "../versionedCodec"
import { canonicalJsonString, CanonicalJsonError } from "../canonicalJson"

describe("durable serialization defensive branches", () => {
  it("rejects accessors and sparse arrays without executing inherited values", () => {
    let reads = 0
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get() { reads++; return "secret" } })
    const sparse = new Array(1)

    expect(() => canonicalJsonString(accessor)).toThrow(/accessors/)
    expect(reads).toBe(0)
    expect(() => canonicalJsonString(sparse)).toThrow(/dense/)
  })

  it("validates format identifiers and versions at their boundaries", () => {
    expect(isValidFormatId("a.b-c_1")).toBe(true)
    expect(isValidFormatId("" )).toBe(false)
    expect(isValidFormatId("A")).toBe(false)
    expect(isValidFormatId("a".repeat(257))).toBe(false)
    expect(isValidFormatId(1 as never)).toBe(false)
    expect(isValidVersion(1)).toBe(true)
    expect(isValidVersion(0)).toBe(false)
    expect(isValidVersion(1.5)).toBe(false)
    expect(isValidVersion(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
  })

  it("validates readable versions with and without a format label", () => {
    expect(isReadableVersion(2, [1, 2])).toBe(true)
    expect(isVersionSupported(3, [1, 2])).toBe(false)
    expect(() => assertReadableVersion(0, [1])).toThrow(CanonicalJsonError)
    expect(() => assertReadableVersion(2, [1])).toThrow(/readable versions/)
    expect(() => assertReadableVersion(2, [1], "framework.test")).toThrow(/framework.test/)
    const envelope = { format: "framework.test", version: 1 }
    expect(isEnvelopeReadable(envelope, [1])).toBe(true)
    expect(() => assertEnvelopeVersionSupported(envelope, [2])).toThrow(CanonicalJsonError)
  })

  it("rejects obsolete version aliases and exotic envelopes", () => {
    expect(() => parseEnvelope({ format: "framework.test", formatVersion: 2, payload: "obsolete" })).toThrow(/version/)
    expect(parseEnvelope({ format: "framework.test", version: 2, payload: null }).version).toBe(2)
    expect(() => parseEnvelope([])).toThrow(/plain object/)
    expect(() => parseEnvelope(new Date())).toThrow(/plain object/)
    expect(() => parseEnvelope({ format: 1, version: 1 })).toThrow(/format/)
    expect(() => parseEnvelope({ format: "framework.test", version: "1" })).toThrow(/version/)
    const envelope = createEnvelope("framework.test", 1, { ok: true })
    expect(() => validateEnvelope(envelope)).not.toThrow()
  })

  it("fails closed for absent and failing durable codecs", () => {
    const codec: DurableCodec<number, string> = {
      key: "number",
      encode: value => String(value),
      decode: value => Number(value),
    }
    const registry = { number: codec }
    expect(resolveDurableCodec(registry, "number")).toBe(codec)
    expect(() => resolveDurableCodec(registry, "missing")).toThrow(ConfigurationError)
    expect(encodeDurableValue(registry, "number", 7)).toEqual({ codec: "number", value: "7" })
    expect(decodeDurableValue(registry, { codec: "number", value: "8" })).toBe(8)
    expect(() => assertDurableRoundTrip({ key: "encode", encode: () => { throw new Error("secret") }, decode: value => value }, 1)).toThrow(ValidationError)
    expect(() => assertDurableRoundTrip({ key: "decode", encode: value => value, decode: () => { throw new Error("secret") } }, 1)).toThrow(ValidationError)
    expect(() => assertDurableRoundTrip(codec, 1)).not.toThrow()
  })

  it("rejects every malformed versioned codec configuration and exercises helper APIs", () => {
    const base = { format: "framework.test", currentVersion: 1, readableVersions: [1], encode: (value: string) => value, decode: (value: unknown) => String(value) }
    expect(() => createVersionedCodec({ ...base, format: "INVALID" })).toThrow(/format/)
    expect(() => createVersionedCodec({ ...base, currentVersion: 0 })).toThrow(/currentVersion/)
    expect(() => createVersionedCodec({ ...base, readableVersions: [] })).toThrow(/non-empty/)
    expect(() => createVersionedCodec({ ...base, readableVersions: [0, 1] })).toThrow(/readableVersion/)
    expect(() => createVersionedCodec({ ...base, currentVersion: 2 })).toThrow(/include currentVersion/)
    expect(() => createVersionedCodec({ ...base, encode: undefined as never })).toThrow(/must be functions/)
    expect(() => createVersionedCodec({ ...base, decode: undefined as never })).toThrow(/must be functions/)
    const codec = createVersionedCodec(base)
    const encoded = encodeWithCodec(codec, "value")
    expect(decodeWithCodec(codec, encoded)).toBe("value")
    expect(isCodecVersionReadable(codec, 1)).toBe(true)
    expect(isCodecVersionReadable(codec, 2)).toBe(false)
    expect(() => assertCodecReadable(codec, 1)).not.toThrow()
    expect(() => assertCodecReadable(codec, 2)).toThrow(/unsupported version/)
    expect(() => decodeWithCodec(codec, createEnvelope("framework.other", 1, "value"))).toThrow(/format mismatch/)
  })
})
