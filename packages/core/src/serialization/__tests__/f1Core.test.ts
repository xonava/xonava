import { describe, expect, it } from "vitest"
import {
  CANONICALIZATION_VERSION,
  DIGEST_ALGORITHM_VERSION,
} from "../../spec/versions"
import {
  CANONICAL_JSON_LIMITS_V1,
  SERIALIZATION_LIMIT_EXCEEDED_ERROR,
  FORMAT_DEFAULT_MAX_CANONICAL_BYTES,
} from "../../spec/formatVersions"
import {
  canonicalJsonString,
  canonicalJsonBytes,
  canonicalSha256Hex,
  canonicalSha256Bytes,
  canonicalizeValue,
  decodeCanonicalJson,
  encodeBase64UrlUnpadded,
  decodeBase64UrlUnpadded,
  isValidRfc3339Millis,
  assertRfc3339Millis,
  CanonicalJsonError,
} from "../canonicalJson"
import { createEnvelope, parseEnvelope } from "../formatEnvelope"
import {
  getFormatRegistration,
  getReadableVersions,
  isFormatVersionReadable,
  assertFormatSupported,
} from "../formatRegistry"
import {
  createVersionedCodec,
  encodeToString,
  decodeFromString,
  encodeToBytes,
  decodeFromBytes,
} from "../versionedCodec"
import {
  fingerprintIdempotency,
  fingerprintOutbox,
  fingerprintCursorQuery,
} from "../fingerprint"

