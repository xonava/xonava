import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { SERIALIZATION_LIMIT_EXCEEDED_ERROR } from "../../spec/formatVersions"
import { CanonicalJsonError, canonicalJsonString } from "../canonicalJson"
import {
  fingerprintCursorQuery,
  fingerprintIdempotency,
  fingerprintOutbox,
  fingerprintWithDomainSeparator,
} from "../fingerprint"

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

const SEPARATOR_MESSAGE = "domainSeparator must look like `name(:segment)*:v<n>:` (lowercase)"

describe("fingerprint digests", () => {
  it("hashes separator followed by canonical JSON, with canonical key order", () => {
    const value = { b: [1, "x", null], a: { z: true, y: -0 } }
    const canonical = '{"a":{"y":0,"z":true},"b":[1,"x",null]}'
    expect(canonicalJsonString(value)).toBe(canonical)
    expect(fingerprintWithDomainSeparator("app:v1:", value)).toBe(sha256(`app:v1:${canonical}`))
    expect(fingerprintIdempotency(value)).toBe(sha256(`framework:idempotency:v1:${canonical}`))
    expect(fingerprintOutbox(value)).toBe(sha256(`framework:outbox:v1:${canonical}`))
    expect(fingerprintCursorQuery(value)).toBe(sha256(`framework:cursor-query:v1:${canonical}`))
  })

  it("pins exact digests for a fixed input", () => {
    expect(fingerprintIdempotency({ a: 1 })).toBe("00165f505c0247fd17095096b6c89474300272ad457b9991946fa0974fcf4f1c")
    expect(fingerprintOutbox({ a: 1 })).toBe("ec2e67d28c3e4a8eab568c606784eb2548d1e4569c63971413d2bf14bbecfe47")
    expect(fingerprintCursorQuery({ a: 1 })).toBe("fcb720c3d1827ca2016a6e5cc5754934ce1652258ae4e86cc6d589d3eb9f28af")
  })

  it("is independent of insertion order and sensitive to every value", () => {
    expect(fingerprintOutbox({ a: 1, b: 2 })).toBe(fingerprintOutbox({ b: 2, a: 1 }))
    expect(fingerprintOutbox({ a: 1, b: 2 })).not.toBe(fingerprintOutbox({ a: 1, b: 3 }))
    expect(fingerprintOutbox([1, 2])).not.toBe(fingerprintOutbox([2, 1]))
    expect(fingerprintOutbox("1")).not.toBe(fingerprintOutbox(1))
  })
})

describe("fingerprint domain separator grammar", () => {
  it("accepts well-formed separators", () => {
    for (const separator of ["a:v1:", "abc:v10:", "a0-b:v0:", "abc-d:x-1:y:v10:", "framework:idempotency:v1:", "z9:9-:v123456:"]) {
      expect(caught(() => fingerprintWithDomainSeparator(separator, 1))).toBeUndefined()
      expect(fingerprintWithDomainSeparator(separator, 1)).toBe(sha256(`${separator}1`))
    }
  })

  it("rejects malformed separators with the exact CanonicalJsonError", () => {
    const bad = [
      " a:v1:", // leading space: ^ anchor
      "a:v1: ", // trailing space: $ anchor
      "\na:v1:",
      "a:v1:\n",
      "a:v1:x", // text after the version segment
      "x a:v1:",
      "A:v1:", // uppercase first character
      "1a:v1:", // first character must be a letter
      "-a:v1:",
      ":a:v1:",
      "aB:v1:", // uppercase later in first segment
      "a_b:v1:", // underscore in first segment
      "a b:v1:",
      "a:b_c:v1:", // underscore in a middle segment
      "a:B:v1:",
      "a::v1:", // empty segment
      "a:v:", // version without digits
      "a:v1", // missing trailing colon
      "a:V1:",
      "a:v1x:",
      "a:vx1:",
      "a:1:", // no version marker
      "a:v-1:",
      "a:v1.5:",
      "",
      ":",
      "v1:",
      "a",
    ]
    for (const separator of bad) {
      const error = caught(() => fingerprintWithDomainSeparator(separator, 1))
      expect(error, JSON.stringify(separator)).toBeInstanceOf(CanonicalJsonError)
      expect((error as CanonicalJsonError).message).toBe(SEPARATOR_MESSAGE)
      expect((error as CanonicalJsonError).code).toBeUndefined()
    }
  })

  it("rejects non-string separators", () => {
    for (const separator of [undefined, null, 1, {}, ["a:v1:"], Symbol("a")]) {
      const error = caught(() => fingerprintWithDomainSeparator(separator as never, 1))
      expect(error).toBeInstanceOf(CanonicalJsonError)
      expect((error as CanonicalJsonError).message).toBe(SEPARATOR_MESSAGE)
    }
    const stringLike = { test: () => true, toString: () => "a:v1:" }
    expect(caught(() => fingerprintWithDomainSeparator(stringLike as never, 1))).toBeInstanceOf(CanonicalJsonError)
  })

  it("rejects a separator before canonicalising the value", () => {
    const error = caught(() => fingerprintWithDomainSeparator("BAD", () => undefined))
    expect((error as CanonicalJsonError).message).toBe(SEPARATOR_MESSAGE)
  })
})

