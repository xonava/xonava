import { describe, expect, it } from "vitest"
import { forAll, forAllAsync, type Rng } from "./harness"
import {
  CANONICAL_NUMBERS, E_ACUTE_NFC, E_ACUTE_NFD, LONE_HIGH, LONE_LOW, REJECTED_NUMBERS, adversarialString, cursorPayload, describeCompact, flipZeroSigns, jsonEqual,
  jsonModel, jsonValue, mutateJson, nonBlankString, normaliseZero, permuteKeys, shrinkJson,
} from "./encodingArbitraries"
import {
  CanonicalJsonError, canonicalJsonBytes, canonicalJsonString, canonicalSha256Hex, decodeBase64UrlUnpadded, decodeCanonicalJson, encodeBase64UrlUnpadded,
} from "../../serialization/canonicalJson"
import { fingerprintCursorQuery, fingerprintIdempotency, fingerprintOutbox, fingerprintWithDomainSeparator } from "../../serialization/fingerprint"
import { createVersionedCodec, decodeFromBytes, decodeFromString, encodeToBytes, encodeToString, type JsonValue } from "../../serialization/versionedCodec"
import { sha256Hex } from "../../serialization/sha256"
import { hmacSha256 } from "../../serialization/hmac"
import { FINGERPRINT_DOMAIN_SEPARATORS } from "../../spec/versions"
import { assertCursorBinding, type CursorPayloadV1 } from "../../query/cursor"
import { createRotatingCursorIntegrity, decodeCursor, encodeCursor, type CursorIntegrityPort } from "../../query/cursorCodec"
import { ValidationError } from "../../domain/errors"

/**
 * Property and differential suite for canonical JSON (jcs-rfc8785-v1), its
 * fingerprints, base64url, versioned envelopes and signed cursors.
 *
 * Normalisations documented by docs/spec/serialization/canonical-json.md and
 * implemented by the codec: -0 is written as 0; objects are written in UTF-16
 * code-unit key order; strings are not Unicode-normalised. Dates, non-finite
 * numbers, unsafe integers, lone surrogates and non-plain objects are rejected.
 */

const textEncoder = new TextEncoder()

/** Independent RFC 8785 model for already-JSON values: sort by UTF-16 code units, ES number/string forms. */
function jcsModel(value: unknown): string {
  if (typeof value === "number") return JSON.stringify(Object.is(value, -0) ? 0 : value)
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(jcsModel).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${jcsModel(record[key])}`).join(",")}}`
}

function tryRun<T>(run: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try { return { ok: true, value: run() } } catch (error) { return { ok: false, error } }
}

/** Places `inner` at a random position inside a JSON container. */
function embed(rng: Rng, outer: unknown, inner: unknown): unknown {
  if (Array.isArray(outer) && outer.length > 0 && rng.bool(0.6)) {
    const index = rng.int(outer.length)
    return outer.map((item, position) => (position === index ? embed(rng, item, inner) : item))
  }
  if (outer !== null && typeof outer === "object" && !Array.isArray(outer) && Object.keys(outer).length > 0 && rng.bool(0.6)) {
    const key = rng.pick(Object.keys(outer))
    return { ...(outer as Record<string, unknown>), [key]: embed(rng, (outer as Record<string, unknown>)[key], inner) }
  }
  return rng.bool() ? [outer, inner] : { wrapped: outer, inner }
}

