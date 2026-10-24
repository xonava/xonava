import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { CANONICAL_JSON_LIMITS_V1, SERIALIZATION_LIMIT_EXCEEDED_ERROR } from "../../spec/formatVersions"
import {
  CanonicalJsonError,
  assertRfc3339Millis,
  canonicalJsonBytes,
  canonicalJsonString,
  canonicalSha256Bytes,
  canonicalSha256Hex,
  canonicalizeValue,
  decodeBase64UrlUnpadded,
  encodeBase64UrlUnpadded,
  isValidRfc3339Millis,
  legacyJavaScriptOrderJsonString,
} from "../canonicalJson"

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function expectCanonicalError(fn: () => unknown, message: string, code?: string): void {
  const error = caught(fn)
  expect(error).toBeInstanceOf(CanonicalJsonError)
  expect((error as CanonicalJsonError).message).toBe(message)
  expect((error as CanonicalJsonError).code).toBe(code)
}

const LIMIT = SERIALIZATION_LIMIT_EXCEEDED_ERROR
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

/** Nests `levels` arrays around the leaf 1, so the leaf sits at depth `levels`. */
function nested(levels: number): unknown {
  let value: unknown = 1
  for (let level = 0; level < levels; level++) value = [value]
  return value
}

describe("CanonicalJsonError", () => {
  it("has a stable name and optional code and cause", () => {
    const plain = new CanonicalJsonError("m")
    expect(plain.name).toBe("CanonicalJsonError")
    expect(plain.message).toBe("m")
    expect(plain.code).toBeUndefined()
    expect(Object.hasOwn(plain, "cause")).toBe(false)
    expect(plain).toBeInstanceOf(Error)

    const cause = new RangeError("root")
    const wrapped = new CanonicalJsonError("outer", { code: "SOME_CODE", cause })
    expect(wrapped.code).toBe("SOME_CODE")
    expect(wrapped.cause).toBe(cause)
    // falsy but defined causes are still recorded
    expect(new CanonicalJsonError("m", { cause: null }).cause).toBeNull()
    expect(new CanonicalJsonError("m", { cause: 0 }).cause).toBe(0)
    expect(Object.hasOwn(new CanonicalJsonError("m", { code: "C" }), "cause")).toBe(false)
  })
})

describe("lone surrogates", () => {
  const lone = ["\ud800", "\udbff", "\udc00", "\udfff", "a\ud800", "\ud800a", "\ud800\ud800", "\ud800\udbff", "\ud800\ue000", "\udc00\ud800", "\udfffa", "a\udc00", "\ud83d"]

  it("rejects lone surrogates in strings with the exact error", () => {
    for (const value of lone) {
      expectCanonicalError(() => canonicalJsonString(value), "string contains lone surrogate")
      expectCanonicalError(() => canonicalizeValue([value]), "string contains lone surrogate")
    }
  })

  it("rejects lone surrogates in property names, quoting the escaped name", () => {
    expectCanonicalError(() => canonicalizeValue({ "\ud800": 1 }), 'property name contains lone surrogate: "\\ud800"')
    expectCanonicalError(() => canonicalizeValue({ "a\udfff": 1 }), 'property name contains lone surrogate: "a\\udfff"')
  })

  it("accepts well-formed surrogate pairs at every boundary", () => {
    for (const value of ["\ud800\udc00", "\ud800\udfff", "\udbff\udc00", "\udbff\udfff", "\ud83d\ude00", "a\ud83d\ude00b", "\ud83d\ude00\ud83d\ude00"]) {
      expect(canonicalJsonString(value)).toBe(`"${value}"`)
      expect(canonicalJsonString({ [value]: 1 })).toBe(`{"${value}":1}`)
    }
    expect(canonicalJsonString("\ue000\u{10ffff}\uffff")).toBe('"\ue000\u{10ffff}\uffff"')
  })
})

