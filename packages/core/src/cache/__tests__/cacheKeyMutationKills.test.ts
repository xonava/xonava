import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import { CanonicalJsonError } from "../../serialization/canonicalJson"
import {
  buildKey,
  CacheAdapterError,
  CacheOverloadError,
  MAX_CACHE_KEY_BYTES,
  serializeCacheKeyPart,
} from "../cache"
import { compileCacheInvalidationStrategy } from "../generation"

function expectCanonicalError(run: () => unknown, message: string): CanonicalJsonError {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(CanonicalJsonError)
  expect((caught as CanonicalJsonError).message).toBe(message)
  return caught as CanonicalJsonError
}

const ser = serializeCacheKeyPart

function nestArrays(levels: number): unknown {
  let value: unknown = []
  for (let index = 1; index < levels; index++) value = [value]
  return value
}

function nestMapValues(levels: number): unknown {
  let value: unknown = 0
  for (let index = 0; index < levels; index++) value = new Map([["k", value]])
  return value
}

function nestMapKeys(levels: number): unknown {
  let value: unknown = 0
  for (let index = 0; index < levels; index++) value = new Map([[value, 1]])
  return value
}

function nestSets(levels: number): unknown {
  let value: unknown = 0
  for (let index = 0; index < levels; index++) value = new Set([value])
  return value
}

function nestObjects(levels: number): unknown {
  let value: unknown = 0
  for (let index = 0; index < levels; index++) value = { k: value }
  return value
}

