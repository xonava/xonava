import { describe, expect, it } from "vitest"
import { ValidationError } from "../../domain/errors"
import { CanonicalJsonError, canonicalJsonString, canonicalizeValue, decodeCanonicalJson } from "../canonicalJson"
import { assertDurableRoundTrip, type DurableCodec } from "../durableCodec"
import { FORMAT_DEFAULT_MAX_BYTES_BY_FORMAT } from "../formatRegistry"

describe("canonical JSON reserved keys", () => {
  it("accepts constructor and prototype as ordinary data keys on null-prototype output", () => {
    expect(canonicalJsonString({ constructor: "x", prototype: 1 })).toBe('{"constructor":"x","prototype":1}')
    const decoded = decodeCanonicalJson('{"constructor":"x","prototype":1}') as Record<string, unknown>
    expect(Object.getPrototypeOf(decoded)).toBeNull()
    expect(decoded.constructor).toBe("x")
    expect(decoded.prototype).toBe(1)
  })

  it("still rejects __proto__ on encode and decode", () => {
    const parsed = JSON.parse('{"__proto__":1}') as Record<string, unknown>
    expect(() => canonicalizeValue(parsed)).toThrow(CanonicalJsonError)
    expect(() => decodeCanonicalJson('{"__proto__":1}')).toThrow(CanonicalJsonError)
  })

  it("rejects non-enumerable own object properties like arrays do", () => {
    const value = { visible: 1 }
    Object.defineProperty(value, "hidden", { value: 2, enumerable: false })
    expect(() => canonicalizeValue(value)).toThrow(CanonicalJsonError)
  })
})

describe("durable codec round trip", () => {
  it("rejects a codec that does not restore the original value", () => {
    const lossy: DurableCodec<number, string> = { key: "lossy", encode: value => String(Math.round(value)), decode: value => Number(value) }
    expect(() => assertDurableRoundTrip(lossy, 1.5)).toThrow(ValidationError)
    expect(() => assertDurableRoundTrip(lossy, 2)).not.toThrow()
  })

  it("accepts lossless codecs for values without a canonical JSON form", () => {
    const date: DurableCodec<Date, string> = { key: "date", encode: value => value.toISOString(), decode: value => new Date(value) }
    expect(() => assertDurableRoundTrip(date, new Date("2026-01-02T03:04:05.678Z"))).not.toThrow()
    const big: DurableCodec<bigint, string> = { key: "bigint", encode: value => value.toString(), decode: value => BigInt(value) }
    expect(() => assertDurableRoundTrip(big, 2n ** 70n)).not.toThrow()
  })

  it("rejects a lossy codec for values without a canonical JSON form", () => {
    const unstable: DurableCodec<bigint, string> = { key: "unstable", encode: value => value.toString(), decode: value => BigInt(value) + 1n }
    expect(() => assertDurableRoundTrip(unstable, 5n)).toThrow(ValidationError)
  })

  it("compares structured values canonically", () => {
    const codec: DurableCodec<Record<string, unknown>, string> = { key: "json", encode: value => JSON.stringify(value), decode: value => JSON.parse(value) as Record<string, unknown> }
    expect(() => assertDurableRoundTrip(codec, { b: 1, a: [1, "x"] })).not.toThrow()
    const dropping: DurableCodec<Record<string, unknown>, string> = { key: "drop", encode: () => "{}", decode: value => JSON.parse(value) as Record<string, unknown> }
    expect(() => assertDurableRoundTrip(dropping, { a: 1 })).toThrow(ValidationError)
  })
})

describe("format registry constants", () => {
  it("freezes the per-format default byte limits", () => {
    expect(Object.isFrozen(FORMAT_DEFAULT_MAX_BYTES_BY_FORMAT)).toBe(true)
  })
})