describe("base64url", () => {
  it("encodes the RFC 4648 vectors without padding", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "Zg"],
      ["fo", "Zm8"],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg"],
      ["fooba", "Zm9vYmE"],
      ["foobar", "Zm9vYmFy"],
    ]
    for (const [text, encoded] of vectors) {
      expect(encodeBase64UrlUnpadded(utf8(text))).toBe(encoded)
      expect(new TextDecoder().decode(decodeBase64UrlUnpadded(encoded))).toBe(text)
    }
  })

  it("uses the URL alphabet and agrees with Buffer for every length", () => {
    expect(encodeBase64UrlUnpadded(Uint8Array.from([0xfb, 0xff, 0xbf]))).toBe("-_-_")
    expect(encodeBase64UrlUnpadded(Uint8Array.from([0xfb, 0xef, 0xbe]))).toBe("----")
    expect(encodeBase64UrlUnpadded(Uint8Array.from([0xff]))).toBe("_w")
    expect(encodeBase64UrlUnpadded(Uint8Array.from([0xfe, 0xff]))).toBe("_v8")
    let seed = 12345
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
    for (let length = 0; length <= 70; length++) {
      const bytes = Uint8Array.from({ length }, () => next() & 0xff)
      const expected = Buffer.from(bytes).toString("base64url")
      expect(encodeBase64UrlUnpadded(bytes)).toBe(expected)
      expect(Array.from(decodeBase64UrlUnpadded(expected))).toEqual(Array.from(bytes))
    }
    const every = Uint8Array.from({ length: 256 }, (_, index) => index)
    expect(encodeBase64UrlUnpadded(every)).toBe(Buffer.from(every).toString("base64url"))
    expect(Array.from(decodeBase64UrlUnpadded(encodeBase64UrlUnpadded(every)))).toEqual(Array.from(every))
  })

  it("rejects non Uint8Array input to the encoder", () => {
    for (const bad of ["abc", [1, 2], null, undefined, new ArrayBuffer(2), { length: 0 }]) {
      expectCanonicalError(() => encodeBase64UrlUnpadded(bad as never), "encodeBase64UrlUnpadded expects Uint8Array")
    }
    expect(encodeBase64UrlUnpadded(Buffer.from("foo"))).toBe("Zm9v")
  })

  it("decodes the empty string to an empty array and rejects non-strings", () => {
    const empty = decodeBase64UrlUnpadded("")
    expect(empty).toBeInstanceOf(Uint8Array)
    expect(empty.length).toBe(0)
    for (const bad of [undefined, null, 1, ["Zg"], new Uint8Array(2)]) {
      expectCanonicalError(() => decodeBase64UrlUnpadded(bad as never), "decodeBase64UrlUnpadded expects string")
    }
  })

  it("rejects characters outside the unpadded URL alphabet", () => {
    for (const bad of ["Zg==", "Zg=", "Z+8", "Z/8", "Zm 9v", "Zm9v\n", "\nZm9v", "Zm9v ", "Zm\u00e99v", "Zm9\u0000", "Z\uff21"]) {
      expectCanonicalError(() => decodeBase64UrlUnpadded(bad), "invalid base64url characters")
    }
  })

  it("rejects lengths of 1 modulo 4", () => {
    for (const bad of ["A", "AAAAA", "AAAAAAAAA", "Zm9vY"]) {
      expectCanonicalError(() => decodeBase64UrlUnpadded(bad), "invalid base64url length")
    }
  })

  it("rejects non-canonical trailing bits and accepts the canonical spelling", () => {
    // two-character tail: the low 4 bits of the last character must be zero
    for (const bad of ["Zh", "Zi", "Zx", "ZP", "AB", "A_"]) {
      expectCanonicalError(() => decodeBase64UrlUnpadded(bad), "non-canonical base64url encoding")
    }
    // three-character tail: the low 2 bits must be zero
    for (const bad of ["Zm9", "Zm-", "Zm_", "Zm1"]) {
      expectCanonicalError(() => decodeBase64UrlUnpadded(bad), "non-canonical base64url encoding")
    }
    expect(Array.from(decodeBase64UrlUnpadded("Zg"))).toEqual([0x66])
    expect(Array.from(decodeBase64UrlUnpadded("Zm8"))).toEqual([0x66, 0x6f])
    expect(Array.from(decodeBase64UrlUnpadded("AA"))).toEqual([0])
    expect(Array.from(decodeBase64UrlUnpadded("_w"))).toEqual([0xff])
    expect(Array.from(decodeBase64UrlUnpadded("AAA"))).toEqual([0, 0])
    expect(Array.from(decodeBase64UrlUnpadded("__8"))).toEqual([0xff, 0xff])
    // a full group has no spare bits, so every spelling is canonical
    expect(Array.from(decodeBase64UrlUnpadded("____"))).toEqual([0xff, 0xff, 0xff])
  })
})