describe("cache key serialization mutation kills", () => {
  it("serializes every value kind to its exact canonical form", () => {
    expect(ser(undefined)).toBe('{"$type":"undefined"}')
    expect(ser(Number.NaN)).toBe('{"$type":"NaN"}')
    expect(ser(Number.POSITIVE_INFINITY)).toBe('{"$type":"Infinity"}')
    expect(ser(Number.NEGATIVE_INFINITY)).toBe('{"$type":"-Infinity"}')
    expect(ser(1)).toBe("1")
    expect(ser(-5)).toBe("-5")
    expect(ser(0)).toBe("0")
    expect(ser(null)).toBe("null")
    expect(ser(true)).toBe("true")
    expect(ser(false)).toBe("false")
    expect(ser("a")).toBe('"a"')
    expect(ser(10n)).toBe('{"$type":"BigInt","value":"10"}')
    expect(ser(new Date("2026-01-01T00:00:00.000Z"))).toBe('{"$type":"Date","value":"2026-01-01T00:00:00.000Z"}')
    expect(ser({ b: 1, a: [1, "x"] })).toBe('{"a":[1,"x"],"b":1}')
    expect(ser([])).toBe("[]")
    expect(ser([1, 2])).toBe("[1,2]")
    expect(ser(Object.assign(Object.create(null) as object, { z: 1 }))).toBe('{"z":1}')
    expect(ser({})).toBe("{}")
  })

  it("orders Map and Set members independent of insertion order", () => {
    const expectedSet = '{"$type":"Set","value":["a","b","c"]}'
    expect(ser(new Set(["a", "b", "c"]))).toBe(expectedSet)
    expect(ser(new Set(["c", "b", "a"]))).toBe(expectedSet)
    expect(ser(new Set(["b", "c", "a"]))).toBe(expectedSet)
    expect(ser(new Set(["b", "a"]))).toBe('{"$type":"Set","value":["a","b"]}')
    const expectedMap = '{"$type":"Map","value":[["a",2],["b",1],["c",3]]}'
    expect(ser(new Map([["b", 1], ["a", 2], ["c", 3]]))).toBe(expectedMap)
    expect(ser(new Map([["c", 3], ["b", 1], ["a", 2]]))).toBe(expectedMap)
    expect(ser(new Map([["a", 2], ["b", 1], ["c", 3]]))).toBe(expectedMap)
    expect(ser(new Map([["x", 1], ["x".repeat(2), 1]]))).toBe('{"$type":"Map","value":[["x",1],["xx",1]]}')
    expect(ser(new Map([["xx", 1], ["x", 1]]))).toBe('{"$type":"Map","value":[["x",1],["xx",1]]}')
  })

  it("rejects subclasses and invalid dates with exact messages", () => {
    class CustomMap extends Map<unknown, unknown> {}
    class CustomSet extends Set<unknown> {}
    class CustomDate extends Date {}
    class CustomArray extends Array<unknown> {}
    class Custom { value = 1 }
    expectCanonicalError(() => ser(new CustomMap()), "Cache key parts do not accept Map subclasses")
    expectCanonicalError(() => ser(new CustomSet()), "Cache key parts do not accept Set subclasses")
    expectCanonicalError(() => ser(new CustomDate("2026-01-01T00:00:00.000Z")), "Cache key parts do not accept invalid Date values")
    expectCanonicalError(() => ser(new Date(Number.NaN)), "Cache key parts do not accept invalid Date values")
    expectCanonicalError(() => ser(new CustomArray()), "Cache key parts accept only plain arrays")
    expectCanonicalError(() => ser(Object.assign([1], { [Symbol("s")]: 1 })), "Cache key parts accept only plain arrays")
    expectCanonicalError(() => ser(new Custom()), "Cache key parts accept only plain objects")
    expectCanonicalError(() => ser({ [Symbol("s")]: 1 }), "Cache key parts do not accept symbol keys")
    expectCanonicalError(() => ser({ $type: "x" }), "Cache key parts do not accept objects with a reserved $type key")
    expectCanonicalError(() => ser(() => 1), "Cache key parts do not accept values of type function")
    expectCanonicalError(() => ser(Symbol("s")), "Cache key parts do not accept values of type symbol")
  })

  it("rejects sparse, extended and non-data arrays and objects with exact messages", () => {
    const sparse = new Array<unknown>(2)
    expectCanonicalError(() => ser(sparse), "Cache key arrays must be dense and cannot contain extra properties")
    expectCanonicalError(() => ser(Object.assign([1], { extra: 1 })), "Cache key arrays must be dense and cannot contain extra properties")
    const accessorArray = [1]
    Object.defineProperty(accessorArray, "0", { get: () => 1, enumerable: true, configurable: true })
    expectCanonicalError(() => ser(accessorArray), "Cache key arrays must contain enumerable data properties")
    const hiddenArray = [1]
    Object.defineProperty(hiddenArray, "0", { value: 1, enumerable: false, configurable: true })
    expectCanonicalError(() => ser(hiddenArray), "Cache key arrays must contain enumerable data properties")
    const accessorObject = Object.defineProperty({}, "x", { get: () => 1, enumerable: true })
    expectCanonicalError(() => ser(accessorObject), "Cache key objects must contain enumerable data properties")
    const hiddenObject = Object.defineProperty({}, "x", { value: 1, enumerable: false })
    expectCanonicalError(() => ser(hiddenObject), "Cache key objects must contain enumerable data properties")
  })

  it("rejects cyclic structures of every container kind", () => {
    const message = "Cache key parts do not accept cyclic structures"
    const array: unknown[] = []
    array.push(array)
    expectCanonicalError(() => ser(array), message)
    const object: Record<string, unknown> = {}
    object["self"] = object
    expectCanonicalError(() => ser(object), message)
    const map = new Map<unknown, unknown>()
    map.set("self", map)
    expectCanonicalError(() => ser(map), message)
    const set = new Set<unknown>()
    set.add(set)
    expectCanonicalError(() => ser(set), message)
  })

  it("accepts the same container referenced twice without treating it as cyclic", () => {
    const array = [1]
    expect(ser([array, array])).toBe("[[1],[1]]")
    const object = { x: 1 }
    expect(ser([object, object])).toBe('[{"x":1},{"x":1}]')
    const map = new Map([["a", 1]])
    expect(ser([map, map])).toBe('[{"$type":"Map","value":[["a",1]]},{"$type":"Map","value":[["a",1]]}]')
    const set = new Set([1])
    expect(ser([set, set])).toBe('[{"$type":"Set","value":[1]},{"$type":"Set","value":[1]}]')
  })

  it("enforces the nesting depth limit through every container kind", () => {
    const message = "Cache key nesting exceeds the maximum depth of 100"
    expect(ser(nestArrays(101))).toBe("[".repeat(101) + "]".repeat(101))
    expectCanonicalError(() => ser(nestArrays(102)), message)
    expectCanonicalError(() => ser(nestMapValues(110)), message)
    expectCanonicalError(() => ser(nestMapKeys(110)), message)
    expectCanonicalError(() => ser(nestSets(110)), message)
    expectCanonicalError(() => ser(nestObjects(110)), message)
    expectCanonicalError(() => ser(nestArrays(110)), message)
  })

  it("enforces item, key and node limits at their exact boundaries", () => {
    const nodesMessage = "Cache key exceeds the maximum of 10000 nodes"
    const bytesMessage = "Cache key part exceeds the maximum of 2048 bytes"
    expectCanonicalError(() => ser(new Array<number>(10_001).fill(0)), "Cache key array exceeds the maximum of 10000 items")
    expectCanonicalError(() => ser(new Array<number>(10_000).fill(0)), nodesMessage)
    expectCanonicalError(() => ser(new Array<number>(9_999).fill(0)), bytesMessage)
    expectCanonicalError(() => ser(new Array<number>(10_000).fill(0)), nodesMessage)

    const mapOf = (size: number) => new Map(Array.from({ length: size }, (_, index) => [index, index] as const))
    expectCanonicalError(() => ser(mapOf(10_001)), "Cache key Map exceeds the maximum of 10000 items")
    expectCanonicalError(() => ser(mapOf(10_000)), nodesMessage)
    const setOf = (size: number) => new Set(Array.from({ length: size }, (_, index) => index))
    expectCanonicalError(() => ser(setOf(10_001)), "Cache key Set exceeds the maximum of 10000 items")
    expectCanonicalError(() => ser(setOf(10_000)), nodesMessage)
    const objectOf = (size: number) => Object.fromEntries(Array.from({ length: size }, (_, index) => [`k${index}`, 0]))
    expectCanonicalError(() => ser(objectOf(10_001)), "Cache key object exceeds the maximum of 10000 keys")
    expectCanonicalError(() => ser(objectOf(10_000)), nodesMessage)
  })

  it("enforces string, property-name and total byte limits at their exact boundaries", () => {
    const stringMessage = "Cache key string exceeds the maximum of 2048 bytes"
    const propertyMessage = "Cache key property exceeds the maximum of 2048 bytes"
    const partMessage = "Cache key part exceeds the maximum of 2048 bytes"
    expectCanonicalError(() => ser("a".repeat(2049)), stringMessage)
    expectCanonicalError(() => ser("a".repeat(2048)), partMessage)
    expectCanonicalError(() => ser("é".repeat(1024)), partMessage)
    expectCanonicalError(() => ser("é".repeat(1025)), stringMessage)
    expect(ser("a".repeat(2046))).toBe(`"${"a".repeat(2046)}"`)
    expect(ser("a".repeat(2046))).toHaveLength(MAX_CACHE_KEY_BYTES)

    expectCanonicalError(() => ser({ ["a".repeat(2049)]: 1 }), propertyMessage)
    expectCanonicalError(() => ser({ ["a".repeat(2048)]: 1 }), partMessage)
    expectCanonicalError(() => ser({ ["é".repeat(1024)]: 1 }), partMessage)
    expectCanonicalError(() => ser({ ["é".repeat(1025)]: 1 }), propertyMessage)
  })
})

