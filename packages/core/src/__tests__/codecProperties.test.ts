import { describe, expect, it } from "vitest"
import { createHmac, timingSafeEqual } from "node:crypto"
import { canonicalJsonString, decodeCanonicalJson } from "../serialization/canonicalJson"
import { serializeCacheKeyPart } from "../cache/cache"
import { decodeCursor, encodeCursor, type CursorIntegrityPort } from "../query/cursorCodec"
import type { CursorPayloadV1, CursorValue } from "../query/cursor"

/** Deterministic generator: failures are reproducible from the seed. */
function generator(seed: number) {
  let state = seed >>> 0
  const next = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state }
  const pick = <T>(values: readonly T[]): T => values[next() % values.length]!
  const string = (): string => Array.from({ length: next() % 8 }, () => pick(["a", "Z", "é", "😀", " ", "\"", "\\", "\n", "0", " "])).join("")
  const scalar = (): unknown => pick([() => null, () => true, () => false, () => (next() % 2_000_001) - 1_000_000, () => string()])()
  const json = (depth: number): unknown => {
    const roll = next() % 10
    if (depth > 3 || roll < 5) return scalar()
    if (roll < 7) return Array.from({ length: next() % 4 }, () => json(depth + 1))
    const out: Record<string, unknown> = {}
    for (let index = 0; index < next() % 5; index++) out[`${string()}${index}`] = json(depth + 1)
    return out
  }
  const shuffleKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shuffleKeys)
    if (value === null || typeof value !== "object") return value
    const entries = Object.entries(value).map(([key, item]) => [key, shuffleKeys(item)] as const)
    for (let index = entries.length - 1; index > 0; index--) { const swap = next() % (index + 1); [entries[index], entries[swap]] = [entries[swap]!, entries[index]!] }
    return Object.fromEntries(entries)
  }
  return { next, pick, string, json, shuffleKeys }
}

const ITERATIONS = 400

describe("canonical JSON properties", () => {
  it("round-trips and is independent of key insertion order", () => {
    const g = generator(0xc0ffee)
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const value = g.json(0)
      const encoded = canonicalJsonString(value)
      expect(canonicalJsonString(decodeCanonicalJson(encoded))).toBe(encoded)
      expect(canonicalJsonString(g.shuffleKeys(value))).toBe(encoded)
      expect(decodeCanonicalJson(encoded)).toEqual(JSON.parse(encoded))
    }
  })
})

describe("cache key properties", () => {
  it("is deterministic, order-independent for objects/sets/maps, and injective on distinct values", () => {
    const g = generator(0xbeef)
    const seen = new Map<string, string>()
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const value = g.json(0)
      const key = serializeCacheKeyPart(value)
      expect(serializeCacheKeyPart(g.shuffleKeys(value))).toBe(key)
      const canonical = canonicalJsonString(value)
      const previous = seen.get(key)
      if (previous !== undefined) expect(previous).toBe(canonical)
      seen.set(key, canonical)
    }
    const items = ["b", "a", "c"]
    expect(serializeCacheKeyPart(new Set(items))).toBe(serializeCacheKeyPart(new Set([...items].reverse())))
    expect(serializeCacheKeyPart(new Map([["x", 1], ["y", 2]]))).toBe(serializeCacheKeyPart(new Map([["y", 2], ["x", 1]])))
    expect(serializeCacheKeyPart(undefined)).not.toBe(serializeCacheKeyPart(null))
    expect(serializeCacheKeyPart(Number.NaN)).not.toBe(serializeCacheKeyPart(null))
    expect(serializeCacheKeyPart("1")).not.toBe(serializeCacheKeyPart(1))
  })
})

describe("cursor codec properties", () => {
  const key = "property-test-cursor-key"
  const integrity: CursorIntegrityPort = {
    async sign(payload) { return createHmac("sha256", key).update(payload).digest() },
    async verify(payload, signature) {
      const expected = createHmac("sha256", key).update(payload).digest()
      return expected.length === signature.length && timingSafeEqual(expected, signature)
    },
  }

  it("round-trips every valid payload and rejects any single-character tampering", async () => {
    const g = generator(0xdecaf)
    for (let iteration = 0; iteration < 150; iteration++) {
      const values: CursorValue[] = Array.from({ length: 1 + (g.next() % 4) }, () => g.pick([() => null, () => g.string(), () => (g.next() % 1000) - 500, () => g.next() % 2 === 0])())
      const payload: CursorPayloadV1 = { format: "framework.cursor", version: 1, direction: g.pick(["after", "before"] as const), values, routeHash: `r${g.next()}`, queryHash: `q${g.next()}`, scopeHash: `s${g.next()}`, sortHash: `o${g.next()}`, ...(g.next() % 2 === 0 ? { expiresAt: 10_000_000 } : {}) }
      const cursor = await encodeCursor(payload, integrity)
      await expect(decodeCursor(cursor, integrity, 8192, { now: 0 })).resolves.toEqual(payload)
      const position = g.next() % cursor.length
      const replacement = cursor[position] === "A" ? "B" : "A"
      const tampered = `${cursor.slice(0, position)}${replacement}${cursor.slice(position + 1)}`
      await expect(decodeCursor(tampered, integrity, 8192, { now: 0 })).rejects.toThrow()
    }
  })
})