describe("fingerprint size limits", () => {
  // canonical JSON of a string of n ASCII characters is n + 2 bytes (the quotes)
  const stringFor = (limit: number, separator: string, extra = 0): string =>
    "a".repeat(limit - separator.length - 2 + extra)

  it("allows the cursor-query input up to exactly 16 KiB and rejects one byte more", () => {
    const separator = "framework:cursor-query:v1:"
    const limit = 16 * 1024
    const atLimit = stringFor(limit, separator)
    expect(fingerprintCursorQuery(atLimit)).toBe(sha256(`${separator}"${atLimit}"`))
    const error = caught(() => fingerprintCursorQuery(stringFor(limit, separator, 1)))
    expect(error).toBeInstanceOf(CanonicalJsonError)
    expect((error as CanonicalJsonError).code).toBe(SERIALIZATION_LIMIT_EXCEEDED_ERROR)
    expect((error as CanonicalJsonError).message).toBe(`fingerprint input bytes ${limit + 1} exceeds format limit ${limit}`)
  })

  it("allows idempotency, outbox and custom separators up to exactly 1 MiB and rejects one byte more", () => {
    const limit = 1024 * 1024
    const cases: [string, (value: unknown) => string][] = [
      ["framework:idempotency:v1:", fingerprintIdempotency],
      ["framework:outbox:v1:", fingerprintOutbox],
      ["custom:v2:", (value) => fingerprintWithDomainSeparator("custom:v2:", value)],
    ]
    for (const [separator, fingerprint] of cases) {
      const atLimit = stringFor(limit, separator)
      expect(fingerprint(atLimit)).toBe(sha256(`${separator}"${atLimit}"`))
      const error = caught(() => fingerprint(stringFor(limit, separator, 1)))
      expect(error).toBeInstanceOf(CanonicalJsonError)
      expect((error as CanonicalJsonError).code).toBe(SERIALIZATION_LIMIT_EXCEEDED_ERROR)
      expect((error as CanonicalJsonError).message).toBe(`fingerprint input bytes ${limit + 1} exceeds format limit ${limit}`)
    }
  })

  it("counts separator bytes in UTF-8 and lets larger inputs through the non-cursor limit", () => {
    // a 20 KiB value is far over the cursor limit but fine for the other domains
    const big = "b".repeat(20 * 1024)
    expect(fingerprintIdempotency(big)).toBe(sha256(`framework:idempotency:v1:"${big}"`))
    expect(fingerprintOutbox(big)).toBe(sha256(`framework:outbox:v1:"${big}"`))
    const error = caught(() => fingerprintCursorQuery(big))
    expect((error as CanonicalJsonError).message).toBe(`fingerprint input bytes ${"framework:cursor-query:v1:".length + big.length + 2} exceeds format limit 16384`)
    // multi-byte characters count by encoded bytes: 3 bytes each
    const euro = "€".repeat(5500)
    const encodedBytes = "framework:cursor-query:v1:".length + 5500 * 3 + 2
    expect(encodedBytes).toBeGreaterThan(16 * 1024)
    expect((caught(() => fingerprintCursorQuery(euro)) as CanonicalJsonError).message).toBe(`fingerprint input bytes ${encodedBytes} exceeds format limit 16384`)
  })

  it("surfaces canonical JSON errors for unsupported values", () => {
    expect(caught(() => fingerprintIdempotency(undefined))).toBeInstanceOf(CanonicalJsonError)
    expect(caught(() => fingerprintOutbox(Number.NaN))).toBeInstanceOf(CanonicalJsonError)
  })
})