describe("RFC 3339 millisecond timestamps", () => {
  it("accepts exactly the canonical UTC millisecond spelling", () => {
    for (const value of ["2024-02-29T12:34:56.789Z", "1970-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "2000-01-01T00:00:00.001Z"]) {
      expect(isValidRfc3339Millis(value)).toBe(true)
      expect(assertRfc3339Millis(value)).toBeUndefined()
    }
  })

  it("rejects every other spelling", () => {
    const bad = [
      "",
      " 2024-02-29T12:34:56.789Z",
      "2024-02-29T12:34:56.789Z ",
      "2024-02-29T12:34:56.789Z\n",
      "x2024-02-29T12:34:56.789Z",
      "2024-02-29T12:34:56.789Zx",
      "2024-02-29T12:34:56Z",
      "2024-02-29T12:34:56.78Z",
      "2024-02-29T12:34:56.7890Z",
      "2024-02-29T12:34:56.789+00:00",
      "2024-02-29T12:34:56.789z",
      "2024-02-29t12:34:56.789Z",
      "2024-02-29 12:34:56.789Z",
      "24-02-29T12:34:56.789Z",
      "2024-2-29T12:34:56.789Z",
      "2024-02-29T12:34:56.789",
      "2024-13-01T00:00:00.000Z", // matches the pattern but is not a date
      "2024-00-10T00:00:00.000Z",
      "2023-02-29T00:00:00.000Z", // not a leap year: would normalise to 03-01
      "2024-04-31T00:00:00.000Z",
      "2024-01-01T24:00:00.000Z",
      "2024-01-01T00:60:00.000Z",
    ]
    for (const value of bad) {
      expect(isValidRfc3339Millis(value), value).toBe(false)
      expectCanonicalError(() => assertRfc3339Millis(value), `invalid RFC3339 UTC milliseconds timestamp: ${JSON.stringify(value)}`)
    }
  })

  it("rejects non-strings without throwing", () => {
    for (const value of [undefined, null, 0, 1700000000000, new Date(0), {}, ["2024-02-29T12:34:56.789Z"]]) {
      expect(isValidRfc3339Millis(value as never)).toBe(false)
      expectCanonicalError(() => assertRfc3339Millis(value as never), `invalid RFC3339 UTC milliseconds timestamp: ${JSON.stringify(value)}`)
    }
  })
})

describe("canonicalizeValue scalars", () => {
  it("normalises -0 to a positive zero and keeps other numbers", () => {
    expect(Object.is(canonicalizeValue(-0), 0)).toBe(true)
    expect(Object.is(canonicalizeValue(0), 0)).toBe(true)
    expect(Object.is((canonicalizeValue([-0]) as number[])[0], 0)).toBe(true)
    expect(canonicalizeValue(1.5)).toBe(1.5)
    expect(canonicalizeValue(-3)).toBe(-3)
    expect(canonicalizeValue(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(canonicalizeValue(Number.MIN_SAFE_INTEGER)).toBe(Number.MIN_SAFE_INTEGER)
    expect(canonicalizeValue(Number.MIN_VALUE)).toBe(Number.MIN_VALUE)
    expect(canonicalizeValue(null)).toBeNull()
    expect(canonicalizeValue(true)).toBe(true)
    expect(canonicalizeValue(false)).toBe(false)
    expect(canonicalizeValue("")).toBe("")
  })

  it("renders numbers in ECMAScript form (RFC 8785 section 3.2.2.3)", () => {
    const cases: [number, string][] = [
      [0, "0"],
      [-0, "0"],
      [1, "1"],
      [-1, "-1"],
      [0.1, "0.1"],
      [1e-7, "1e-7"],
      [0.000001, "0.000001"],
      [5e-324, "5e-324"],
      [4.5, "4.5"],
      [2e-3, "0.002"],
      [Number.MAX_SAFE_INTEGER, "9007199254740991"],
      [Number.MIN_SAFE_INTEGER, "-9007199254740991"],
    ]
    for (const [value, text] of cases) {
      expect(canonicalJsonString(value)).toBe(text)
    }
    expect(canonicalJsonString(0.1 + 0.2)).toBe("0.30000000000000004")
    expect(canonicalJsonString(1e-7)).toBe("1e-7")
  })

  it("rejects NaN, infinities and integers beyond the safe range", () => {
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      expectCanonicalError(() => canonicalizeValue(value), "Canonical JSON does not accept NaN or Infinity")
    }
    expectCanonicalError(
      () => canonicalizeValue(Number.MAX_SAFE_INTEGER + 1),
      "integer 9007199254740992 outside safe integer range; encode as typed string via domain codec",
    )
    expectCanonicalError(
      () => canonicalizeValue(Number.MIN_SAFE_INTEGER - 1),
      "integer -9007199254740992 outside safe integer range; encode as typed string via domain codec",
    )
    expectCanonicalError(() => canonicalizeValue(Number.MAX_VALUE), "integer 1.7976931348623157e+308 outside safe integer range; encode as typed string via domain codec")
    expectCanonicalError(() => canonicalizeValue(1e21), "integer 1e+21 outside safe integer range; encode as typed string via domain codec")
    expectCanonicalError(() => canonicalizeValue(2 ** 60), "integer 1152921504606847000 outside safe integer range; encode as typed string via domain codec")
  })

  it("rejects undefined, bigint, function and symbol with their own messages", () => {
    expectCanonicalError(() => canonicalizeValue(undefined), "Canonical JSON does not accept undefined")
    expectCanonicalError(() => canonicalizeValue(1n), "Canonical JSON does not accept bigint")
    expectCanonicalError(() => canonicalizeValue(() => 1), "Canonical JSON does not accept function")
    expectCanonicalError(() => canonicalizeValue(class Foo {}), "Canonical JSON does not accept function")
    expectCanonicalError(() => canonicalizeValue(Symbol("s")), "Canonical JSON does not accept symbol")
    expectCanonicalError(() => canonicalizeValue([undefined]), "Canonical JSON does not accept undefined")
    expectCanonicalError(() => canonicalizeValue({ a: 1n }), "Canonical JSON does not accept bigint")
    expectCanonicalError(() => canonicalizeValue({ a: { b: Symbol("x") } }), "Canonical JSON does not accept symbol")
  })

  it("rejects Date instances", () => {
    const message = "Date instances must be encoded as RFC3339 UTC millisecond strings, not Date objects"
    expectCanonicalError(() => canonicalizeValue(new Date(0)), message)
    expectCanonicalError(() => canonicalizeValue({ at: new Date(0) }), message)
  })
})

describe("canonicalizeValue arrays", () => {
  it("copies arrays and allows shared (non-circular) references", () => {
    const shared = [1, 2]
    const input = [shared, shared, { s: shared }]
    const output = canonicalizeValue(input) as unknown[]
    expect(output).toEqual([[1, 2], [1, 2], { s: [1, 2] }])
    expect(output).not.toBe(input)
    expect(output[0]).not.toBe(shared)
    expect(canonicalJsonString(input)).toBe('[[1,2],[1,2],{"s":[1,2]}]')
    const sharedObject = { k: 1 }
    expect(canonicalJsonString([sharedObject, sharedObject, { a: sharedObject, b: sharedObject }])).toBe('[{"k":1},{"k":1},{"a":{"k":1},"b":{"k":1}}]')
  })

  it("rejects array subclasses", () => {
    class Sub extends Array<number> {}
    expectCanonicalError(() => canonicalizeValue(Sub.from([1, 2])), "Canonical JSON does not accept array subclasses")
    const proto = [1]
    Object.setPrototypeOf(proto, null)
    expectCanonicalError(() => canonicalizeValue(proto), "Canonical JSON does not accept array subclasses")
  })

  it("rejects circular arrays and circular objects reached through arrays", () => {
    const loop: unknown[] = []
    loop.push(loop)
    expectCanonicalError(() => canonicalizeValue(loop), "circular reference in array")
    const indirect: unknown[] = []
    indirect.push([indirect])
    expectCanonicalError(() => canonicalizeValue(indirect), "circular reference in array")
    const owner: Record<string, unknown> = {}
    owner["list"] = [owner]
    expectCanonicalError(() => canonicalizeValue(owner), "circular reference in object")
  })

  it("rejects symbol keys, sparse arrays, extra properties and accessor elements", () => {
    const withSymbol: unknown[] = [1]
    Object.defineProperty(withSymbol, Symbol("k"), { value: 1, enumerable: true })
    expectCanonicalError(() => canonicalizeValue(withSymbol), "Canonical JSON does not accept symbol keys")

    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3]
    expectCanonicalError(() => canonicalizeValue(sparse), "Canonical JSON arrays must be dense and cannot contain extra properties")
    const extra = [1] as unknown[] & { note?: string }
    extra.note = "x"
    expectCanonicalError(() => canonicalizeValue(extra), "Canonical JSON arrays must be dense and cannot contain extra properties")
    const hole = new Array(2)
    expectCanonicalError(() => canonicalizeValue(hole), "Canonical JSON arrays must be dense and cannot contain extra properties")

    const accessor: unknown[] = [0]
    Object.defineProperty(accessor, "0", { get: () => 1, enumerable: true, configurable: true })
    expectCanonicalError(() => canonicalizeValue(accessor), "Canonical JSON arrays must contain enumerable data properties")
    const hidden: unknown[] = [0]
    Object.defineProperty(hidden, "0", { value: 1, enumerable: false, configurable: true })
    expectCanonicalError(() => canonicalizeValue(hidden), "Canonical JSON arrays must contain enumerable data properties")
    const lateAccessor: unknown[] = [1, 2]
    Object.defineProperty(lateAccessor, "1", { get: () => 2, enumerable: true, configurable: true })
    expectCanonicalError(() => canonicalizeValue(lateAccessor), "Canonical JSON arrays must contain enumerable data properties")
  })
})

describe("canonicalizeValue objects", () => {
  it("returns null-prototype copies with sorted keys", () => {
    const output = canonicalizeValue({ b: 1, a: { d: 2, c: 3 } }) as Record<string, unknown>
    expect(Object.getPrototypeOf(output)).toBeNull()
    expect(Object.keys(output)).toEqual(["a", "b"])
    expect(Object.keys(output["a"] as object)).toEqual(["c", "d"])
    const bare = Object.create(null) as Record<string, unknown>
    bare["z"] = 1
    expect(canonicalJsonString(bare)).toBe('{"z":1}')
    expect(canonicalJsonString({ constructor: 1, prototype: 2, toString: 3 })).toBe('{"constructor":1,"prototype":2,"toString":3}')
  })

  it("rejects non-plain objects", () => {
    const message = "Canonical JSON does not accept class, Map, Set, or non-plain object instances"
    class Point {
      x = 1
    }
    expectCanonicalError(() => canonicalizeValue(new Point()), message)
    expectCanonicalError(() => canonicalizeValue(new Map()), message)
    expectCanonicalError(() => canonicalizeValue(new Set()), message)
    expectCanonicalError(() => canonicalizeValue(new Uint8Array(2)), message)
    expectCanonicalError(() => canonicalizeValue(/x/), message)
    expectCanonicalError(() => canonicalizeValue(new Error("e")), message)
    expectCanonicalError(() => canonicalizeValue(Object.create({ inherited: 1 })), message)
    expectCanonicalError(() => canonicalizeValue({ nested: new Point() }), message)
  })

  it("rejects circular objects", () => {
    const loop: Record<string, unknown> = {}
    loop["self"] = loop
    expectCanonicalError(() => canonicalizeValue(loop), "circular reference in object")
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { a }
    a["b"] = b
    expectCanonicalError(() => canonicalizeValue(a), "circular reference in object")
  })

  it("rejects symbol keys, hidden properties, accessors and __proto__", () => {
    const withSymbol: Record<string | symbol, unknown> = { a: 1 }
    withSymbol[Symbol("hidden")] = 2
    expectCanonicalError(() => canonicalizeValue(withSymbol), "Canonical JSON does not accept symbol keys")

    const hidden: Record<string, unknown> = { a: 1 }
    Object.defineProperty(hidden, "secret", { value: 2, enumerable: false })
    expectCanonicalError(() => canonicalizeValue(hidden), "Canonical JSON does not accept non-enumerable object properties")

    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "a", { get: () => 1, enumerable: true, configurable: true })
    expectCanonicalError(() => canonicalizeValue(accessor), "Canonical JSON does not accept accessors")

    const proto = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as unknown
    expectCanonicalError(() => canonicalizeValue(proto), "Canonical JSON does not accept objects with __proto__ as an own key")
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined()
  })

  it("sorts keys by UTF-16 code units, not numerically and not by code point", () => {
    expect(canonicalJsonString({ "9": 1, "10": 2, b: 3, a: 4, "": 5, "1": 6 })).toBe('{"":5,"1":6,"10":2,"9":1,"a":4,"b":3}')
    // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FFFF in UTF-16 order
    expect(canonicalJsonString({ "\uffff": 1, "\u{1f600}": 2 })).toBe('{"\u{1f600}":2,"\uffff":1}')
    expect(canonicalJsonString({ "\u00e9": 1, z: 2, Z: 3, "\u0000": 4 })).toBe('{"\\u0000":4,"Z":3,"z":2,"\u00e9":1}')
    expect(canonicalJsonString({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJsonString({ aa: 1, a: 2, ab: 3, b: 4 })).toBe('{"a":2,"aa":1,"ab":3,"b":4}')
  })

  it("sorts many shuffled keys completely", () => {
    let seed = 99
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
    const keys = Array.from({ length: 300 }, (_, index) => `k${(next() % 1000).toString(36)}-${index}`)
    const input: Record<string, number> = {}
    for (const key of keys) input[key] = 1
    const expected = [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    const text = canonicalJsonString(input)
    expect(text).toBe(`{${expected.map((key) => `${JSON.stringify(key)}:1`).join(",")}}`)
    const reversed: Record<string, number> = {}
    for (const key of [...expected].reverse()) reversed[key] = 1
    expect(canonicalJsonString(reversed)).toBe(text)
    const ascending: Record<string, number> = {}
    for (const key of expected) ascending[key] = 1
    expect(canonicalJsonString(ascending)).toBe(text)
  })

  it("emits strings with JSON escapes and keeps U+0000, U+2028 and astral characters", () => {
    expect(canonicalJsonString("a\u0000b")).toBe('"a\\u0000b"')
    expect(canonicalJsonString("\b\f\n\r\t\"\\/")).toBe('"\\b\\f\\n\\r\\t\\"\\\\/"')
    expect(canonicalJsonString("\u001f\u007f")).toBe('"\\u001f\u007f"')
    expect(canonicalJsonString("\u2028\u2029")).toBe('"\u2028\u2029"')
    expect(canonicalJsonString("\u{1f600}")).toBe('"\u{1f600}"')
    expect(canonicalJsonString({ "a\u0000b": "\u0000" })).toBe('{"a\\u0000b":"\\u0000"}')
  })
})

describe("canonical output and digests", () => {
  it("produces compact output for nested values", () => {
    expect(canonicalJsonString({ z: [1, { y: null, x: [] }, "s"], a: {} })).toBe('{"a":{},"z":[1,{"x":[],"y":null},"s"]}')
    expect(canonicalJsonString([])).toBe("[]")
    expect(canonicalJsonString({})).toBe("{}")
    expect(canonicalJsonString([[], [[]], {}])).toBe("[[],[[]],{}]")
    expect(canonicalJsonString(null)).toBe("null")
    expect(canonicalJsonString(true)).toBe("true")
    expect(canonicalJsonString("x")).toBe('"x"')
    expect(canonicalJsonString(0)).toBe("0")
  })

  it("returns UTF-8 bytes of the canonical string", () => {
    const value = { b: "\u00e9\u20ac\u{1f600}", a: 1 }
    const text = canonicalJsonString(value)
    expect(Array.from(canonicalJsonBytes(value))).toEqual(Array.from(utf8(text)))
    expect(canonicalJsonBytes(value)).toBeInstanceOf(Uint8Array)
    expect(canonicalJsonBytes(value).byteLength).toBe(Buffer.byteLength(text, "utf8"))
  })

  it("hashes the canonical bytes with SHA-256", () => {
    expect(canonicalSha256Hex({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862")
    expect(canonicalSha256Hex({ b: [true, null], a: "\u00e9" })).toBe(createHash("sha256").update('{"a":"\u00e9","b":[true,null]}', "utf8").digest("hex"))
    expect(canonicalSha256Hex({ b: 2, a: 1 })).toBe(canonicalSha256Hex({ a: 1, b: 2 }))
    expect(canonicalSha256Hex({ a: 1 })).not.toBe(canonicalSha256Hex({ a: 2 }))
    const digest = canonicalSha256Bytes({ a: 1 })
    expect(digest).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(digest).toString("hex")).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862")
    expect(canonicalSha256Hex(-0)).toBe(canonicalSha256Hex(0))
    expect(canonicalSha256Hex(null)).toBe(createHash("sha256").update("null").digest("hex"))
    expect(canonicalSha256Hex("1")).not.toBe(canonicalSha256Hex(1))
  })

  it("legacyJavaScriptOrderJsonString keeps JavaScript property order for integer-like keys", () => {
    const value = { "10": 1, "9": 2, b: 3, a: 4 }
    expect(canonicalJsonString(value)).toBe('{"10":1,"9":2,"a":4,"b":3}')
    expect(legacyJavaScriptOrderJsonString(value)).toBe('{"9":2,"10":1,"a":4,"b":3}')
    expect(legacyJavaScriptOrderJsonString({ n: [-0, 1.5], s: "\u0000" })).toBe('{"n":[0,1.5],"s":"\\u0000"}')
    expectCanonicalError(() => legacyJavaScriptOrderJsonString(undefined), "Canonical JSON does not accept undefined")
    expectCanonicalError(() => legacyJavaScriptOrderJsonString({ a: Number.NaN }), "Canonical JSON does not accept NaN or Infinity")
  })
})

describe("resource limits", () => {
  it("allows depth 64 and rejects depth 65", () => {
    expect(canonicalJsonString(nested(CANONICAL_JSON_LIMITS_V1.maxDepth))).toBe(`${"[".repeat(64)}1${"]".repeat(64)}`)
    expectCanonicalError(() => canonicalizeValue(nested(65)), "canonical JSON depth 65 exceeds maxDepth 64", LIMIT)
    let objects: unknown = 1
    for (let level = 0; level < 65; level++) objects = { k: objects }
    expectCanonicalError(() => canonicalizeValue(objects), "canonical JSON depth 65 exceeds maxDepth 64", LIMIT)
    let sixtyFour: unknown = 1
    for (let level = 0; level < 64; level++) sixtyFour = { k: sixtyFour }
    expect(canonicalJsonString(sixtyFour)).toBe(`${'{"k":'.repeat(64)}1${"}".repeat(64)}`)
  })

  it("allows 250000 nodes and rejects 250001", () => {
    const filler = (count: number) => new Array<number>(count).fill(0)
    const atLimit = [filler(99_999), filler(99_999), filler(49_998)] // 1 + 3 + 249996 nodes
    expect(canonicalizeValue(atLimit)).toHaveLength(3)
    const over = [filler(99_999), filler(99_999), filler(49_999)]
    expectCanonicalError(() => canonicalizeValue(over), "canonical JSON total nodes 250001 exceeds maxTotalNodes 250000", LIMIT)
  })

  it("allows 100000 array items and rejects 100001", () => {
    expect(canonicalizeValue(new Array<number>(100_000).fill(1))).toHaveLength(100_000)
    expectCanonicalError(() => canonicalizeValue(new Array<number>(100_001).fill(1)), "array length 100001 exceeds maxArrayItems 100000", LIMIT)
  })

  it("allows 100000 object members and rejects 100001", () => {
    const build = (count: number) => {
      const value: Record<string, number> = {}
      for (let index = 0; index < count; index++) value[`m${index}`] = 0
      return value
    }
    expect(Object.keys(canonicalizeValue(build(100_000)) as object)).toHaveLength(100_000)
    expectCanonicalError(() => canonicalizeValue(build(100_001)), "object members 100001 exceeds maxObjectMembers 100000", LIMIT)
  })

  it("limits property names to 1024 UTF-8 bytes", () => {
    expect(canonicalJsonString({ ["k".repeat(1024)]: 1 })).toBe(`{"${"k".repeat(1024)}":1}`)
    expectCanonicalError(() => canonicalizeValue({ ["k".repeat(1025)]: 1 }), "property name utf8 bytes 1025 exceeds maxPropertyNameUtf8Bytes 1024", LIMIT)
    // 342 euro signs are 1026 bytes but only 342 characters
    expectCanonicalError(() => canonicalizeValue({ ["\u20ac".repeat(342)]: 1 }), "property name utf8 bytes 1026 exceeds maxPropertyNameUtf8Bytes 1024", LIMIT)
    expect(canonicalJsonString({ ["\u20ac".repeat(341)]: 1 })).toBe(`{"${"\u20ac".repeat(341)}":1}`)
  })

  it("limits string values to 8 MiB of UTF-8", () => {
    const max = CANONICAL_JSON_LIMITS_V1.maxStringUtf8Bytes
    expect(canonicalizeValue("a".repeat(max))).toHaveLength(max)
    expectCanonicalError(() => canonicalizeValue("a".repeat(max + 1)), `string utf8 bytes ${max + 1} exceeds maxStringUtf8Bytes ${max}`, LIMIT)
    // multi-byte characters are counted in bytes
    expectCanonicalError(() => canonicalizeValue("\u20ac".repeat(2_796_203)), `string utf8 bytes 8388609 exceeds maxStringUtf8Bytes ${max}`, LIMIT)
  })

  it("limits canonical output to 16 MiB", () => {
    const max = CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes
    const half = CANONICAL_JSON_LIMITS_V1.maxStringUtf8Bytes
    // two quoted strings plus the comma and the brackets add 7 bytes
    const atLimit = ["a".repeat(half), "a".repeat(max - 7 - half)]
    const text = canonicalJsonString(atLimit)
    expect(text.length).toBe(max)
    expect(canonicalJsonBytes(atLimit).byteLength).toBe(max)
    expect(legacyJavaScriptOrderJsonString(atLimit).length).toBe(max)
    const over = ["a".repeat(half), "a".repeat(max - 7 - half + 1)]
    expectCanonicalError(() => canonicalJsonString(over), `canonical JSON bytes ${max + 1} exceeds maxUtf8Bytes ${max}`, LIMIT)
    expectCanonicalError(() => canonicalJsonBytes(over), `canonical JSON bytes ${max + 1} exceeds maxUtf8Bytes ${max}`, LIMIT)
    expectCanonicalError(() => canonicalSha256Hex(over), `canonical JSON bytes ${max + 1} exceeds maxUtf8Bytes ${max}`, LIMIT)
    expectCanonicalError(() => legacyJavaScriptOrderJsonString(over), `canonical JSON bytes exceeds maxUtf8Bytes ${max}`, LIMIT)
  })
})
