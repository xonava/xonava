import { describe, expect, it } from "vitest"
import { ConfigurationError, ValidationError } from "../../domain/errors"
import {
  assertDurableRoundTrip,
  decodeDurableValue,
  encodeDurableValue,
  resolveDurableCodec,
  type DurableCodec,
  type DurableCodecRegistry,
} from "../durableCodec"

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function expectValidation(fn: () => unknown, message: string): void {
  const error = caught(fn)
  expect(error).toBeInstanceOf(ValidationError)
  expect((error as ValidationError).message).toBe(message)
}

const identity = (key: string): DurableCodec => ({ key, encode: (value) => value, decode: (value) => value })
const dateCodec: DurableCodec = {
  key: "date",
  encode: (value) => (value as Date).toISOString(),
  decode: (value) => new Date(value as string),
}

describe("resolveDurableCodec", () => {
  it("returns the registered codec by identity", () => {
    const codec = identity("plain")
    expect(resolveDurableCodec({ plain: codec }, "plain")).toBe(codec)
  })

  it("rejects unknown keys with the exact ConfigurationError", () => {
    const error = caught(() => resolveDurableCodec({}, "missing"))
    expect(error).toBeInstanceOf(ConfigurationError)
    expect((error as ConfigurationError).message).toBe("durable codec 'missing' is not registered")
  })

  it("does not resolve inherited properties", () => {
    const inherited: DurableCodecRegistry = Object.create({ proto: identity("proto") }) as DurableCodecRegistry
    expect(caught(() => resolveDurableCodec(inherited, "proto"))).toBeInstanceOf(ConfigurationError)
    expect(caught(() => resolveDurableCodec({}, "constructor"))).toBeInstanceOf(ConfigurationError)
    expect(caught(() => resolveDurableCodec({}, "toString"))).toBeInstanceOf(ConfigurationError)
    expect(caught(() => resolveDurableCodec({}, "__proto__"))).toBeInstanceOf(ConfigurationError)
  })

  it("does not coerce a non-string key to a registered property name", () => {
    const registry: DurableCodecRegistry = { "5": identity("five") }
    const error = caught(() => resolveDurableCodec(registry, 5 as never))
    expect(error).toBeInstanceOf(ConfigurationError)
    expect((error as ConfigurationError).message).toBe("durable codec '5' is not registered")
    expect((caught(() => resolveDurableCodec(registry, undefined as never)) as ConfigurationError).message).toBe("durable codec 'undefined' is not registered")
  })

  it("requires both encode and decode functions", () => {
    const onlyEncode = { key: "e", encode: (value: unknown) => value } as never
    const onlyDecode = { key: "d", decode: (value: unknown) => value } as never
    const notFunctions = { key: "n", encode: 1, decode: 2 } as never
    for (const [name, codec] of [["e", onlyEncode], ["d", onlyDecode], ["n", notFunctions], ["z", undefined as never]] as const) {
      const error = caught(() => resolveDurableCodec({ [name]: codec }, name))
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as ConfigurationError).message).toBe(`durable codec '${name}' is not registered`)
    }
  })
})

describe("encodeDurableValue and decodeDurableValue", () => {
  it("produces a frozen envelope and decodes it back", () => {
    const registry: DurableCodecRegistry = { date: dateCodec }
    const when = new Date("2024-02-29T12:34:56.789Z")
    const envelope = encodeDurableValue(registry, "date", when)
    expect(envelope).toEqual({ codec: "date", value: "2024-02-29T12:34:56.789Z" })
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.keys(envelope)).toEqual(["codec", "value"])
    const decoded = decodeDurableValue(registry, envelope)
    expect(decoded).toBeInstanceOf(Date)
    expect((decoded as Date).getTime()).toBe(when.getTime())
  })

  it("fails for unregistered codec keys on both directions", () => {
    expect(caught(() => encodeDurableValue({}, "nope", 1))).toBeInstanceOf(ConfigurationError)
    expect((caught(() => decodeDurableValue({}, { codec: "nope", value: 1 })) as ConfigurationError).message).toBe("durable codec 'nope' is not registered")
  })
})

