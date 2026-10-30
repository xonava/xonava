import { describe, expect, it } from "vitest"
import { SERIALIZATION_LIMIT_EXCEEDED_ERROR } from "../../spec/formatVersions"
import { CanonicalJsonError } from "../canonicalJson"
import {
  INVALID_ENVELOPE_ERROR,
  UNSUPPORTED_FORMAT_ERROR,
  UNSUPPORTED_FORMAT_VERSION_ERROR,
} from "../formatEnvelope"
import {
  assertCodecReadable,
  createVersionedCodec,
  decodeFromBytes,
  decodeFromString,
  decodeWithCodec,
  encodeToBytes,
  encodeToString,
  encodeWithCodec,
  isCodecVersionReadable,
  type JsonValue,
  type VersionedCodecConfig,
} from "../versionedCodec"

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function expectCanonicalError(fn: () => unknown, message: string, code: string): void {
  const error = caught(fn)
  expect(error).toBeInstanceOf(CanonicalJsonError)
  expect((error as CanonicalJsonError).message).toBe(message)
  expect((error as CanonicalJsonError).code).toBe(code)
}

const SCOPE = "framework.execution-scope-id" // default limit 4096 bytes
const SCOPE_LIMIT = 4096
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

const stringCodec = (format: string) =>
  createVersionedCodec<string>({ format, currentVersion: 1, readableVersions: [1], encode: (value) => value, decode: (encoded) => encoded as string })

/** A string payload that makes the canonical envelope exactly `total` bytes long. */
function payloadForTotal(format: string, total: number): string {
  const empty = utf8(JSON.stringify({ format, payload: "", version: 1 })).byteLength
  return "x".repeat(total - empty)
}

function baseConfig(overrides: Partial<VersionedCodecConfig<string>> = {}): VersionedCodecConfig<string> {
  return { format: "app.thing", currentVersion: 1, readableVersions: [1], encode: (value) => value, decode: (encoded) => encoded as string, ...overrides }
}

