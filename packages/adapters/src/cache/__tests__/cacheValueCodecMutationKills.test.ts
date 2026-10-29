import { describe, expect, it } from "vitest"
import { ConfigurationError } from "@xonava/core/domain"
import { assertCacheTtl, decodeCacheValue, encodeCacheValue } from "../cacheValueCodec"

function failure(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the call to throw")
}

function expectRejected(run: () => unknown, reason: string): void {
  const error = failure(run)
  expect(error).toBeInstanceOf(ConfigurationError)
  expect(error.message).toBe(`Cache value is not serializable: ${reason}`)
}

function roundTrip<T>(value: T): T {
  return decodeCacheValue<T>(JSON.parse(JSON.stringify(encodeCacheValue(value))))
}

describe("encodeCacheValue rejections", () => {
  it("rejects a top-level undefined", () => {
    expectRejected(() => encodeCacheValue(undefined), "top-level undefined cannot be cached")
  })

  it("rejects functions and symbols at any depth", () => {
    expectRejected(() => encodeCacheValue(() => 1), "function values are not supported")
    expectRejected(() => encodeCacheValue(Symbol("s")), "symbol values are not supported")
    expectRejected(() => encodeCacheValue({ a: [() => 1] }), "function values are not supported")
    expectRejected(() => encodeCacheValue({ a: Symbol("s") }), "symbol values are not supported")
  })

  it("rejects cycles through objects, arrays, maps and sets", () => {
    const object: Record<string, unknown> = {}
    object.self = object
    expectRejected(() => encodeCacheValue(object), "cyclic structures are not supported")
    const array: unknown[] = []
    array.push(array)
    expectRejected(() => encodeCacheValue(array), "cyclic structures are not supported")
    const map = new Map<string, unknown>()
    map.set("m", map)
    expectRejected(() => encodeCacheValue(map), "cyclic structures are not supported")
    const set = new Set<unknown>()
    set.add(set)
    expectRejected(() => encodeCacheValue(set), "cyclic structures are not supported")
  })

  it("accepts the same object referenced twice (a DAG is not a cycle)", () => {
    const shared = { n: 1 }
    expect(encodeCacheValue({ a: shared, b: shared, c: [shared, shared] })).toEqual({
      a: { n: 1 },
      b: { n: 1 },
      c: [{ n: 1 }, { n: 1 }],
    })
    // A rejected cycle must not poison later calls either.
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => encodeCacheValue(cyclic)).toThrow(ConfigurationError)
    expect(encodeCacheValue(shared)).toEqual({ n: 1 })
  })

  it("rejects an invalid Date", () => {
    expectRejected(() => encodeCacheValue(new Date(Number.NaN)), "invalid Date")
    expect(encodeCacheValue(new Date(0))).toEqual({ $cache: "Date", v: "1970-01-01T00:00:00.000Z" })
  })

  it("rejects class instances naming the class", () => {
    class Widget {
      readonly size = 1
    }
    expectRejected(() => encodeCacheValue(new Widget()), "instances of Widget are not supported")
    expectRejected(() => encodeCacheValue({ nested: new Widget() }), "instances of Widget are not supported")
  })

  it("names an unknown class when the instance has no constructor", () => {
    const orphan = Object.create(Object.create(null)) as object
    expectRejected(() => encodeCacheValue(orphan), "instances of unknown class are not supported")
  })

  it("does not call a toJSON that is not a function", () => {
    class Odd {
      toJSON = 5
    }
    expectRejected(() => encodeCacheValue(new Odd()), "instances of Odd are not supported")
  })
})