describe("buildKey mutation kills", () => {
  it("joins encoded parts and enforces the byte limit exactly", () => {
    expect(buildKey("a b", "c:d", "e/f")).toBe("a%20b:c%3Ad:e%2Ff")
    expect(buildKey("a".repeat(2046), "", "")).toHaveLength(2048)
    expectCanonicalError(() => buildKey("a".repeat(2047), "", ""), "Cache key exceeds the maximum of 2048 bytes")
  })

  it("reports lone surrogates as invalid keys and keeps the cause", () => {
    const error = expectCanonicalError(() => buildKey("\ud800", "b", "c"), "Cache key parts must be well-formed UTF-16 strings")
    expect(error.cause).toBeInstanceOf(URIError)
  })
})

describe("cache error classes mutation kills", () => {
  it("names and describes adapter and overload failures", () => {
    const cause = new Error("boom")
    const adapterError = new CacheAdapterError("get", { cause })
    expect(adapterError.name).toBe("CacheAdapterError")
    expect(adapterError.message).toBe("Cache operation failed: get")
    expect(adapterError.operation).toBe("get")
    expect(adapterError.cause).toBe(cause)
    const overload = new CacheOverloadError(7)
    expect(overload.name).toBe("CacheOverloadError")
    expect(overload.message).toBe("Cache resolver capacity exhausted (7 in flight)")
    expect(overload.maxInFlight).toBe(7)
  })
})

describe("compileCacheInvalidationStrategy mutation kills", () => {
  const base = { correctnessCritical: false, atomicAvailable: false, durableEventualAvailable: false }

  it("returns a frozen strategy for every available guarantee", () => {
    const best = compileCacheInvalidationStrategy({ ...base, requested: "best-effort" })
    expect(best).toEqual({ guarantee: "best-effort", correctnessCritical: false })
    expect(Object.isFrozen(best)).toBe(true)
    const atomic = compileCacheInvalidationStrategy({ ...base, requested: "atomic-generation", atomicAvailable: true, correctnessCritical: true })
    expect(atomic).toEqual({ guarantee: "atomic-generation", correctnessCritical: true })
    const durable = compileCacheInvalidationStrategy({ ...base, requested: "durable-eventual-generation", durableEventualAvailable: true })
    expect(durable).toEqual({ guarantee: "durable-eventual-generation", correctnessCritical: false })
    expect(Object.isFrozen(durable)).toBe(true)
  })

  it("rejects each unavailable guarantee with its own message", () => {
    expect(() => compileCacheInvalidationStrategy({ ...base, requested: "best-effort", correctnessCritical: true })).toThrow(ConfigurationError)
    expect(() => compileCacheInvalidationStrategy({ ...base, requested: "best-effort", correctnessCritical: true })).toThrow(
      "Correctness-critical cache invalidation cannot use best-effort",
    )
    expect(() => compileCacheInvalidationStrategy({ ...base, requested: "atomic-generation" })).toThrow(
      "Atomic cache generation is required but not proven",
    )
    expect(() => compileCacheInvalidationStrategy({ ...base, requested: "durable-eventual-generation" })).toThrow(
      "Durable eventual cache generation is required but no finalizer is available",
    )
    expect(() => compileCacheInvalidationStrategy({ ...base, requested: "atomic-generation", durableEventualAvailable: true })).toThrow(ConfigurationError)
  })
})