describe("createVersionedCodec configuration checks", () => {
  it("rejects an invalid format", () => {
    expectCanonicalError(() => createVersionedCodec(baseConfig({ format: "Bad" })), 'invalid codec format "Bad"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => createVersionedCodec(baseConfig({ format: 5 as never })), "invalid codec format 5", INVALID_ENVELOPE_ERROR)
  })

  it("rejects an invalid current version", () => {
    expectCanonicalError(() => createVersionedCodec(baseConfig({ currentVersion: 0 })), "invalid codec currentVersion 0", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => createVersionedCodec(baseConfig({ currentVersion: 1.5 })), "invalid codec currentVersion 1.5", INVALID_ENVELOPE_ERROR)
  })

  it("rejects empty and invalid readable versions", () => {
    expectCanonicalError(() => createVersionedCodec(baseConfig({ readableVersions: [] })), "readableVersions must be non-empty", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(
      () => createVersionedCodec(baseConfig({ readableVersions: [1, 0], decodesEveryReadableVersion: true })),
      "invalid readableVersion 0",
      INVALID_ENVELOPE_ERROR,
    )
    expectCanonicalError(
      () => createVersionedCodec(baseConfig({ readableVersions: [1, 2.5], decodesEveryReadableVersion: true })),
      "invalid readableVersion 2.5",
      INVALID_ENVELOPE_ERROR,
    )
    expectCanonicalError(() => createVersionedCodec(baseConfig({ readableVersions: [-3] })), "invalid readableVersion -3", INVALID_ENVELOPE_ERROR)
  })

  it("requires the current version to be readable", () => {
    expectCanonicalError(
      () => createVersionedCodec(baseConfig({ currentVersion: 2, readableVersions: [1] })),
      "readableVersions must include currentVersion 2",
      INVALID_ENVELOPE_ERROR,
    )
  })

  it("requires encode and decode functions", () => {
    expectCanonicalError(() => createVersionedCodec(baseConfig({ encode: undefined as never })), "codec encode/decode must be functions", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => createVersionedCodec(baseConfig({ decode: "x" as never })), "codec encode/decode must be functions", INVALID_ENVELOPE_ERROR)
  })

  it("requires decodesEveryReadableVersion for distinct multiple readable versions", () => {
    const message = "a codec with several readableVersions must set decodesEveryReadableVersion and decode by version"
    expectCanonicalError(() => createVersionedCodec(baseConfig({ currentVersion: 2, readableVersions: [1, 2] })), message, INVALID_ENVELOPE_ERROR)
    expectCanonicalError(
      () => createVersionedCodec(baseConfig({ currentVersion: 2, readableVersions: [1, 2], decodesEveryReadableVersion: false })),
      message,
      INVALID_ENVELOPE_ERROR,
    )
    expect(createVersionedCodec(baseConfig({ currentVersion: 2, readableVersions: [1, 2], decodesEveryReadableVersion: true })).readableVersions).toEqual([1, 2])
    // duplicates of one version are not "several"
    expect(createVersionedCodec(baseConfig({ readableVersions: [1, 1] })).readableVersions).toEqual([1, 1])
  })

  it("checks configuration in a fixed order", () => {
    expectCanonicalError(() => createVersionedCodec(baseConfig({ format: "Bad", currentVersion: 0 })), 'invalid codec format "Bad"', INVALID_ENVELOPE_ERROR)
    expectCanonicalError(() => createVersionedCodec(baseConfig({ currentVersion: 0, readableVersions: [] })), "invalid codec currentVersion 0", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(
      () => createVersionedCodec(baseConfig({ readableVersions: [], encode: undefined as never })),
      "readableVersions must be non-empty",
      INVALID_ENVELOPE_ERROR,
    )
    expectCanonicalError(
      () => createVersionedCodec(baseConfig({ readableVersions: [1, 0], currentVersion: 2 })),
      "invalid readableVersion 0",
      INVALID_ENVELOPE_ERROR,
    )
    expectCanonicalError(
      () => createVersionedCodec(baseConfig({ currentVersion: 2, readableVersions: [1, 3], encode: undefined as never })),
      "readableVersions must include currentVersion 2",
      INVALID_ENVELOPE_ERROR,
    )
    expectCanonicalError(
      () => createVersionedCodec(baseConfig({ currentVersion: 1, readableVersions: [1, 3], encode: undefined as never })),
      "codec encode/decode must be functions",
      INVALID_ENVELOPE_ERROR,
    )
  })
})

describe("createVersionedCodec behaviour", () => {
  it("exposes a frozen codec with a defensive copy of readable versions", () => {
    const readable = [1, 2]
    const codec = createVersionedCodec(baseConfig({ currentVersion: 2, readableVersions: readable, decodesEveryReadableVersion: true }))
    expect(Object.isFrozen(codec)).toBe(true)
    expect(codec.format).toBe("app.thing")
    expect(codec.currentVersion).toBe(2)
    expect(codec.readableVersions).toEqual([1, 2])
    readable.push(3)
    expect(codec.readableVersions).toEqual([1, 2])
    expect(isCodecVersionReadable(codec, 3)).toBe(false)
  })

  it("encodes into { format, version, payload } and decodes it back", () => {
    const codec = createVersionedCodec<{ n: number }>({
      format: "app.thing",
      currentVersion: 3,
      readableVersions: [3],
      encode: (value) => ({ n: value.n }),
      decode: (encoded) => ({ n: (encoded as { n: number }).n }),
    })
    const encoded = codec.encode({ n: 5 })
    expect(encoded).toEqual({ format: "app.thing", version: 3, payload: { n: 5 } })
    expect(Object.keys(encoded as object)).toEqual(["format", "version", "payload"])
    expect(codec.decode(encoded)).toEqual({ n: 5 })
    expect(encodeWithCodec(codec, { n: 6 })).toEqual({ format: "app.thing", version: 3, payload: { n: 6 } })
    expect(decodeWithCodec(codec, encoded)).toEqual({ n: 5 })
  })

  it("passes the envelope version to decode so older payloads are migrated", () => {
    const seen: [JsonValue, number][] = []
    const codec = createVersionedCodec<string>({
      format: "app.thing",
      currentVersion: 2,
      readableVersions: [1, 2],
      decodesEveryReadableVersion: true,
      encode: (value) => ({ name: value }),
      decode: (encoded, version) => {
        seen.push([encoded, version])
        return version === 1 ? (encoded as string) : (encoded as { name: string }).name
      },
    })
    expect(codec.decode({ format: "app.thing", version: 1, payload: "legacy" })).toBe("legacy")
    expect(codec.decode({ format: "app.thing", version: 2, payload: { name: "new" } })).toBe("new")
    expect(seen).toEqual([["legacy", 1], [{ name: "new" }, 2]])
  })

  it("rejects malformed envelopes, foreign formats and unreadable versions", () => {
    const codec = createVersionedCodec(baseConfig({ currentVersion: 2, readableVersions: [1, 2], decodesEveryReadableVersion: true }))
    expectCanonicalError(() => codec.decode("nope" as never), "envelope must be a plain object", INVALID_ENVELOPE_ERROR)
    expectCanonicalError(
      () => codec.decode({ format: "other.thing", version: 1, payload: 1 }),
      'format mismatch: expected "app.thing" got "other.thing"',
      UNSUPPORTED_FORMAT_ERROR,
    )
    expectCanonicalError(
      () => codec.decode({ format: "app.thing", version: 3, payload: 1 }),
      'unsupported version 3 for format "app.thing"; readable versions: [1, 2]',
      UNSUPPORTED_FORMAT_VERSION_ERROR,
    )
    // a mismatching format is reported before an unreadable version
    expectCanonicalError(
      () => codec.decode({ format: "other.thing", version: 9, payload: 1 }),
      'format mismatch: expected "app.thing" got "other.thing"',
      UNSUPPORTED_FORMAT_ERROR,
    )
  })

  it("assertCodecReadable and isCodecVersionReadable", () => {
    const codec = createVersionedCodec(baseConfig({ currentVersion: 2, readableVersions: [1, 2], decodesEveryReadableVersion: true }))
    expect(isCodecVersionReadable(codec, 1)).toBe(true)
    expect(isCodecVersionReadable(codec, 3)).toBe(false)
    expect(assertCodecReadable(codec, 2)).toBeUndefined()
    expectCanonicalError(() => assertCodecReadable(codec, 3), 'unsupported version 3 for codec "app.thing"', UNSUPPORTED_FORMAT_VERSION_ERROR)
  })
})

describe("string and byte transports", () => {
  it("encodes canonical JSON text and bytes and decodes them back", () => {
    const codec = createVersionedCodec<{ b: number; a: number }>({
      format: "app.thing",
      currentVersion: 1,
      readableVersions: [1],
      encode: (value) => ({ b: value.b, a: value.a }),
      decode: (encoded) => encoded as { b: number; a: number },
    })
    const text = encodeToString(codec, { b: 2, a: 1 })
    expect(text).toBe('{"format":"app.thing","payload":{"a":1,"b":2},"version":1}')
    expect(Array.from(encodeToBytes(codec, { b: 2, a: 1 }))).toEqual(Array.from(utf8(text)))
    expect(decodeFromString(codec, text)).toEqual({ a: 1, b: 2 })
    expect(decodeFromBytes(codec, utf8(text))).toEqual({ a: 1, b: 2 })
  })

  it("allows unlimited formats beyond the registered limits", () => {
    const codec = stringCodec("app.thing")
    const big = "y".repeat(5000)
    const text = encodeToString(codec, big)
    expect(text.length).toBeGreaterThan(SCOPE_LIMIT)
    expect(decodeFromString(codec, text)).toBe(big)
    expect(encodeToBytes(codec, big).byteLength).toBe(text.length)
    expect(decodeFromBytes(codec, utf8(text))).toBe(big)
  })

  it("encodeToString enforces the default limit exactly", () => {
    const codec = stringCodec(SCOPE)
    const atLimit = payloadForTotal(SCOPE, SCOPE_LIMIT)
    expect(utf8(encodeToString(codec, atLimit)).byteLength).toBe(SCOPE_LIMIT)
    expectCanonicalError(
      () => encodeToString(codec, `${atLimit}x`),
      `encoded envelope bytes ${SCOPE_LIMIT + 1} exceeds format default limit ${SCOPE_LIMIT} for ${SCOPE}`,
      SERIALIZATION_LIMIT_EXCEEDED_ERROR,
    )
  })

  it("encodeToString counts UTF-8 bytes, not characters", () => {
    const codec = stringCodec(SCOPE)
    const atLimit = payloadForTotal(SCOPE, SCOPE_LIMIT - 2) // leaves room for one 3 byte character replacing one ASCII character
    const multibyte = `${atLimit.slice(1)}€` // same length -1 + 3 bytes
    expect(multibyte.length).toBeLessThan(SCOPE_LIMIT)
    expectCanonicalError(
      () => encodeToString(codec, `${multibyte}€`),
      `encoded envelope bytes ${SCOPE_LIMIT + 3} exceeds format default limit ${SCOPE_LIMIT} for ${SCOPE}`,
      SERIALIZATION_LIMIT_EXCEEDED_ERROR,
    )
    expect(utf8(encodeToString(codec, multibyte)).byteLength).toBe(SCOPE_LIMIT - 2 - 1 + 3)
  })

  it("encodeToBytes enforces the default limit exactly", () => {
    const codec = stringCodec(SCOPE)
    const atLimit = payloadForTotal(SCOPE, SCOPE_LIMIT)
    expect(encodeToBytes(codec, atLimit).byteLength).toBe(SCOPE_LIMIT)
    expectCanonicalError(
      () => encodeToBytes(codec, `${atLimit}x`),
      `encoded envelope bytes ${SCOPE_LIMIT + 1} exceeds format default limit ${SCOPE_LIMIT} for ${SCOPE}`,
      SERIALIZATION_LIMIT_EXCEEDED_ERROR,
    )
  })

  it("decodeFromString enforces the default limit exactly, in bytes", () => {
    const codec = stringCodec(SCOPE)
    const atLimit = payloadForTotal(SCOPE, SCOPE_LIMIT)
    const text = JSON.stringify({ format: SCOPE, payload: atLimit, version: 1 })
    expect(utf8(text).byteLength).toBe(SCOPE_LIMIT)
    expect(decodeFromString(codec, text)).toBe(atLimit)
    const over = JSON.stringify({ format: SCOPE, payload: `${atLimit}x`, version: 1 })
    expectCanonicalError(() => decodeFromString(codec, over), `encoded envelope exceeds format default limit ${SCOPE_LIMIT} for ${SCOPE}`, SERIALIZATION_LIMIT_EXCEEDED_ERROR)
    // fewer characters than the limit but more bytes
    const wide = JSON.stringify({ format: SCOPE, payload: "€".repeat(1400), version: 1 })
    expect(wide.length).toBeLessThan(SCOPE_LIMIT)
    expect(utf8(wide).byteLength).toBeGreaterThan(SCOPE_LIMIT)
    expectCanonicalError(() => decodeFromString(codec, wide), `encoded envelope exceeds format default limit ${SCOPE_LIMIT} for ${SCOPE}`, SERIALIZATION_LIMIT_EXCEEDED_ERROR)
  })

  it("decodeFromBytes enforces the default limit exactly", () => {
    const codec = stringCodec(SCOPE)
    const atLimit = payloadForTotal(SCOPE, SCOPE_LIMIT)
    const bytes = utf8(JSON.stringify({ format: SCOPE, payload: atLimit, version: 1 }))
    expect(bytes.byteLength).toBe(SCOPE_LIMIT)
    expect(decodeFromBytes(codec, bytes)).toBe(atLimit)
    const over = utf8(JSON.stringify({ format: SCOPE, payload: `${atLimit}x`, version: 1 }))
    expectCanonicalError(() => decodeFromBytes(codec, over), `encoded envelope exceeds format default limit ${SCOPE_LIMIT} for ${SCOPE}`, SERIALIZATION_LIMIT_EXCEEDED_ERROR)
  })

  it("uses the larger default limits of the other registered formats", () => {
    const authority = stringCodec("framework.authority-provenance")
    const big = "z".repeat(SCOPE_LIMIT * 2)
    expect(decodeFromString(authority, encodeToString(authority, big))).toBe(big)
    const overAuthority = payloadForTotal("framework.authority-provenance", 64 * 1024 + 1)
    expectCanonicalError(
      () => encodeToString(authority, overAuthority),
      `encoded envelope bytes ${64 * 1024 + 1} exceeds format default limit ${64 * 1024} for framework.authority-provenance`,
      SERIALIZATION_LIMIT_EXCEEDED_ERROR,
    )
  })

  it("rejects malformed text and wrong formats during decode", () => {
    const codec = stringCodec("app.thing")
    expect(caught(() => decodeFromString(codec, "{"))).toBeInstanceOf(CanonicalJsonError)
    expectCanonicalError(
      () => decodeFromString(codec, '{"format":"x.y","payload":1,"version":1}'),
      'format mismatch: expected "app.thing" got "x.y"',
      UNSUPPORTED_FORMAT_ERROR,
    )
    expectCanonicalError(
      () => decodeFromBytes(codec, utf8('{"format":"app.thing","payload":1,"version":2}')),
      'unsupported version 2 for format "app.thing"; readable versions: [1]',
      UNSUPPORTED_FORMAT_VERSION_ERROR,
    )
  })
})
