import { describe, expect, it } from "vitest"
import { SERIALIZATION_LIMIT_EXCEEDED_ERROR } from "../../spec/formatVersions"
import { CanonicalJsonError, canonicalJsonString, decodeCanonicalJson } from "../canonicalJson"

function caught(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function expectDecodeError(input: string | Uint8Array, message: string, code?: string): void {
  const error = caught(() => decodeCanonicalJson(input))
  expect(error, typeof input === "string" ? input.slice(0, 40) : "bytes").toBeInstanceOf(CanonicalJsonError)
  expect((error as CanonicalJsonError).message).toBe(message)
  expect((error as CanonicalJsonError).code).toBe(code)
}

const LIMIT = SERIALIZATION_LIMIT_EXCEEDED_ERROR
const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)
const MAX_BYTES = 16 * 1024 * 1024

describe("decodeCanonicalJson input handling", () => {
  it("accepts strings and UTF-8 bytes and rejects other inputs", () => {
    expect(decodeCanonicalJson("[1]")).toEqual([1])
    expect(decodeCanonicalJson(utf8("[1]"))).toEqual([1])
    expect(decodeCanonicalJson(utf8('"\u00e9\u20ac\u{1f600}"'))).toBe("\u00e9\u20ac\u{1f600}")
    for (const bad of [undefined, null, 1, {}, ["1"], new ArrayBuffer(1)]) {
      expectDecodeError(bad as never, "decodeCanonicalJson expects string or Uint8Array")
    }
  })

  it("rejects invalid UTF-8", () => {
    for (const bytes of [[0xff], [0xc0, 0xaf], [0x22, 0xe2, 0x82, 0x22], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
      expectDecodeError(Uint8Array.from(bytes), "invalid UTF-8 bytes")
    }
  })

  it("rejects empty or whitespace-only input", () => {
    for (const input of ["", " ", "\n\t\r ", utf8("")]) expectDecodeError(input, "empty JSON")
  })

  it("accepts only the four JSON whitespace characters around values", () => {
    expect(decodeCanonicalJson(" \t\r\n1 \t\r\n")).toBe(1)
    expect(decodeCanonicalJson('\n[ 1 ,\t2\r, 3 ]\n')).toEqual([1, 2, 3])
    expect(decodeCanonicalJson('{\n"a"\t:\r1 ,\n"b" : 2 }')).toEqual({ a: 1, b: 2 })
    for (const space of ["\f", "\v", "\u00a0", "\u2028", "\ufeff", "\u0000"]) {
      expect(caught(() => decodeCanonicalJson(`${space}1`)), JSON.stringify(space)).toBeInstanceOf(CanonicalJsonError)
      expect(caught(() => decodeCanonicalJson(`1${space}`)), JSON.stringify(space)).toBeInstanceOf(CanonicalJsonError)
    }
    expectDecodeError("\f1", 'unexpected token "\\f"')
    expectDecodeError("1\u00a0", "trailing characters after JSON value")
  })

  it("rejects trailing characters", () => {
    for (const input of ["1 2", "{} x", "[]]", "nullx", "true false", '"a""b"', "1,", "{}}"]) {
      expectDecodeError(input, "trailing characters after JSON value")
    }
  })

  it("returns null-prototype objects and keeps member order", () => {
    const value = decodeCanonicalJson('{"b":1,"a":{"d":[],"c":null}}') as Record<string, unknown>
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect(Object.keys(value)).toEqual(["b", "a"])
    expect(Object.getPrototypeOf(value["a"])).toBeNull()
    expect(Object.getPrototypeOf(decodeCanonicalJson("{}"))).toBeNull()
    expect(Object.keys(decodeCanonicalJson("{}") as object)).toEqual([])
    expect(decodeCanonicalJson("[]")).toEqual([])
  })

  it("round-trips canonical text exactly", () => {
    const samples = [
      '{"":0,"1":1,"10":2,"9":3,"a":[true,false,null,"\\u0000\\n\\"\\\\",-1,0.5,1e-7,123456789],"b":{"c":{}}}',
      "[[],[[]],{}]",
      '"\u00e9\u20ac\u{1f600}"',
      "-0.25",
      "9007199254740991",
      "-9007199254740991",
      "5e-324",
    ]
    for (const text of samples) expect(canonicalJsonString(decodeCanonicalJson(text))).toBe(text)
  })
})

describe("decodeCanonicalJson literals", () => {
  it("decodes true, false and null", () => {
    expect(decodeCanonicalJson("true")).toBe(true)
    expect(decodeCanonicalJson("false")).toBe(false)
    expect(decodeCanonicalJson("null")).toBeNull()
    expect(decodeCanonicalJson("[true,false,null]")).toEqual([true, false, null])
  })

  it("rejects truncated and misspelled literals", () => {
    for (const input of ["t", "tru", "trUe", "tx", "f", "fals", "False", "n", "nul", "Null", "nil"]) {
      const first = input[0]
      const expected = first === "t" || first === "f" || first === "n" ? "invalid token" : `unexpected token ${JSON.stringify(first)}`
      expectDecodeError(input, expected)
    }
    expectDecodeError("[tru]", "invalid token")
    expectDecodeError("[nul,1]", "invalid token")
  })

  it("rejects characters that start no value", () => {
    expectDecodeError("x", 'unexpected token "x"')
    expectDecodeError("+1", 'unexpected token "+"')
    expectDecodeError(".5", 'unexpected token "."')
    expectDecodeError("'a'", "unexpected token \"'\"")
    expectDecodeError("[,1]", 'unexpected token ","')
    expectDecodeError("[1,,2]", 'unexpected token ","')
    expectDecodeError("]", 'unexpected token "]"')
    expectDecodeError("}", 'unexpected token "}"')
    expectDecodeError(":", 'unexpected token ":"')
    expectDecodeError("/", 'unexpected token "/"')
    expectDecodeError("a", 'unexpected token "a"')
    expectDecodeError("[", "unexpected end of JSON")
    expectDecodeError("[1,", "unexpected end of JSON")
    expectDecodeError('{"a":', "unexpected end of JSON")
    expectDecodeError('{"a": ', "unexpected end of JSON")
  })
})

describe("decodeCanonicalJson numbers", () => {
  it("decodes integers, fractions and exponents", () => {
    const cases: [string, number][] = [
      ["0", 0],
      ["1", 1],
      ["-1", -1],
      ["9", 9],
      ["10", 10],
      ["19", 19],
      ["123456789", 123456789],
      ["0.5", 0.5],
      ["0.0", 0],
      ["1.0", 1],
      ["1.5", 1.5],
      ["1.9", 1.9],
      ["-0.25", -0.25],
      ["1e5", 100000],
      ["1E5", 100000],
      ["1e+5", 100000],
      ["1e-5", 0.00001],
      ["1E-5", 0.00001],
      ["1e0", 1],
      ["1e9", 1_000_000_000],
      ["1e19", 1e19],
      ["2.5e3", 2500],
      ["1.5e-3", 0.0015],
      ["1e-19", 1e-19],
      ["1e-325", 0],
      ["5e-324", 5e-324],
      ["0e0", 0],
      ["0.1e1", 1],
      ["9007199254740991", Number.MAX_SAFE_INTEGER],
      ["-9007199254740991", Number.MIN_SAFE_INTEGER],
      ["1.7976931348623157e-308", 1.7976931348623157e-308],
    ]
    for (const [text, expected] of cases) {
      if (Number.isInteger(expected) && !Number.isSafeInteger(expected)) continue
      expect(decodeCanonicalJson(text), text).toBe(expected)
    }
    expect(decodeCanonicalJson("[1,-2,3.5]")).toEqual([1, -2, 3.5])
    expect(decodeCanonicalJson("[1e2,2e2]")).toEqual([100, 200])
    expect(decodeCanonicalJson('{"a":-1}')).toEqual({ a: -1 })
  })

  it("normalises negative zero", () => {
    for (const text of ["-0", "-0.0", "-0e0", "-0e5"]) expect(Object.is(decodeCanonicalJson(text), 0), text).toBe(true)
    expect(Object.is((decodeCanonicalJson("[-0]") as number[])[0], 0)).toBe(true)
  })

  it("rejects leading zeros", () => {
    for (const text of ["00", "01", "09", "-00", "-01", "-09", "007", "[01]", "00.5"]) {
      expectDecodeError(text, "leading zero not allowed")
    }
    expect(decodeCanonicalJson("0.5")).toBe(0.5)
    expect(decodeCanonicalJson("-0.5")).toBe(-0.5)
    expectDecodeError("0a", "trailing characters after JSON value")
    expectDecodeError("[0a]", "expected , or ] in array")
  })

  it("rejects malformed numbers with the exact message", () => {
    expectDecodeError("-", "invalid number")
    expectDecodeError("-x", "invalid number")
    expectDecodeError("-.5", "invalid number")
    expectDecodeError("--1", "invalid number")
    expectDecodeError("-+1", "invalid number")
    expectDecodeError("[-]", "invalid number")
    expectDecodeError("1.", "fraction requires digit")
    expectDecodeError("1.x", "fraction requires digit")
    expectDecodeError("1.e5", "fraction requires digit")
    expectDecodeError("1. ", "fraction requires digit")
    expectDecodeError("[1.]", "fraction requires digit")
    expectDecodeError("1e", "exponent requires digit")
    expectDecodeError("1e+", "exponent requires digit")
    expectDecodeError("1e-", "exponent requires digit")
    expectDecodeError("1ex", "exponent requires digit")
    expectDecodeError("1e+x", "exponent requires digit")
    expectDecodeError("1E-x", "exponent requires digit")
    expectDecodeError("[1e]", "exponent requires digit")
    expectDecodeError("1.5.5", "trailing characters after JSON value")
    expectDecodeError("1e5e5", "trailing characters after JSON value")
    expectDecodeError("1e5.5", "trailing characters after JSON value")
    expectDecodeError("0x10", "trailing characters after JSON value")
    expectDecodeError("1_000", "trailing characters after JSON value")
    expectDecodeError("Infinity", 'unexpected token "I"')
    expectDecodeError("NaN", 'unexpected token "N"')
  })

  it("rejects non-finite numbers and integers beyond the safe range", () => {
    expectDecodeError("1e999", "non-finite number")
    expectDecodeError("-1e999", "non-finite number")
    expectDecodeError("[1e400]", "non-finite number")
    expectDecodeError("9007199254740992", "integer 9007199254740992 outside safe integer range; encode as typed string via domain codec")
    expectDecodeError("-9007199254740992", "integer -9007199254740992 outside safe integer range; encode as typed string via domain codec")
    expectDecodeError("9007199254740993", "integer 9007199254740993 outside safe integer range; encode as typed string via domain codec")
    expectDecodeError("1e21", "integer 1e21 outside safe integer range; encode as typed string via domain codec")
    expectDecodeError("1e19", "integer 1e19 outside safe integer range; encode as typed string via domain codec")
    expectDecodeError("1.5e19", "integer 1.5e19 outside safe integer range; encode as typed string via domain codec")
    expectDecodeError("12345678901234567890", "integer 12345678901234567890 outside safe integer range; encode as typed string via domain codec")
  })
})

describe("decodeCanonicalJson strings", () => {
  it("decodes every simple escape", () => {
    expect(decodeCanonicalJson('"\\"\\\\\\/\\b\\f\\n\\r\\t"')).toBe('"\\/\b\f\n\r\t')
    expect(decodeCanonicalJson('"a\\nb\\tc"')).toBe("a\nb\tc")
    expect(decodeCanonicalJson('"x\\"y"')).toBe('x"y')
    expect(decodeCanonicalJson('"\\\\"')).toBe("\\")
    expect(decodeCanonicalJson('""')).toBe("")
    expect(decodeCanonicalJson('"abc"')).toBe("abc")
    expect(decodeCanonicalJson('"a\\u0041z"')).toBe("aAz")
  })

  it("decodes unicode escapes in both cases and joins surrogate pairs", () => {
    expect(decodeCanonicalJson('"\\u0000"')).toBe("\u0000")
    expect(decodeCanonicalJson('"\\u00e9\\u00E9"')).toBe("\u00e9\u00e9")
    expect(decodeCanonicalJson('"\\uffff\\uFFFF\\u0FfF"')).toBe("\uffff\uffff\u0fff")
    expect(decodeCanonicalJson('"\\ud83d\\ude00"')).toBe("\u{1f600}")
    expect(decodeCanonicalJson('"\\uD83D\\uDE00x"')).toBe("\u{1f600}x")
    expect(decodeCanonicalJson('"\\u0022\\u005c"')).toBe('"\\')
    expect(decodeCanonicalJson('{"\\u0061":1}')).toEqual({ a: 1 })
    expect(decodeCanonicalJson('"\\u001f"')).toBe("\u001f")
    expect(decodeCanonicalJson('"\\u0041"')).toBe("A")
  })

  it("accepts unescaped characters from U+0020 upwards", () => {
    expect(decodeCanonicalJson('" "')).toBe(" ")
    expect(decodeCanonicalJson('"\u007f\u0080\u2028\u2029\ufffd"')).toBe("\u007f\u0080\u2028\u2029\ufffd")
    expect(decodeCanonicalJson('"\u{1f600}"')).toBe("\u{1f600}")
  })

  it("rejects unescaped control characters, including U+001F and U+0000", () => {
    for (const code of [0x00, 0x01, 0x08, 0x09, 0x0a, 0x0d, 0x1e, 0x1f]) {
      expectDecodeError(`"a${String.fromCharCode(code)}b"`, "unescaped control character in string")
    }
  })

  it("rejects bad escapes with exact messages", () => {
    expectDecodeError('"\\', "incomplete escape")
    expectDecodeError('"abc\\', "incomplete escape")
    expectDecodeError('"\\x"', "invalid escape \\x")
    expectDecodeError('"\\a"', "invalid escape \\a")
    expectDecodeError('"\\U0041"', "invalid escape \\U")
    expectDecodeError('"\\\'"', "invalid escape \\'")
    expectDecodeError('"\\0"', "invalid escape \\0")
    expectDecodeError('"\\u004', "incomplete unicode escape")
    expectDecodeError('"\\u', "incomplete unicode escape")
    expectDecodeError('"\\u00"', "incomplete unicode escape")
    expectDecodeError('"\\u00"  ', "invalid unicode escape")
    expectDecodeError('"\\uZZZZ"', "invalid unicode escape")
    expectDecodeError('"\\u00g0"', "invalid unicode escape")
    expectDecodeError('"\\u+123"', "invalid unicode escape")
    expectDecodeError('"\\u 123"', "invalid unicode escape")
    expectDecodeError('"\\u-123"', "invalid unicode escape")
    expectDecodeError('"\\u12"x', "invalid unicode escape")
  })

  it("rejects unterminated strings", () => {
    for (const input of ['"', '"abc', '"abc\\"', '"\\u0041', '"\\n', '["a', '{"a']) {
      expectDecodeError(input, "unterminated string")
    }
  })

  it("rejects lone surrogates produced by escapes, in values and in names", () => {
    for (const escape of ["\\ud800", "\\udbff", "\\udc00", "\\udfff", "\\ud800\\ud800", "\\ud800a", "\\udc00\\ud800"]) {
      expectDecodeError(`"${escape}"`, "string contains lone surrogate")
      expectDecodeError(`{"${escape}":1}`, "property name contains lone surrogate")
    }
    expectDecodeError('"\\ud83d"', "string contains lone surrogate")
  })

  it("limits string values to 8 MiB of UTF-8 bytes", () => {
    const max = 8 * 1024 * 1024
    expect((decodeCanonicalJson(`"${"a".repeat(max)}"`) as string).length).toBe(max)
    expectDecodeError(`"${"a".repeat(max + 1)}"`, `string utf8 bytes ${max + 1} exceeds maxStringUtf8Bytes ${max}`, LIMIT)
    expectDecodeError(`"${"\u20ac".repeat(2_796_203)}"`, `string utf8 bytes 8388609 exceeds maxStringUtf8Bytes ${max}`, LIMIT)
  })
})

describe("decodeCanonicalJson arrays", () => {
  it("decodes nested and empty arrays", () => {
    expect(decodeCanonicalJson("[ ]")).toEqual([])
    expect(decodeCanonicalJson("[[],[1,[2]],[[[]]]]")).toEqual([[], [1, [2]], [[[]]]])
    expect(decodeCanonicalJson('["a","b"]')).toEqual(["a", "b"])
    expect(decodeCanonicalJson("[1]")).toEqual([1])
  })

  it("rejects malformed arrays with exact messages", () => {
    expectDecodeError("[1", "unterminated array")
    expectDecodeError("[1 ", "unterminated array")
    expectDecodeError("[[1]", "unterminated array")
    expectDecodeError("[1 2]", "expected , or ] in array")
    expectDecodeError("[1:2]", "expected , or ] in array")
    expectDecodeError("[1}", "expected , or ] in array")
    expectDecodeError("[1,]", "trailing comma in array")
    expectDecodeError("[1, ]", "trailing comma in array")
    expectDecodeError("[1,\n\t]", "trailing comma in array")
    expectDecodeError("[[1,],2]", "trailing comma in array")
    expectDecodeError("[,]", 'unexpected token ","')
  })

  it("allows exactly 100000 items and rejects 100001", () => {
    const max = 100_000
    expect(decodeCanonicalJson(`[${new Array<number>(max).fill(0).join(",")}]`)).toHaveLength(max)
    expectDecodeError(`[${new Array<number>(max + 1).fill(0).join(",")}]`, "array items 100001 exceeds maxArrayItems 100000", LIMIT)
  })
})

describe("decodeCanonicalJson objects", () => {
  it("decodes members and nested objects", () => {
    expect(decodeCanonicalJson('{"a":1,"b":[true],"c":{"d":null}}')).toEqual({ a: 1, b: [true], c: { d: null } })
    expect(decodeCanonicalJson('{ }')).toEqual({})
    expect(decodeCanonicalJson('{"constructor":1,"prototype":2,"toString":3}')).toEqual({ constructor: 1, prototype: 2, toString: 3 })
    expect(decodeCanonicalJson('{"":1}')).toEqual({ "": 1 })
  })

  it("rejects malformed objects with exact messages", () => {
    expectDecodeError("{", "object key must be string")
    expectDecodeError("{ ", "object key must be string")
    expectDecodeError("{a:1}", "object key must be string")
    expectDecodeError("{1:2}", "object key must be string")
    expectDecodeError("{'a':1}", "object key must be string")
    expectDecodeError('{"a":1,b:2}', "object key must be string")
    expectDecodeError('{"a":1,', "object key must be string")
    expectDecodeError('{"a" 1}', "expected : after object key")
    expectDecodeError('{"a"', "expected : after object key")
    expectDecodeError('{"a",1}', "expected : after object key")
    expectDecodeError('{"a"=1}', "expected : after object key")
    expectDecodeError('{"a":1', "unterminated object")
    expectDecodeError('{"a":1 ', "unterminated object")
    expectDecodeError('{"a":{"b":1}', "unterminated object")
    expectDecodeError('{"a":1 "b":2}', "expected , or } in object")
    expectDecodeError('{"a":1]', "expected , or } in object")
    expectDecodeError('{"a":1;"b":2}', "expected , or } in object")
    expectDecodeError('{"a":1,}', "trailing comma in object")
    expectDecodeError('{"a":1, }', "trailing comma in object")
    expectDecodeError('{"a":1,\n\t}', "trailing comma in object")
    expectDecodeError('{"a":{"b":1,}}', "trailing comma in object")
    expectDecodeError('{"a":}', 'unexpected token "}"')
  })

  it("rejects duplicate keys, including keys that only match after unescaping", () => {
    expectDecodeError('{"a":1,"a":2}', 'duplicate object key: "a"')
    expectDecodeError('{"a":1,"b":2,"a":3}', 'duplicate object key: "a"')
    expectDecodeError('{"a":1,"\\u0061":2}', 'duplicate object key: "a"')
    expectDecodeError('{"":1,"":2}', 'duplicate object key: ""')
    expect(decodeCanonicalJson('{"a":{"a":1},"b":{"a":2}}')).toEqual({ a: { a: 1 }, b: { a: 2 } })
  })

  it("rejects the __proto__ key", () => {
    expectDecodeError('{"__proto__":1}', 'object key "__proto__" is not allowed')
    expectDecodeError('{"a":1,"\\u005f_proto__":{"x":1}}', 'object key "__proto__" is not allowed')
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined()
    expect(decodeCanonicalJson('{"__proto":1,"proto__":2}')).toEqual({ __proto: 1, proto__: 2 })
  })

  it("limits property names to 1024 UTF-8 bytes", () => {
    const ok = decodeCanonicalJson(`{"${"k".repeat(1024)}":1}`) as Record<string, number>
    expect(Object.keys(ok)).toEqual(["k".repeat(1024)])
    expectDecodeError(`{"${"k".repeat(1025)}":1}`, "property name utf8 bytes 1025 exceeds maxPropertyNameUtf8Bytes 1024", LIMIT)
    expectDecodeError(`{"${"\u20ac".repeat(342)}":1}`, "property name utf8 bytes 1026 exceeds maxPropertyNameUtf8Bytes 1024", LIMIT)
    expect(Object.keys(decodeCanonicalJson(`{"${"\u20ac".repeat(341)}":1}`) as object)).toHaveLength(1)
  })

  it("allows exactly 100000 members and rejects 100001", () => {
    const build = (count: number) => {
      const parts: string[] = []
      for (let index = 0; index < count; index++) parts.push(`"m${index}":0`)
      return `{${parts.join(",")}}`
    }
    expect(Object.keys(decodeCanonicalJson(build(100_000)) as object)).toHaveLength(100_000)
    expectDecodeError(build(100_001), "object members 100001 exceeds maxObjectMembers 100000", LIMIT)
  })
})

describe("decodeCanonicalJson limits", () => {
  const nestedText = (levels: number) => `${"[".repeat(levels)}1${"]".repeat(levels)}`

  it("allows depth 64 and rejects depth 65 for arrays and objects", () => {
    expect(canonicalJsonString(decodeCanonicalJson(nestedText(64)))).toBe(nestedText(64))
    expectDecodeError(nestedText(65), "canonical JSON depth 65 exceeds maxDepth 64", LIMIT)
    expectDecodeError(nestedText(200), "canonical JSON depth 65 exceeds maxDepth 64", LIMIT)
    const objects = (levels: number) => `${'{"k":'.repeat(levels)}1${"}".repeat(levels)}`
    expect(canonicalJsonString(decodeCanonicalJson(objects(64)))).toBe(objects(64))
    expectDecodeError(objects(65), "canonical JSON depth 65 exceeds maxDepth 64", LIMIT)
  })

  it("allows 250000 nodes and rejects 250001", () => {
    const zeros = (count: number) => `[${new Array<number>(count).fill(0).join(",")}]`
    const atLimit = `[${zeros(99_999)},${zeros(99_999)},${zeros(49_998)}]` // 1 + 3 + 249996 values
    expect(decodeCanonicalJson(atLimit)).toHaveLength(3)
    const over = `[${zeros(99_999)},${zeros(99_999)},${zeros(49_999)}]`
    expectDecodeError(over, "canonical JSON total nodes 250001 exceeds maxTotalNodes 250000", LIMIT)
  })

  it("limits the input to 16 MiB for strings and bytes, counted in bytes", () => {
    const half = 8 * 1024 * 1024
    const body = `["${"a".repeat(half)}","${"a".repeat(MAX_BYTES - 7 - half)}"]`
    expect(utf8(body).byteLength).toBe(MAX_BYTES)
    expect(decodeCanonicalJson(body)).toHaveLength(2)
    expect(decodeCanonicalJson(utf8(body))).toHaveLength(2)
    const over = `${body} `
    expectDecodeError(over, `input utf8 bytes ${MAX_BYTES + 1} exceeds maxUtf8Bytes ${MAX_BYTES}`, LIMIT)
    expectDecodeError(utf8(over), `input utf8 bytes ${MAX_BYTES + 1} exceeds maxUtf8Bytes ${MAX_BYTES}`, LIMIT)
    // fewer characters than the limit, more bytes
    const wideCount = 5_592_404
    const wide = `"${"\u20ac".repeat(wideCount)}"`
    expect(wide.length).toBeLessThan(MAX_BYTES)
    expectDecodeError(`${wide}${" ".repeat(10)}`, `input utf8 bytes ${3 * wideCount + 2 + 10} exceeds maxUtf8Bytes ${MAX_BYTES}`, LIMIT)
  })
})