describe("assertDurableRoundTrip", () => {
  it("accepts lossless codecs for JSON and non-JSON values", () => {
    expect(caught(() => assertDurableRoundTrip(identity("id"), { b: 1, a: [1, 2, { c: null }] }))).toBeUndefined()
    expect(caught(() => assertDurableRoundTrip(identity("id"), "text"))).toBeUndefined()
    expect(caught(() => assertDurableRoundTrip(dateCodec, new Date("2020-01-01T00:00:00.000Z")))).toBeUndefined()
  })

  it("compares JSON values by canonical form, so key order is irrelevant", () => {
    const reorder: DurableCodec = { key: "reorder", encode: (value) => value, decode: (value) => JSON.parse(JSON.stringify(value, Object.keys(value as object).sort().reverse())) as unknown }
    expect(caught(() => assertDurableRoundTrip(reorder, { a: 1, b: 2 }))).toBeUndefined()
  })

  it("reports an encode failure", () => {
    const codec: DurableCodec = { key: "enc", encode: () => { throw new Error("no") }, decode: (value) => value }
    expectValidation(() => assertDurableRoundTrip(codec, 1), "durable codec 'enc' could not encode the value")
  })

  it("reports a decode failure", () => {
    const codec: DurableCodec = { key: "dec", encode: (value) => value, decode: () => { throw new Error("no") } }
    expectValidation(() => assertDurableRoundTrip(codec, 1), "durable codec 'dec' could not decode its encoded value")
  })

  it("rejects a lossy codec for JSON values", () => {
    const lossy: DurableCodec = { key: "lossy", encode: () => "x", decode: () => "y" }
    expectValidation(() => assertDurableRoundTrip(lossy, "a"), "durable codec 'lossy' did not round-trip the value")
    // even when re-encoding the decoded value would reproduce the same encoding
    const collapsing: DurableCodec = { key: "collapse", encode: () => "same", decode: () => "other" }
    expectValidation(() => assertDurableRoundTrip(collapsing, "a"), "durable codec 'collapse' did not round-trip the value")
  })

  it("rejects when only one side has a canonical form", () => {
    // value has no canonical form (Date) but the decoded value does (string)
    const toText: DurableCodec = { key: "text", encode: (value) => (value as Date).toISOString(), decode: (value) => value }
    expectValidation(() => assertDurableRoundTrip(toText, new Date(0)), "durable codec 'text' did not round-trip the value")
    // value has a canonical form (string) but the decoded value does not (Date)
    const toDate: DurableCodec = { key: "toDate", encode: (value) => value, decode: (value) => new Date(value as string) }
    expectValidation(() => assertDurableRoundTrip(toDate, "2020-01-01T00:00:00.000Z"), "durable codec 'toDate' did not round-trip the value")
  })

  it("rejects a non-JSON value whose re-encoding differs", () => {
    const drifting: DurableCodec = {
      key: "drift",
      encode: (value) => (value as Date).toISOString(),
      decode: (value) => new Date(new Date(value as string).getTime() + 1),
    }
    expectValidation(() => assertDurableRoundTrip(drifting, new Date(0)), "durable codec 'drift' did not round-trip the value")
  })

  it("reports a re-encode failure", () => {
    let calls = 0
    const codec: DurableCodec = {
      key: "reenc",
      encode: (value) => {
        calls += 1
        if (calls > 1) throw new Error("second call fails")
        return (value as Date).toISOString()
      },
      decode: (value) => new Date(value as string),
    }
    expectValidation(() => assertDurableRoundTrip(codec, new Date(0)), "durable codec 'reenc' could not re-encode its decoded value")
  })

  it("requires the encoded form of a non-JSON value to be canonical JSON", () => {
    const bigintCodec: DurableCodec = { key: "big", encode: (value) => value, decode: (value) => value }
    expectValidation(() => assertDurableRoundTrip(bigintCodec, 1n), "durable codec 'big' must encode to canonical JSON")
    const undefinedCodec: DurableCodec = { key: "undef", encode: () => undefined, decode: () => undefined }
    expectValidation(() => assertDurableRoundTrip(undefinedCodec, undefined), "durable codec 'undef' must encode to canonical JSON")
  })

  it("does not swallow unexpected errors raised while canonicalising", () => {
    const boom = new RangeError("boom")
    const hostile = new Proxy({}, { getPrototypeOf() { throw boom } })
    expect(caught(() => assertDurableRoundTrip(identity("id"), hostile))).toBe(boom)
  })
})
