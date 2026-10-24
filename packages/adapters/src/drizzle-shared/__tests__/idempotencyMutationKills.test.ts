import { describe, expect, it } from "vitest"
import type { IdempotencyRequest } from "@xonava/core/events"
import {
  decodeResourceVersion,
  encodeResourceVersion,
  parseInvalidations,
  resolveExistingIdempotency,
  serializeInvalidations,
} from "../idempotency"

const request = { fingerprint: "fp-1" } as unknown as IdempotencyRequest
const CORRUPT_RESOURCE = "Corrupted idempotency resource version: expected numeric envelope"

describe("serializeInvalidations", () => {
  it("returns null for undefined and empty input, and dedupes otherwise", () => {
    expect(serializeInvalidations(undefined)).toBeNull()
    expect(serializeInvalidations([])).toBeNull()
    expect(serializeInvalidations(["a", "b", "a"])).toBe('["a","b"]')
  })
})

describe("parseInvalidations", () => {
  it("maps null and undefined to an empty list", () => {
    expect(parseInvalidations(null)).toEqual([])
    expect(parseInvalidations(undefined)).toEqual([])
  })
  it("rejects non-string raw values with the observed type", () => {
    expect(() => parseInvalidations(5)).toThrow("Corrupted idempotency invalidation data: expected string, got number")
    expect(() => parseInvalidations({})).toThrow("Corrupted idempotency invalidation data: expected string, got object")
  })
  it("rejects non-array JSON", () => {
    expect(() => parseInvalidations('{"a":1}')).toThrow("Corrupted idempotency invalidation data: expected array")
    expect(() => parseInvalidations("null")).toThrow("Corrupted idempotency invalidation data: expected array")
  })
  it("rejects arrays with non-string entries", () => {
    expect(() => parseInvalidations('["a",1]')).toThrow("Corrupted idempotency invalidation data: expected string entries")
    expect(() => parseInvalidations("[null]")).toThrow("Corrupted idempotency invalidation data: expected string entries")
  })
  it("rejects malformed JSON with its own message", () => {
    expect(() => parseInvalidations("{nope")).toThrow("Corrupted idempotency invalidation data: malformed JSON")
  })
  it("parses and dedupes valid arrays, including empty", () => {
    expect(parseInvalidations('["a","b","a"]')).toEqual(["a", "b"])
    expect(parseInvalidations("[]")).toEqual([])
  })
})

describe("resource version codec", () => {
  it("round-trips a numeric version", () => {
    expect(encodeResourceVersion(3 as never)).toBe('{"type":"number","value":3}')
    expect(decodeResourceVersion('{"type":"number","value":3}')).toBe(3)
  })
  it("maps undefined and null to undefined", () => {
    expect(decodeResourceVersion(undefined)).toBeUndefined()
    expect(decodeResourceVersion(null)).toBeUndefined()
  })
  it.each([
    ["not json", "{x"],
    ["null", "null"],
    ["a number", "3"],
    ["a string", '"x"'],
    ["missing type", '{"value":3}'],
    ["missing value", '{"type":"number"}'],
    ["wrong type tag", '{"type":"string","value":3}'],
    ["non-version value", '{"type":"number","value":"3"}'],
    ["invalid version number", '{"type":"number","value":-1}'],
    ["both wrong", '{"type":"string","value":"x"}'],
    ["array", "[]"],
  ])("rejects %s", (_name, raw) => {
    expect(() => decodeResourceVersion(raw)).toThrow(CORRUPT_RESOURCE)
  })
})

describe("resolveExistingIdempotency", () => {
  const base = { fingerprint: "fp-1" }

  it("reports a conflict on fingerprint mismatch even for completed rows", () => {
    expect(resolveExistingIdempotency(request, { ...base, fingerprint: "other", status: "completed", result: '{"a":1}' })).toEqual({ outcome: "conflict" })
  })
  it("replays only completed rows with a string result", () => {
    expect(resolveExistingIdempotency(request, { ...base, status: "completed", result: '{"a":1}' })).toEqual({ outcome: "replay", result: { a: 1 } })
    expect(resolveExistingIdempotency(request, { ...base, status: "completed", result: null })).toBeUndefined()
    expect(resolveExistingIdempotency(request, { ...base, status: "completed" })).toBeUndefined()
    expect(resolveExistingIdempotency(request, { ...base, status: "pending", result: '{"a":1}' })).toBeUndefined()
    expect(resolveExistingIdempotency(request, { ...base, status: "pending" })).toBeUndefined()
  })
  it("returns business-committed with token, resource, version and invalidations", () => {
    expect(
      resolveExistingIdempotency(request, {
        ...base,
        status: "business-committed",
        token: "tok",
        resourceEntity: "Order",
        resourceId: "o1",
        resourceVersion: '{"type":"number","value":2}',
        pendingInvalidations: '["x","x","y"]',
      }),
    ).toEqual({ outcome: "business-committed", token: "tok", resource: { entity: "Order", id: "o1", version: 2 }, invalidations: ["x", "y"] })
  })
  it("omits version when absent and resource unless both entity and id are present", () => {
    const withBoth = resolveExistingIdempotency(request, { ...base, status: "business-committed", token: "t", resourceEntity: "E", resourceId: "i" })
    expect(withBoth).toEqual({ outcome: "business-committed", token: "t", resource: { entity: "E", id: "i" }, invalidations: [] })
    expect(withBoth && "resource" in withBoth && withBoth.resource && "version" in withBoth.resource).toBe(false)
    for (const partial of [{ resourceEntity: "E" }, { resourceId: "i" }, { resourceEntity: "", resourceId: "i" }, { resourceEntity: "E", resourceId: "" }, {}]) {
      const out = resolveExistingIdempotency(request, { ...base, status: "business-committed", token: "t", ...partial })
      expect(out).toEqual({ outcome: "business-committed", token: "t", invalidations: [] })
      expect(out && "resource" in out).toBe(false)
    }
  })
  it("propagates corruption errors for the resource version and invalidations", () => {
    expect(() => resolveExistingIdempotency(request, { ...base, status: "business-committed", token: "t", resourceVersion: "{bad" })).toThrow(CORRUPT_RESOURCE)
    expect(() => resolveExistingIdempotency(request, { ...base, status: "business-committed", token: "t", pendingInvalidations: "[1]" })).toThrow("expected string entries")
  })
})