describe("canonical JSON (serialization/canonicalJson.ts)", () => {
  it("matches an independent RFC 8785 model byte for byte, including integer-like keys (\"10\" < \"9\")", () => {
    forAll("canonical vs JCS model", (rng) => {
      const value = jsonValue(rng)
      // Integer-like keys are where JavaScript's own property order diverges from JCS.
      return rng.bool(0.3) ? { [String(rng.int(20))]: value, [String(rng.int(200))]: 1, b: [value], "01": 0 } : value
    }, (value) => {
      expect(canonicalJsonString(value)).toBe(jcsModel(value))
    }, { runs: 800, shrink: shrinkJson, describe: describeCompact })
  })

  it("round-trips: decode(encode(v)) equals JSON.parse(JSON.stringify(v)) modulo -0, and re-encodes identically", () => {
    forAll("canonical round trip vs JSON", (rng) => jsonValue(rng), (value) => {
      const encoded = canonicalJsonString(value)
      const decoded = decodeCanonicalJson(encoded)
      expect(jsonEqual(decoded, jsonModel(value))).toBe(true)
      expect(canonicalJsonString(decoded)).toBe(encoded)
      expect(decodeCanonicalJson(canonicalJsonBytes(value))).toEqual(decoded)
    }, { runs: 800, shrink: shrinkJson, describe: describeCompact })
  })

  it("is stable under key permutation and -0/0 and changes under a meaning-changing mutation", () => {
    forAll("canonical stability", (rng) => {
      const value = jsonValue(rng)
      return { value, twin: flipZeroSigns(permuteKeys(rng, value)), other: mutateJson(rng, value) }
    }, ({ value, twin, other }) => {
      const encoded = canonicalJsonString(value)
      expect(canonicalJsonString(twin)).toBe(encoded)
      expect(canonicalSha256Hex(twin)).toBe(canonicalSha256Hex(value))
      // Different canonical text iff different JSON meaning (modulo -0).
      const otherEncoded = tryRun(() => canonicalJsonString(other))
      if (otherEncoded.ok) expect(otherEncoded.value === encoded).toBe(jsonEqual(normaliseZero(other), normaliseZero(value)))
    }, { runs: 800, describe: describeCompact })
  })

  it("does not Unicode-normalise: NFC and NFD spellings stay distinct values", () => {
    forAll("canonical no normalization", (rng) => adversarialString(rng, { maxAtoms: 3, longRate: 0 }) + E_ACUTE_NFC, (text) => {
      const nfd = text.split(E_ACUTE_NFC).join(E_ACUTE_NFD)
      expect(canonicalJsonString(text)).not.toBe(canonicalJsonString(nfd))
      expect(canonicalJsonString({ [text]: 1 })).not.toBe(canonicalJsonString({ [nfd]: 1 }))
    }, { runs: 200 })
  })

  it("rejects every unsupported value wherever it is nested (Date, non-finite, unsafe int, lone surrogate, __proto__, instances, undefined)", () => {
    forAll("canonical rejection anywhere", (rng) => {
      const bad = rng.pick<() => unknown>([
        () => new Date(rng.int(2) === 0 ? 0 : 1_700_000_000_000),
        () => rng.pick(REJECTED_NUMBERS),
        () => `${adversarialString(rng, { maxAtoms: 1 })}${rng.pick([LONE_HIGH, LONE_LOW])}`,
        () => ({ [`k${rng.pick([LONE_HIGH, LONE_LOW])}`]: 1 }),
        () => JSON.parse("{\"__proto__\":1}") as unknown,
        () => new Map([["a", 1]]),
        () => new Set([1]),
        () => new (class Point { x = 1 })(),
        () => undefined,
        () => 10n,
        () => [1, , 3],
        () => Object.defineProperty({}, "hidden", { value: 1, enumerable: false }),
        () => ({ get a() { return 1 } }),
      ])()
      return embed(rng, jsonValue(rng, { maxDepth: 2 }), bad)
    }, (value) => {
      expect(() => canonicalJsonString(value)).toThrow(CanonicalJsonError)
    }, { runs: 600, describe: describeCompact })
  })

  it("decoder agrees with JSON.parse on every single-character mutation of canonical text (differential)", () => {
    const alphabet = [..."{}[]\":,0123456789-+.eEtrufalsn \\/u\n\t", "\u0000", "é", "\ud83d", "\ude00"]
    forAll("decoder vs JSON.parse under mutation", (rng) => {
      const text = canonicalJsonString(jsonValue(rng, { maxDepth: 3 }))
      const position = rng.int(text.length + 1)
      const char = rng.pick(alphabet)
      const mutated = rng.pick([
        () => `${text.slice(0, position)}${char}${text.slice(position + 1)}`,
        () => `${text.slice(0, position)}${char}${text.slice(position)}`,
        () => `${text.slice(0, position)}${text.slice(position + 1)}`,
        () => `${text.slice(0, position)} ${text.slice(position)}`,
      ])()
      return mutated
    }, (mutated) => {
      const ours = tryRun(() => decodeCanonicalJson(mutated))
      const reference = tryRun(() => JSON.parse(mutated) as unknown)
      if (!reference.ok) {
        expect(ours.ok).toBe(false)
        return
      }
      if (ours.ok) {
        // Accepted: same meaning as JSON.parse (modulo -0) and canonical re-encoding is a fixed point.
        expect(jsonEqual(ours.value, normaliseZero(reference.value))).toBe(true)
        const again = canonicalJsonString(ours.value)
        expect(canonicalJsonString(decodeCanonicalJson(again))).toBe(again)
        return
      }
      // JSON.parse accepted but the decoder rejected: only for documented reasons.
      expect(ours.error).toBeInstanceOf(CanonicalJsonError)
      const encodable = tryRun(() => canonicalJsonString(reference.value))
      if (encodable.ok) expect(String((ours.error as Error).message)).toMatch(/duplicate object key|lone surrogate/)
    }, { runs: 3000, describe: describeCompact })
  })

  it("byte decoding rejects exactly the invalid UTF-8 inputs (differential vs fatal TextDecoder)", () => {
    forAll("decoder bytes vs TextDecoder", (rng) => {
      const bytes = canonicalJsonBytes(jsonValue(rng, { maxDepth: 2 }))
      const mutated = bytes.slice()
      if (mutated.length > 0) mutated[rng.int(mutated.length)] = rng.pick([0x80, 0xbf, 0xc0, 0xc1, 0xe0, 0xed, 0xf0, 0xf5, 0xff, rng.int(256)])
      return mutated
    }, (bytes) => {
      const text = tryRun(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      const fromBytes = tryRun(() => decodeCanonicalJson(bytes))
      if (!text.ok) {
        expect(fromBytes.ok).toBe(false)
        return
      }
      const fromText = tryRun(() => decodeCanonicalJson(text.value))
      expect(fromBytes.ok).toBe(fromText.ok)
      if (fromBytes.ok && fromText.ok) expect(fromBytes.value).toEqual(fromText.value)
    }, { runs: 800, describe: (bytes) => Array.from(bytes).join(",") })
  })
})

describe("base64url (serialization/canonicalJson.ts)", () => {
  it("round-trips arbitrary bytes and agrees with Node's base64url", () => {
    forAll("base64url round trip", (rng) => Uint8Array.from({ length: rng.int(70) }, () => rng.int(256)), (bytes) => {
      const encoded = encodeBase64UrlUnpadded(bytes)
      expect(encoded).toBe(Buffer.from(bytes).toString("base64url"))
      expect(decodeBase64UrlUnpadded(encoded)).toEqual(bytes)
    }, { runs: 500, describe: (bytes) => Array.from(bytes).join(",") })
  })

  it("accepts a string only in its canonical spelling (no padding, no stray bits, url alphabet)", () => {
    const alphabet = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", "+", "/", "=", " ", "."]
    forAll("base64url strict", (rng) => Array.from({ length: rng.int(12) }, () => (rng.bool(0.9) ? rng.pick(alphabet.slice(0, 64)) : rng.pick(alphabet))).join(""), (text) => {
      const decoded = tryRun(() => decodeBase64UrlUnpadded(text))
      if (decoded.ok) expect(encodeBase64UrlUnpadded(decoded.value)).toBe(text)
      else expect(decoded.error).toBeInstanceOf(CanonicalJsonError)
    }, { runs: 1500 })
  })
})

describe("fingerprints and domain separation (serialization/fingerprint.ts)", () => {
  const segment = (rng: Rng): string => rng.pick(["v1", "v2", "a", "framework", "idempotency", "outbox", "cursor-query", "x-1", "0", "n", "t", "true", "null"])
  const separator = (rng: Rng): string => {
    const parts = [rng.pick(["framework", "a", "app", "x"]), ...Array.from({ length: rng.int(3) }, () => segment(rng))]
    return `${parts.join(":")}:v${rng.int(3)}:`
  }

  it("the same payload under different domains never collides; built-in domains are pairwise distinct", () => {
    forAll("fingerprint domain separation", (rng) => jsonValue(rng, { maxDepth: 2 }), (value) => {
      const digests = [fingerprintIdempotency(value), fingerprintOutbox(value), fingerprintCursorQuery(value)]
      expect(new Set(digests).size).toBe(3)
      expect(digests[0]).toBe(sha256Hex(textEncoder.encode(`${FINGERPRINT_DOMAIN_SEPARATORS.idempotency}${canonicalJsonString(value)}`)))
      expect(digests).not.toContain(canonicalSha256Hex(value))
    }, { runs: 300, describe: describeCompact })
  })

  it("(separator, payload) -> digest input is injective even when one separator extends another (\"a:v1:\" vs \"a:v1:v2:\")", () => {
    const seen = new Map<string, string>()
    forAll("fingerprint separator injective", (rng) => {
      const first = separator(rng)
      const second = rng.bool(0.5) ? `${first}${segment(rng)}:v${rng.int(3)}:` : separator(rng)
      const value = rng.pick<() => unknown>([
        () => jsonValue(rng, { maxDepth: 1 }),
        () => rng.pick(["v1:", "v2:1", ":", ""]),
        () => rng.pick([0, 1, 2, -1, true, false, null]),
      ])()
      return { pairs: [[first, value], [second, value], [second, rng.pick([1, "x", null])]] as Array<[string, unknown]> }
    }, ({ pairs }) => {
      for (const [domain, value] of pairs) {
        const identity = JSON.stringify([domain, canonicalJsonString(value)])
        const digest = fingerprintWithDomainSeparator(domain, value)
        const previous = seen.get(digest)
        if (previous !== undefined) expect(previous).toBe(identity)
        seen.set(digest, identity)
      }
    }, { runs: 600, describe: describeCompact })
  })

  it("accepts exactly the documented separator grammar", () => {
    const grammar = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*:v[0-9]+:$/
    forAll("fingerprint separator grammar", (rng) => rng.pick<() => string>([
      () => separator(rng),
      () => separator(rng).toUpperCase(),
      () => separator(rng).slice(0, -1),
      () => `${separator(rng)}x`,
      () => `${separator(rng).slice(0, 3)}${rng.pick([":", "::", " ", "\u0000", "/", "é"])}${separator(rng)}`,
      () => adversarialString(rng, { maxAtoms: 3 }),
    ])(), (domain) => {
      const result = tryRun(() => fingerprintWithDomainSeparator(domain, 1))
      expect(result.ok).toBe(grammar.test(domain))
      if (!result.ok) expect(result.error).toBeInstanceOf(CanonicalJsonError)
    }, { runs: 500 })
  })

  it("is stable for semantically equal payloads and rejects Date where an ISO string is accepted", () => {
    forAll("fingerprint semantic stability", (rng) => {
      const value = jsonValue(rng, { maxDepth: 3 })
      return { value, twin: flipZeroSigns(permuteKeys(rng, value)), at: new Date(rng.int(2_000_000_000) * 1000) }
    }, ({ value, twin, at }) => {
      expect(fingerprintIdempotency(twin)).toBe(fingerprintIdempotency(value))
      expect(fingerprintIdempotency({ value, at: at.toISOString() })).toBe(fingerprintIdempotency({ at: at.toISOString(), value: twin }))
      // An unencoded Date is not silently equated with its ISO string: it is rejected.
      expect(() => fingerprintIdempotency({ value, at })).toThrow(CanonicalJsonError)
    }, { runs: 300, describe: describeCompact })
  })
})

describe("versioned codec envelopes (serialization/versionedCodec.ts, formatEnvelope.ts)", () => {
  const codec = createVersionedCodec<JsonValue>({
    format: "framework.property-test",
    currentVersion: 2,
    readableVersions: [1, 2],
    decodesEveryReadableVersion: true,
    encode: (value) => value,
    decode: (value, version) => (version === 1 ? { legacy: value } : value),
  })

  it("round-trips through strings and bytes and re-encodes canonically", () => {
    forAll("versioned codec round trip", (rng) => jsonValue(rng) as JsonValue, (value) => {
      const text = encodeToString(codec, value)
      expect(text).toBe(canonicalJsonString({ format: codec.format, version: 2, payload: value }))
      expect(jsonEqual(decodeFromString(codec, text), jsonModel(value))).toBe(true)
      expect(jsonEqual(decodeFromBytes(codec, encodeToBytes(codec, value)), jsonModel(value))).toBe(true)
    }, { runs: 400, describe: describeCompact })
  })

  it("rejects malformed envelopes: wrong format, unreadable version, missing payload, unknown members", () => {
    forAll("versioned codec malformed envelope", (rng) => {
      const payload = jsonValue(rng, { maxDepth: 1 })
      return rng.pick<() => Record<string, unknown>>([
        () => ({ format: rng.pick(["framework.other", "Framework.property-test", "framework.property-test ", ""]), version: 2, payload }),
        () => ({ format: "framework.property-test", version: rng.pick([0, 3, -1, 1.5, "2", 2 ** 53]), payload }),
        () => ({ format: "framework.property-test", version: 2 }),
        () => ({ format: "framework.property-test", version: 2, payload, [rng.pick(["formatVersion", "extra", "Payload", "payload "])]: 1 }),
        () => ({ format: "framework.property-test", payload }),
      ])()
    }, (envelope) => {
      expect(() => decodeFromString(codec, JSON.stringify(envelope))).toThrow(CanonicalJsonError)
    }, { runs: 400, describe: describeCompact })
  })
})

describe("signed cursors (query/cursorCodec.ts, query/cursor.ts)", () => {
  const port = (secret: string): CursorIntegrityPort => {
    const key = textEncoder.encode(secret)
    return {
      async sign(payload) { return hmacSha256(key, payload) },
      async verify(payload, signature) {
        const expected = hmacSha256(key, payload)
        return expected.length === signature.length && expected.every((byte, index) => byte === signature[index])
      },
    }
  }
  const integrity = port("cursor-property-key")
  const NOW = 1_000

  const canonicalPayload = (payload: CursorPayloadV1): CursorPayloadV1 => JSON.parse(canonicalJsonString(payload)) as CursorPayloadV1

  it("round-trips every valid payload (values normalised like canonical JSON: -0 -> 0)", async () => {
    await forAllAsync("cursor round trip", cursorPayload, async (payload) => {
      const cursor = await encodeCursor(payload, integrity)
      expect(cursor).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
      const decoded = await decodeCursor(cursor, integrity, 8192, { now: payload.expiresAt === undefined ? Number.MAX_SAFE_INTEGER : payload.expiresAt - 1 })
      expect(decoded).toEqual(canonicalPayload(payload))
      expect(jsonEqual(decoded.values, normaliseZero(payload.values))).toBe(true)
    }, { runs: 400, describe: describeCompact })
  })

  it("rejects any tampering: bit flips, truncation, segment swaps, re-signing with another key", async () => {
    const otherKey = port("another-key")
    await forAllAsync("cursor tamper", (rng) => ({ payload: cursorPayload(rng), seed: rng.next(), kind: rng.int(6) }), async ({ payload, seed, kind }) => {
      const cursor = await encodeCursor(stripExpiry(payload), integrity)
      const [prefix, body, signature] = cursor.split(".") as [string, string, string]
      let tampered: string
      switch (kind) {
        case 0: { // flip one bit of the payload bytes, keep the signature
          const bytes = decodeBase64UrlUnpadded(body)
          bytes[seed % bytes.length]! ^= 1 << (seed % 8)
          tampered = `${prefix}.${encodeBase64UrlUnpadded(bytes)}.${signature}`
          break
        }
        case 1: { // flip one bit of the signature
          const bytes = decodeBase64UrlUnpadded(signature)
          bytes[seed % bytes.length]! ^= 1 << (seed % 8)
          tampered = `${prefix}.${body}.${encodeBase64UrlUnpadded(bytes)}`
          break
        }
        case 2: tampered = cursor.slice(0, cursor.length - 1 - (seed % 4)); break
        case 3: tampered = `${prefix}.${signature}.${body}`; break
        case 4: tampered = await encodeCursor(stripExpiry(payload), otherKey); break
        default: tampered = (seed & 4) === 0 ? `v2.${body}.${signature}` : `${cursor}.`; break
      }
      if (tampered === cursor) return
      await expect(decodeCursor(tampered, integrity, 8192, { now: NOW })).rejects.toThrow(ValidationError)
    }, { runs: 600, describe: describeCompact })
  })

  it("accepts only canonical signed payloads: a re-signed non-canonical spelling is rejected (strict canonical form)", async () => {
    await forAllAsync("cursor strict canonical", (rng) => {
      const payload = stripExpiry(cursorPayload(rng))
      const text = canonicalJsonString(payload)
      const position = rng.int(text.length + 1)
      const variant = rng.pick<() => string>([
        () => `${text.slice(0, position)} ${text.slice(position)}`,
        () => JSON.stringify(permuteKeys(rng, JSON.parse(text))),
        () => text.replace(/"after"|"before"/, (match) => `"\\u00${match.charCodeAt(1).toString(16)}${match.slice(2)}`),
        () => text.replace(/:1,/, ":1.0,"),
        () => text.replace(/"version":1/, "\"version\":1e0"),
        () => `${text.slice(0, position)}${rng.pick(["x", "0", ",", "\"", "}"])}${text.slice(position)}`,
      ])()
      return { payload, variant }
    }, async ({ payload, variant }) => {
      const bytes = textEncoder.encode(variant)
      const cursor = `v1.${encodeBase64UrlUnpadded(bytes)}.${encodeBase64UrlUnpadded(await integrity.sign(bytes))}`
      const result = await decodeCursor(cursor, integrity, 8192, { now: NOW }).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }))
      // The signed bytes are the UTF-8 of the variant (a split surrogate pair becomes U+FFFD).
      const signedText = new TextDecoder().decode(bytes)
      if (result.ok) {
        expect(canonicalJsonString(result.value)).toBe(signedText)
        if (signedText === canonicalJsonString(payload)) expect(result.value).toEqual(canonicalPayload(payload))
      } else {
        expect(result.error).toBeInstanceOf(ValidationError)
      }
    }, { runs: 600, describe: describeCompact })
  })

  it("binds route, query, scope and sort: a cursor validates only against its own four hashes (cross-tenant/swapped hashes rejected)", async () => {
    const keys = ["routeHash", "queryHash", "scopeHash", "sortHash"] as const
    await forAllAsync("cursor binding", (rng) => {
      const payload = stripExpiry(cursorPayload(rng))
      const expected = { routeHash: payload.routeHash, queryHash: payload.queryHash, scopeHash: payload.scopeHash, sortHash: payload.sortHash }
      const mode = rng.int(4)
      if (mode === 1) expected.scopeHash = `${payload.scopeHash}${rng.pick(["x", ":", " "])}` // another tenant's scope hash
      if (mode === 2) {
        const [a, b] = rng.shuffle(keys).slice(0, 2) as [typeof keys[number], typeof keys[number]]
        ;[expected[a], expected[b]] = [expected[b], expected[a]]
      }
      if (mode === 3) expected[rng.pick(keys)] = nonBlankString(rng, { maxAtoms: 1 })
      return { payload, expected }
    }, async ({ payload, expected }) => {
      const decoded = await decodeCursor(await encodeCursor(payload, integrity), integrity, 8192, { now: NOW })
      const matches = keys.every((key) => payload[key] === expected[key])
      if (matches) expect(() => assertCursorBinding(decoded, expected)).not.toThrow()
      else expect(() => assertCursorBinding(decoded, expected)).toThrow(ValidationError)
    }, { runs: 400, describe: describeCompact })
  })

  it("enforces expiry exactly at the boundary and survives key rotation only for listed keys", async () => {
    const previous = port("previous-key")
    const retired = port("retired-key")
    const rotating = createRotatingCursorIntegrity(integrity, [previous])
    await forAllAsync("cursor expiry and rotation", (rng) => ({ payload: { ...stripExpiry(cursorPayload(rng)), expiresAt: 1 + rng.int(1_000_000) }, offset: rng.pick([-1, 0, 1, -1000, 1000]), signer: rng.pick(["current", "previous", "retired"] as const) }), async ({ payload, offset, signer }) => {
      const cursor = await encodeCursor(payload, signer === "current" ? integrity : signer === "previous" ? previous : retired)
      const now = payload.expiresAt + offset
      const outcome = decodeCursor(cursor, rotating, 8192, { now })
      if (signer === "retired" || now >= payload.expiresAt) await expect(outcome).rejects.toThrow(ValidationError)
      else await expect(outcome).resolves.toEqual(canonicalPayload(payload))
    }, { runs: 400, describe: describeCompact })
  })

  it("rejects type-confused payloads at encode time (fields must have their exact JSON types)", async () => {
    const confusions: Record<string, readonly unknown[]> = {
      direction: [["after"], ["before"], { toString: () => "after" }, "AFTER", "after ", null],
      version: ["1", [1], true, 2, 0],
      format: [["framework.cursor"], "framework.cursor ", "Framework.cursor", null],
      values: ["a", [{ nested: 1 }], [[1]], { 0: 1, length: 1 }, null],
      routeHash: [["r"], "", 1, null],
      scopeHash: [["s"], "", { toString: () => "s" }],
      expiresAt: [-1, 1.5, Number.NaN, "100", [5], null],
    }
    await forAllAsync("cursor payload types", (rng) => {
      const field = rng.pick(Object.keys(confusions))
      return { payload: { ...stripExpiry(cursorPayload(rng)), [field]: rng.pick(confusions[field]!) }, field }
    }, async ({ payload }) => {
      await expect(encodeCursor(payload as unknown as CursorPayloadV1, integrity)).rejects.toThrow(ValidationError)
    }, { runs: 400, describe: describeCompact })
  })
})

function stripExpiry(payload: CursorPayloadV1): CursorPayloadV1 {
  const { expiresAt: _expiresAt, ...rest } = payload
  return rest
}

describe("canonical number boundaries", () => {
  it("accepts every boundary number in canonical form and rejects every unsafe/non-finite one", () => {
    for (const number of CANONICAL_NUMBERS) {
      const text = canonicalJsonString(number)
      expect(text).toBe(JSON.stringify(Object.is(number, -0) ? 0 : number))
      expect(decodeCanonicalJson(text)).toBe(Object.is(number, -0) ? 0 : number)
    }
    for (const number of REJECTED_NUMBERS) expect(() => canonicalJsonString(number)).toThrow(CanonicalJsonError)
  })
})