describe("encodeCacheValue encodings", () => {
  it("keeps finite numbers raw and tags non-finite ones", () => {
    expect(encodeCacheValue(1.5)).toBe(1.5)
    expect(encodeCacheValue(0)).toBe(0)
    expect(encodeCacheValue(Number.NaN)).toEqual({ $cache: "Number", v: "NaN" })
    expect(encodeCacheValue(Number.POSITIVE_INFINITY)).toEqual({ $cache: "Number", v: "Infinity" })
    expect(encodeCacheValue(Number.NEGATIVE_INFINITY)).toEqual({ $cache: "Number", v: "-Infinity" })
    expect(roundTrip([Number.NaN, Infinity, -Infinity])).toEqual([Number.NaN, Infinity, -Infinity])
  })

  it("passes null, booleans and strings through", () => {
    expect(encodeCacheValue(null)).toBeNull()
    expect(encodeCacheValue(true)).toBe(true)
    expect(encodeCacheValue(false)).toBe(false)
    expect(encodeCacheValue("s")).toBe("s")
    expect(encodeCacheValue({ a: null, b: [null] })).toEqual({ a: null, b: [null] })
  })

  it("drops undefined properties and nulls undefined items", () => {
    const encoded = encodeCacheValue({ a: undefined, b: 1, c: [undefined, 2] }) as Record<string, unknown>
    expect(Object.keys(encoded)).toEqual(["b", "c"])
    expect(encoded.c).toEqual([null, 2])
    expect(encodeCacheValue(new Map([["k", undefined]]))).toEqual({ $cache: "Map", v: [["k", null]] })
    expect(encodeCacheValue(new Set([undefined]))).toEqual({ $cache: "Set", v: [null] })
  })

  it("applies toJSON on class instances, keeping array and property positions", () => {
    class Money {
      constructor(private readonly cents: number) {}
      toJSON(): unknown { return { cents: this.cents } }
    }
    class Nothing {
      toJSON(): unknown { return undefined }
    }
    expect(encodeCacheValue(new Money(5))).toEqual({ cents: 5 })
    expect(encodeCacheValue([new Money(1), new Nothing()])).toEqual([{ cents: 1 }, null])
    expect(Object.keys(encodeCacheValue({ a: new Nothing(), b: 1 }) as object)).toEqual(["b"])
  })

  it("treats a null-prototype object as plain", () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare.x = 1
    expect(encodeCacheValue(bare)).toEqual({ x: 1 })
  })

  it("escapes plain objects that look like a tagged node", () => {
    const lookalike = { $cache: "Date", v: "2020-01-01T00:00:00.000Z" }
    expect(encodeCacheValue(lookalike)).toEqual({ $cache: "Object", v: lookalike })
    expect(roundTrip(lookalike)).toEqual(lookalike)
    expect(roundTrip({ nested: lookalike })).toEqual({ nested: lookalike })
  })

  it("round-trips dates, bigints, maps, sets and nested structures", () => {
    const value = {
      when: new Date("2024-02-29T12:00:00.000Z"),
      big: 12345678901234567890n,
      map: new Map<unknown, unknown>([["a", new Set([1, 2])], [{ k: 1 }, [new Date(5)]]]),
      list: [1, "two", null, { three: 3n }],
    }
    const copy = roundTrip(value)
    expect(copy).toEqual(value)
    expect(copy.when).toBeInstanceOf(Date)
    expect(copy.map).toBeInstanceOf(Map)
    expect(copy.map.get("a")).toBeInstanceOf(Set)
  })
})

describe("decodeCacheValue", () => {
  it("returns primitives and plain data unchanged and decodes unknown tags as plain objects", () => {
    expect(decodeCacheValue(null)).toBeNull()
    expect(decodeCacheValue("s")).toBe("s")
    expect(decodeCacheValue(3)).toBe(3)
    expect(decodeCacheValue([1, { a: 2 }])).toEqual([1, { a: 2 }])
    expect(decodeCacheValue({ $cache: "Mystery", v: 1 })).toEqual({ $cache: "Mystery", v: 1 })
    expect(decodeCacheValue({ a: { b: [1] } })).toEqual({ a: { b: [1] } })
  })
})

describe("assertCacheTtl", () => {
  it("accepts undefined and positive safe integers", () => {
    expect(() => assertCacheTtl(undefined)).not.toThrow()
    expect(() => assertCacheTtl(1)).not.toThrow()
    expect(() => assertCacheTtl(Number.MAX_SAFE_INTEGER)).not.toThrow()
  })

  it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "5", null])("rejects %s with the exact message", (ttl) => {
    const error = failure(() => assertCacheTtl(ttl as never))
    expect(error).toBeInstanceOf(ConfigurationError)
    expect(error.message).toBe("Cache ttlMs must be a positive safe integer of milliseconds (or undefined for no TTL)")
  })
})
