import { describe, expect, it } from "vitest"
import { CanonicalJsonError, decodeCanonicalJson } from "../canonicalJson"
import { COMPILED_DURABLE_FORMAT_REGISTRY_V1, assertEnvelopeSupported, assertFormatSupported, ensureRegistryValid, getCompiledFormat, getFormatDefaultMaxBytes, getFormatRegistration, getReadableVersions, isFormatVersionReadable, listCompiledFormats, listFormats, validateRegistry } from "../formatRegistry"

describe("durable registry coverage", () => {
  it("exposes immutable compiled registry read APIs", () => {
    expect(listFormats()).toBe(COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries)
    expect(listCompiledFormats()).toBe(COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries)
    const event = getFormatRegistration("framework.event-envelope")
    expect(event).toBeDefined()
    expect(getCompiledFormat("framework.event-envelope")?.readableVersions).toEqual([1])
    expect(getReadableVersions("unknown")).toBeUndefined()
    expect(isFormatVersionReadable("unknown", 1)).toBe(false)
    expect(isFormatVersionReadable("framework.event-envelope", 1)).toBe(true)
    expect(getFormatDefaultMaxBytes("unknown")).toBeUndefined()
    expect(() => ensureRegistryValid()).not.toThrow()
    expect(() => ensureRegistryValid()).not.toThrow()
  })

  it("rejects every malformed registry and unsupported format path", () => {
    const valid = { formatId: "framework.test", formatVersion: 1, kind: "framework-envelope" as const }
    expect(() => validateRegistry([{ ...valid, formatId: "INVALID" }])).toThrow(/formatId/)
    expect(() => validateRegistry([valid, valid])).toThrow(/duplicate/)
    expect(() => validateRegistry([{ ...valid, formatVersion: 0 }])).toThrow(/formatVersion/)
    expect(() => validateRegistry([{ ...valid, kind: "other" as never }])).toThrow(/kind/)
    expect(() => assertFormatSupported("INVALID", 1)).toThrow(CanonicalJsonError)
    expect(() => assertFormatSupported("framework.event-envelope", 0)).toThrow(CanonicalJsonError)
    expect(() => assertFormatSupported("framework.unknown", 1)).toThrow(/unsupported durable format/)
    expect(() => assertFormatSupported("framework.event-envelope", 2)).toThrow(/unsupported version/)
    expect(() => assertEnvelopeSupported({ format: "framework.event-envelope", version: 1 })).not.toThrow()
  })
})

describe("canonical JSON parser rejection coverage", () => {
  it.each(["", " ", "tru", "nul", "01", "-", "1.", "1e", "[1,]", "[1 2]", "[", "{", "{a:1}", '{"a" 1}', '{"a":1,}', "true false", '"unterminated', '"\\x"', '"\\u12xz"', '"line\nfeed"'])("rejects malformed JSON %j", value => {
    expect(() => decodeCanonicalJson(value)).toThrow(CanonicalJsonError)
  })

  it("decodes all standard escape and number forms", () => {
    expect(decodeCanonicalJson('"\\b\\f\\n\\r\\t\\/\\\\\\\""')).toBe("\b\f\n\r\t/\\\"")
    expect(decodeCanonicalJson("[-0,1.25,1e2,-2E-1,true,false,null]")).toEqual([0, 1.25, 100, -0.2, true, false, null])
    expect(() => decodeCanonicalJson(1 as never)).toThrow(/expects string/)
    expect(() => decodeCanonicalJson(new Uint8Array([0xff]))).toThrow(/UTF-8/)
  })
})