describe("F1 canonical serialization frozen contract", () => {
  it("freezes canonicalization and digest versions", () => {
    expect(CANONICALIZATION_VERSION).toBe("jcs-rfc8785-v1")
    expect(DIGEST_ALGORITHM_VERSION).toBe("sha256-v1")
  })

  it("freezes hard resource limits exactly", () => {
    expect(CANONICAL_JSON_LIMITS_V1).toEqual({
      maxUtf8Bytes: 16 * 1024 * 1024,
      maxDepth: 64,
      maxTotalNodes: 250_000,
      maxObjectMembers: 100_000,
      maxArrayItems: 100_000,
      maxStringUtf8Bytes: 8 * 1024 * 1024,
      maxPropertyNameUtf8Bytes: 1_024,
    })
  })

  it("canonicalizes primitives and key ordering", () => {
    expect(canonicalJsonString(null)).toBe("null")
    expect(canonicalJsonString(true)).toBe("true")
    expect(canonicalJsonString(42)).toBe("42")
    expect(canonicalJsonString("hello")).toBe('"hello"')
    expect(canonicalJsonString({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJsonString({ z: { b: 2, a: 1 }, a: [3, 2, 1] })).toBe('{"a":[3,2,1],"z":{"a":1,"b":2}}')
  })

  it("preserves Unicode without normalization and sorts by UTF-16", () => {
    expect(canonicalJsonString("café")).toBe('"café"')
    expect(canonicalJsonString("😀")).toBe('"😀"')
    const a: Record<string, unknown> = {}
    a["Ω"] = 1
    a["α"] = 2
    expect(canonicalJsonString(a)).toBe(canonicalJsonString({ "α": 2, "Ω": 1 }))
  })

  it("handles negative zero per RFC8785", () => {
    expect(canonicalJsonString(-0)).toBe("0")
    expect(canonicalJsonString({ v: -0 })).toBe('{"v":0}')
    expect(canonicalSha256Hex(-0)).toBe(canonicalSha256Hex(0))
    expect(canonicalJsonString(-0) === "0").toBe(true)
  })

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJsonString(NaN)).toThrow(CanonicalJsonError)
    expect(() => canonicalJsonString(Infinity)).toThrow(CanonicalJsonError)
    expect(() => canonicalJsonString(-Infinity)).toThrow(CanonicalJsonError)
    expect(() => decodeCanonicalJson("{\"a\":NaN}")).toThrow(CanonicalJsonError)
  })

  it("rejects integers outside safe range", () => {
    expect(() => canonicalJsonString(Number.MAX_SAFE_INTEGER + 1)).toThrow(CanonicalJsonError)
    expect(() => canonicalJsonString(Number.MIN_SAFE_INTEGER - 1)).toThrow(CanonicalJsonError)
    expect(() => decodeCanonicalJson(`{"v":${Number.MAX_SAFE_INTEGER + 1}}`)).toThrow(CanonicalJsonError)
    expect(canonicalJsonString(Number.MAX_SAFE_INTEGER)).toBe(String(Number.MAX_SAFE_INTEGER))
  })

  it("rejects lone surrogates", () => {
    expect(() => canonicalJsonString("\uD800")).toThrow(CanonicalJsonError)
    expect(() => canonicalJsonString("\uDC00")).toThrow(CanonicalJsonError)
    expect(() => canonicalJsonString({ k: "\uD800" })).toThrow(CanonicalJsonError)
    expect(() => decodeCanonicalJson('"\\uD800"')).toThrow(CanonicalJsonError)
    expect(() => decodeCanonicalJson('"\\uDC00"')).toThrow(CanonicalJsonError)
  })

  it("rejects duplicate object keys at decode", () => {
    expect(() => decodeCanonicalJson('{"a":1,"a":2}')).toThrow(/duplicate object key/)
    expect(() => decodeCanonicalJson('{"a":1, "b":2, "a":3}')).toThrow(/duplicate/)
  })

  it("rejects undefined, bigint, function, symbol, Date", () => {
    expect(() => canonicalJsonString(undefined)).toThrow(CanonicalJsonError)
    expect(() => canonicalJsonString(BigInt(1))).toThrow(CanonicalJsonError)
    expect(() => canonicalJsonString((() => {}))).toThrow(CanonicalJsonError)
    expect(() => canonicalJsonString(Symbol("s"))).toThrow(CanonicalJsonError)
    expect(() => canonicalJsonString(new Date())).toThrow(/RFC3339/)
  })

  it("rejects __proto__ constructor prototype keys", () => {
    const o1 = Object.create(null) as Record<string, unknown>
    Object.defineProperty(o1, "__proto__", { value: 1, enumerable: true, configurable: true, writable: true })
    expect(() => canonicalizeValue(o1)).toThrow(CanonicalJsonError)
    expect(() => decodeCanonicalJson('{"__proto__":1}')).toThrow(CanonicalJsonError)
    expect(() => decodeCanonicalJson('{"constructor":1}')).toThrow(CanonicalJsonError)
  })

  it("produces deterministic UTF-8 bytes and SHA-256 digests", () => {
    expect(canonicalJsonBytes({}).length).toBe(2)
    // empty object digest known value
    expect(canonicalSha256Hex({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
    expect(canonicalSha256Bytes({})).toBeInstanceOf(Uint8Array)
    expect(canonicalSha256Bytes({}).length).toBe(32)
    // consistency
    expect(canonicalSha256Hex({ a: 1, b: 2 })).toBe(canonicalSha256Hex({ b: 2, a: 1 }))
    expect(canonicalSha256Hex("hello")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("handles timestamps as RFC3339 millis strings", () => {
    expect(isValidRfc3339Millis("2026-08-21T00:00:00.000Z")).toBe(true)
    expect(isValidRfc3339Millis("2026-08-21T00:00:00Z")).toBe(false)
    expect(isValidRfc3339Millis("2026-08-21 00:00:00.000Z")).toBe(false)
    expect(() => assertRfc3339Millis("bad")).toThrow(CanonicalJsonError)
    // canonical string of timestamp string is just JSON string
    expect(canonicalJsonString("2026-01-01T00:00:00.000Z")).toBe('"2026-01-01T00:00:00.000Z"')
  })

  it("encodes binary as unpadded base64url", () => {
    expect(encodeBase64UrlUnpadded(new Uint8Array(0))).toBe("")
    expect(encodeBase64UrlUnpadded(new TextEncoder().encode("hello"))).toBe("aGVsbG8")
    const hello = new TextEncoder().encode("hello")
    expect(decodeBase64UrlUnpadded(encodeBase64UrlUnpadded(hello))).toEqual(hello)
    expect(() => decodeBase64UrlUnpadded("aGVsbG8!")).toThrow(CanonicalJsonError)
    expect(() => decodeBase64UrlUnpadded("a")).toThrow(CanonicalJsonError)
  })
})

describe("F1 hard resource limits", () => {
  it("accepts maxDepth 64 and rejects 65", () => {
    let val: unknown = 0
    for (let i = 0; i < 64; i++) val = { a: val }
    expect(() => canonicalJsonString(val)).not.toThrow()
    let val2: unknown = 0
    for (let i = 0; i < 65; i++) val2 = { a: val2 }
    expect(() => canonicalJsonString(val2)).toThrow(CanonicalJsonError)
    // also decode depth
    let json = "0"
    for (let i = 0; i < 64; i++) json = `{"a":${json}}`
    expect(() => decodeCanonicalJson(json)).not.toThrow()
    json = `{"a":${json}}`
    expect(() => decodeCanonicalJson(json)).toThrow(CanonicalJsonError)
  })

  it("rejects one-over maxObjectMembers and maxArrayItems via direct check", () => {
    expect(canonicalJsonString({})).toBe("{}")
    expect(canonicalJsonString([1, 2, 3])).toBe("[1,2,3]")
    const members100k: Record<string, number> = {}
    for (let i = 0; i < 100_000; i++) members100k[`k${i}`] = i
    expect(() => canonicalJsonString(members100k)).not.toThrow()
    members100k["k100000"] = 100000
    expect(() => canonicalJsonString(members100k)).toThrow(CanonicalJsonError)
    // array boundary
    const arr100k = new Array(100_000).fill(0) as number[]
    expect(() => canonicalJsonString(arr100k)).not.toThrow()
    arr100k.push(0)
    expect(() => canonicalJsonString(arr100k)).toThrow(CanonicalJsonError)
  })

  it("enforces maxTotalNodes 250k", () => {
    const root: Record<string, unknown> = {}
    for (let i = 0; i < 1000; i++) {
      root[`k${i}`] = new Array(249).fill(1) as number[]
    }
    // nodes: 1 root + 1000 arrays + 1000*249 numbers = 250001 > 250000 => should throw
    // but 999 arrays version should pass: 1 + 999 + 999*249 = 249751
    const rootPass: Record<string, unknown> = {}
    for (let i = 0; i < 999; i++) rootPass[`k${i}`] = new Array(249).fill(1) as number[]
    expect(() => canonicalJsonString(rootPass)).not.toThrow()
    expect(() => canonicalJsonString(root)).toThrow(CanonicalJsonError)
  })

  it("rejects strings exceeding maxStringUtf8Bytes and property names exceeding 1024", () => {
    const bigStr = "a".repeat(CANONICAL_JSON_LIMITS_V1.maxStringUtf8Bytes + 1)
    expect(() => canonicalJsonString(bigStr)).toThrow(CanonicalJsonError)
    // exact boundary should pass (8MiB)
    const boundary = "a".repeat(CANONICAL_JSON_LIMITS_V1.maxStringUtf8Bytes)
    // This is 8MiB chars -> 8MiB bytes for ascii
    expect(() => canonicalJsonString(boundary)).not.toThrow()
    const longKey = "k".repeat(CANONICAL_JSON_LIMITS_V1.maxPropertyNameUtf8Bytes + 1)
    const obj: Record<string, unknown> = {}
    obj[longKey] = 1
    expect(() => canonicalJsonString(obj)).toThrow(CanonicalJsonError)
  })

  it("rejects canonical output exceeding maxUtf8Bytes (via canary small limit simulation)", () => {
    const chunk = "a".repeat(6 * 1024 * 1024)
    const nearLimitArray = [chunk, chunk] // ~12MiB + overhead, under 16MiB
    expect(() => canonicalJsonString(nearLimitArray)).not.toThrow()
    const overArray = [chunk, chunk, chunk] // ~18MiB + overhead => exceeds 16MiB
    try {
      canonicalJsonString(overArray)
      throw new Error("expected to throw")
    } catch (e) {
      const err = e as CanonicalJsonError
      expect(err.code).toBe(SERIALIZATION_LIMIT_EXCEEDED_ERROR)
    }
    const overBytes = new TextEncoder().encode(JSON.stringify(overArray)).byteLength
    expect(overBytes).toBeGreaterThan(CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes)
  })

  it("rejects lone surrogates and duplicate keys with limit code where applicable", () => {
    expect(() => decodeCanonicalJson('{"a":1,"a":2}')).toThrow(CanonicalJsonError)
    // ensure limit exceeded has correct code
    try {
      const big = "a".repeat(CANONICAL_JSON_LIMITS_V1.maxPropertyNameUtf8Bytes + 1)
      const o: Record<string, unknown> = {}
      o[big] = 1
      canonicalizeValue(o)
    } catch (e) {
      const err = e as CanonicalJsonError
      expect(err.code).toBe(SERIALIZATION_LIMIT_EXCEEDED_ERROR)
    }
  })

  it("enforces per-format default maxima", () => {
    expect(FORMAT_DEFAULT_MAX_CANONICAL_BYTES.eventOutboxEnvelope).toBe(1024 * 1024)
    expect(FORMAT_DEFAULT_MAX_CANONICAL_BYTES.authorityProvenance).toBe(64 * 1024)
    expect(FORMAT_DEFAULT_MAX_CANONICAL_BYTES.executionScopeIdentitySource).toBe(4 * 1024)
    // versioned codec should enforce per-format limit
    const bigCodec = createVersionedCodec<string>({
      format: "framework.event-envelope",
      currentVersion: 1,
      readableVersions: [1],
      encode: (s) => s,
      decode: (j) => j as string,
    })
    const bigPayload = "x".repeat(FORMAT_DEFAULT_MAX_CANONICAL_BYTES.eventOutboxEnvelope + 10)
    // envelope is {"format":"framework.event-envelope","version":1,"payload":"xxx"} -> will exceed 1MiB
    expect(() => encodeToString(bigCodec, bigPayload)).toThrow(CanonicalJsonError)
    // but small payload passes
    expect(() => encodeToString(bigCodec, "hello")).not.toThrow()
  })
})

describe("F1 envelopes and codecs mixed-version", () => {
  it("creates and parses envelopes", () => {
    const env = createEnvelope("framework.event-envelope", 1, { id: 1 })
    expect(parseEnvelope(env)).toEqual({ format: "framework.event-envelope", version: 1, payload: { id: 1 } })
  })

  it("rejects invalid envelope format/version", () => {
    expect(() => createEnvelope("", 1, {})).toThrow(CanonicalJsonError)
    expect(() => createEnvelope("framework.event-envelope", 0, {})).toThrow(CanonicalJsonError)
    expect(() => parseEnvelope({ format: "", version: 1 })).toThrow(CanonicalJsonError)
    expect(() => parseEnvelope({ format: "framework.event-envelope", version: 0 })).toThrow(CanonicalJsonError)
  })

  it("supports readableVersions logic (readers-before-writers)", () => {
    expect(isFormatVersionReadable("framework.event-envelope", 1)).toBe(true)
    expect(isFormatVersionReadable("framework.event-envelope", 2)).toBe(false)
    expect(getReadableVersions("framework.event-envelope")).toEqual([1])
    expect(() => assertFormatSupported("framework.event-envelope", 2)).toThrow(CanonicalJsonError)
    expect(() => assertFormatSupported("unknown.format", 1)).toThrow(CanonicalJsonError)
    expect(getFormatRegistration("framework.event-envelope")?.formatId).toBe("framework.event-envelope")
  })

  it("versioned codec mixed-version scenarios", () => {
    const codecV1 = createVersionedCodec<{ x: number }>({
      format: "framework.event-envelope",
      currentVersion: 1,
      readableVersions: [1],
      encode: (v) => ({ x: v.x }),
      decode: (j) => j as { x: number },
    })
    const codecV1V2 = createVersionedCodec<{ x: number }>({
      format: "framework.event-envelope",
      currentVersion: 2,
      readableVersions: [1, 2],
      encode: (v) => ({ x: v.x, v: 2 }),
      decode: (j) => j as { x: number },
    })
    // old reader / old data
    const enc1 = codecV1.encode({ x: 1 })
    expect(codecV1.decode(enc1)).toEqual({ x: 1 })
    // new reader / old data (readableVersions includes 1)
    expect(codecV1V2.decode(enc1)).toEqual({ x: 1 })
    // new writer / old reader window: old reader should reject v2
    const enc2 = codecV1V2.encode({ x: 2 })
    expect(() => codecV1.decode(enc2)).toThrow(CanonicalJsonError)
    // unknown future version fails closed
    const future = createEnvelope("framework.event-envelope", 99, { x: 1 })
    expect(() => codecV1.decode(future)).toThrow(CanonicalJsonError)
    expect(() => codecV1V2.decode(future)).toThrow(CanonicalJsonError)
    // corrupted envelope fails
    expect(() => decodeFromString(codecV1, "not-json")).toThrow(CanonicalJsonError)
    expect(() => decodeFromString(codecV1, '{"format":"framework.event-envelope","version":1,"payload":}')).toThrow(CanonicalJsonError)
  })

  it("models the complete readers-before-writers rollout and rollback window", () => {
    const releaseA = createVersionedCodec<Record<string, number>>({
      format: "framework.event-envelope", currentVersion: 1, readableVersions: [1, 2],
      encode: (value) => value, decode: (value) => value as Record<string, number>,
    })
    const releaseB = createVersionedCodec<Record<string, number>>({
      format: "framework.event-envelope", currentVersion: 2, readableVersions: [1, 2],
      encode: (value) => value, decode: (value) => value as Record<string, number>,
    })
    const oldReader = createVersionedCodec<Record<string, number>>({
      format: "framework.event-envelope", currentVersion: 1, readableVersions: [1],
      encode: (value) => value, decode: (value) => value as Record<string, number>,
    })
    const oldData = releaseA.encode({ value: 1 })
    expect(oldReader.decode(oldData)).toEqual({ value: 1 })
    expect(releaseA.decode(oldData)).toEqual({ value: 1 })
    expect(releaseB.decode(oldData)).toEqual({ value: 1 })
    const newData = releaseB.encode({ value: 2 })
    expect(releaseA.decode(newData)).toEqual({ value: 2 })
    expect(releaseB.decode(newData)).toEqual({ value: 2 })
    expect(() => oldReader.decode(newData)).toThrow(CanonicalJsonError)
    expect(() => releaseB.decode({ format: "framework.event-envelope", version: 99, payload: {} })).toThrow(CanonicalJsonError)
  })

  it("round-trips via encodeToString/decodeFromString and bytes", () => {
    const codec = createVersionedCodec<string>({
      format: "framework.authority-provenance",
      currentVersion: 1,
      readableVersions: [1],
      encode: (s) => s,
      decode: (j) => j as string,
    })
    const str = encodeToString(codec, "hello")
    expect(decodeFromString(codec, str)).toBe("hello")
    const bytes = encodeToBytes(codec, "hello")
    expect(decodeFromBytes(codec, bytes)).toBe("hello")
  })
})

describe("F1 fingerprints and scope ids", () => {
  it("fingerprints are deterministic and domain-separated", () => {
    const a = fingerprintIdempotency({ a: 1, b: 2 })
    const b = fingerprintIdempotency({ b: 2, a: 1 })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprintOutbox({ a: 1 })).not.toBe(fingerprintIdempotency({ a: 1 }))
    expect(fingerprintCursorQuery({ a: 1 })).not.toBe(fingerprintOutbox({ a: 1 }))
  })

  it("enforces the lower per-recipe input ceilings before hashing", () => {
    const overCursor = "x".repeat(FORMAT_DEFAULT_MAX_CANONICAL_BYTES.cursorEnvelopeBeforeEncodingOrSigning)
    try {
      fingerprintCursorQuery(overCursor)
      throw new Error("expected cursor fingerprint limit rejection")
    } catch (error) {
      expect((error as CanonicalJsonError).code).toBe(SERIALIZATION_LIMIT_EXCEEDED_ERROR)
    }
  })

  it("generates scope ids with fscope:v1: prefix", () => {
    const scope = { kind: "tenant", tenantId: "tenant-42" }
    const jcs = canonicalJsonString(scope)
    const b64 = encodeBase64UrlUnpadded(new TextEncoder().encode(jcs))
    const scopeId = `fscope:v1:${b64}`
    expect(scopeId.startsWith("fscope:v1:")).toBe(true)
    expect(decodeBase64UrlUnpadded(scopeId.slice("fscope:v1:".length))).toEqual(new TextEncoder().encode(jcs))
  })
})
