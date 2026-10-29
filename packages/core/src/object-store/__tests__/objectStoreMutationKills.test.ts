import { describe, expect, it } from "vitest"
import { CancelledError, RuntimeCapabilityError, TimeoutError, ValidationError } from "../../domain/errors"
import {
  assertObjectRequestActive, requireObjectStore, validateObjectKey, validateObjectMetadata, validatePutObjectInput, validateSignedObjectReference,
  type ObjectMetadata, type PutObjectInput, type SignedObjectReference,
} from "../objectStore"

const put = (o: Record<string, unknown> = {}): PutObjectInput => ({ key: "k", body: new Uint8Array([1, 2]), contentLength: 2, ...o }) as PutObjectInput
const meta = (o: Record<string, unknown> = {}): ObjectMetadata => ({ key: "k", contentLength: 2, ...o }) as ObjectMetadata
const signed = (o: Record<string, unknown> = {}): SignedObjectReference => ({ url: "https://x/y", expiresAt: new Date(2000), ...o }) as SignedObjectReference
const invalid = (fn: () => unknown, message: string) => {
  try { fn() } catch (e) {
    expect(e).toBeInstanceOf(ValidationError)
    expect((e as ValidationError).message).toBe(message)
    return
  }
  throw new Error(`expected ValidationError: ${message}`)
}

describe("assertObjectRequestActive", () => {
  it("reports cancellation with the object-request message", () => {
    const controller = new AbortController()
    controller.abort()
    try { assertObjectRequestActive({ signal: controller.signal }) } catch (e) {
      expect(e).toBeInstanceOf(CancelledError)
      expect((e as Error).message).toBe("Object request was cancelled")
      return
    }
    throw new Error("expected cancellation")
  })
  it("rejects non-finite deadlines with details", () => {
    for (const deadline of [Number.NaN, Number.POSITIVE_INFINITY]) {
      try { assertObjectRequestActive({ deadline }) } catch (e) {
        expect(e).toBeInstanceOf(RuntimeCapabilityError)
        expect((e as RuntimeCapabilityError).message).toBe("Object request deadline is invalid")
        expect((e as RuntimeCapabilityError).details).toEqual({ deadline })
        continue
      }
      throw new Error("expected invalid deadline")
    }
  })
  it("expires exactly at the deadline", () => {
    expect(() => assertObjectRequestActive({ deadline: 1001 }, 1000)).not.toThrow()
    expect(() => assertObjectRequestActive({}, 1000)).not.toThrow()
    try { assertObjectRequestActive({ deadline: 1000 }, 1000) } catch (e) {
      expect(e).toBeInstanceOf(TimeoutError)
      expect((e as TimeoutError).message).toBe("Object request deadline exceeded")
      expect((e as TimeoutError).details).toEqual({ deadline: 1000 })
      return
    }
    throw new Error("expected timeout")
  })
})

describe("validateObjectKey and requireObjectStore", () => {
  it("bounds keys at 1024 characters", () => {
    const m = "Object key must contain 1-1024 non-NUL characters"
    invalid(() => validateObjectKey(""), m)
    invalid(() => validateObjectKey("a".repeat(1025)), m)
    invalid(() => validateObjectKey("a\0b"), m)
    expect(validateObjectKey("a".repeat(1024))).toHaveLength(1024)
  })
  it("requires all four methods on an object", () => {
    const fn = async () => null
    const full = { put: fn, get: fn, head: fn, delete: fn } as never
    expect(requireObjectStore(full)).toBe(full)
    const bad = (value: unknown) => {
      try { requireObjectStore(value as never) } catch (e) {
        expect(e).toBeInstanceOf(RuntimeCapabilityError)
        expect((e as RuntimeCapabilityError).message).toBe("ObjectStore capability is not available")
        expect((e as RuntimeCapabilityError).details).toEqual({ capability: "objectStore" })
        return
      }
      throw new Error("expected capability error")
    }
    bad(undefined)
    bad(null)
    bad("store")
    bad(() => 1)
    for (const missing of ["put", "get", "head", "delete"]) bad({ put: fn, get: fn, head: fn, delete: fn, [missing]: undefined })
    bad({})
  })
})

describe("validatePutObjectInput", () => {
  it("validates the reference", () => {
    const m = "Object reference is invalid"
    invalid(() => validatePutObjectInput(null as never), m)
    invalid(() => validatePutObjectInput("x" as never), m)
    invalid(() => validatePutObjectInput(put({ key: 5 })), m)
    invalid(() => validatePutObjectInput(put({ key: "" })), "Object key must contain 1-1024 non-NUL characters")
    invalid(() => validatePutObjectInput(put({ bucket: "" })), "Object bucket must be a non-empty string")
    invalid(() => validatePutObjectInput(put({ bucket: "  " })), "Object bucket must be a non-empty string")
    invalid(() => validatePutObjectInput(put({ bucket: 5 })), "Object bucket must be a non-empty string")
    invalid(() => validatePutObjectInput(put({ version: " " })), "Object version must be a non-empty string")
    invalid(() => validatePutObjectInput(put({ version: 1 })), "Object version must be a non-empty string")
    const ok = put({ bucket: "b", version: "v1" })
    expect(validatePutObjectInput(ok)).toBe(ok)
  })
  it("checks request activity first", () => {
    expect(() => validatePutObjectInput(put({ deadline: 1 }))).toThrow(TimeoutError)
  })
  it("validates the declared length and body", () => {
    const m = "Object contentLength must be a non-negative safe integer"
    for (const contentLength of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, "2"]) invalid(() => validatePutObjectInput(put({ contentLength })), m)
    const body = "Object body must be bytes or a readable byte stream"
    invalid(() => validatePutObjectInput(put({ body: "abc" })), body)
    invalid(() => validatePutObjectInput(put({ body: [1, 2] })), body)
    invalid(() => validatePutObjectInput(put({ body: new ArrayBuffer(2) })), body)
    invalid(() => validatePutObjectInput(put({ body: new Uint8Array(3) })), "Object byte body does not match declared contentLength")
    invalid(() => validatePutObjectInput(put({ body: new Uint8Array(1) })), "Object byte body does not match declared contentLength")
    expect(validatePutObjectInput(put({ body: new Uint8Array(0), contentLength: 0 })).contentLength).toBe(0)
    const stream = new ReadableStream<Uint8Array>()
    expect(validatePutObjectInput(put({ body: stream, contentLength: 999 })).body).toBe(stream)
  })
  it("validates content type, checksum and metadata", () => {
    const ct = "Object contentType must be non-empty"
    invalid(() => validatePutObjectInput(put({ contentType: "" })), ct)
    invalid(() => validatePutObjectInput(put({ contentType: "  " })), ct)
    invalid(() => validatePutObjectInput(put({ contentType: 5 })), ct)
    expect(validatePutObjectInput(put({ contentType: "text/plain" })).contentType).toBe("text/plain")
    const cs = "Object checksum is invalid"
    invalid(() => validatePutObjectInput(put({ checksum: null })), cs)
    invalid(() => validatePutObjectInput(put({ checksum: { algorithm: "", value: "v" } })), cs)
    invalid(() => validatePutObjectInput(put({ checksum: { algorithm: " ", value: "v" } })), cs)
    invalid(() => validatePutObjectInput(put({ checksum: { algorithm: 5, value: "v" } })), cs)
    invalid(() => validatePutObjectInput(put({ checksum: { algorithm: "sha256", value: "" } })), cs)
    invalid(() => validatePutObjectInput(put({ checksum: { algorithm: "sha256", value: "  " } })), cs)
    invalid(() => validatePutObjectInput(put({ checksum: { algorithm: "sha256", value: 5 } })), cs)
    expect(validatePutObjectInput(put({ checksum: { algorithm: "sha256", value: "abc" } })).checksum?.value).toBe("abc")
    const md = "Object metadata must be a string record"
    invalid(() => validatePutObjectInput(put({ metadata: null })), md)
    invalid(() => validatePutObjectInput(put({ metadata: "x" })), md)
    invalid(() => validatePutObjectInput(put({ metadata: ["a"] })), md)
    const entries = "Object metadata must contain non-empty string keys and string values"
    invalid(() => validatePutObjectInput(put({ metadata: { "": "v" } })), entries)
    invalid(() => validatePutObjectInput(put({ metadata: { " ": "v" } })), entries)
    invalid(() => validatePutObjectInput(put({ metadata: { a: 1 } })), entries)
    expect(validatePutObjectInput(put({ metadata: { a: "" } })).metadata).toEqual({ a: "" })
  })
})

describe("validateObjectMetadata", () => {
  it("validates reference, length, checksum, metadata and lastModified", () => {
    invalid(() => validateObjectMetadata(null as never), "Object reference is invalid")
    invalid(() => validateObjectMetadata(meta({ bucket: "" })), "Object bucket must be a non-empty string")
    const len = "Object metadata contentLength is invalid"
    for (const contentLength of [-1, 1.5, Number.NaN, "2"]) invalid(() => validateObjectMetadata(meta({ contentLength })), len)
    expect(validateObjectMetadata(meta({ contentLength: 0 })).contentLength).toBe(0)
    invalid(() => validateObjectMetadata(meta({ checksum: { algorithm: "", value: "v" } })), "Object checksum is invalid")
    invalid(() => validateObjectMetadata(meta({ metadata: { a: 1 } })), "Object metadata must contain non-empty string keys and string values")
    invalid(() => validateObjectMetadata(meta({ metadata: [] })), "Object metadata must be a string record")
    const lm = "Object metadata lastModified is invalid"
    invalid(() => validateObjectMetadata(meta({ lastModified: new Date(Number.NaN) })), lm)
    invalid(() => validateObjectMetadata(meta({ lastModified: "2026-01-01" })), lm)
  })
  it("returns a frozen snapshot labelled as object metadata", () => {
    const input = meta({ lastModified: new Date(5), metadata: { a: "b" } })
    const out = validateObjectMetadata(input)
    expect(out).not.toBe(input)
    expect(Object.isFrozen(out)).toBe(true)
    expect(out.lastModified?.getTime()).toBe(5)
    expect(out.lastModified).not.toBe(input.lastModified)
    expect(() => validateObjectMetadata(meta({ extra: () => 1 }))).toThrow("Object metadata must contain data only")
  })
})

describe("validateSignedObjectReference", () => {
  const m = "Signed object reference is invalid or expired"
  it("validates url, expiry and shape", () => {
    invalid(() => validateSignedObjectReference(null as never, 1000), m)
    invalid(() => validateSignedObjectReference("x" as never, 1000), m)
    invalid(() => validateSignedObjectReference(signed({ url: 5 }), 1000), m)
    invalid(() => validateSignedObjectReference(signed({ url: "  " }), 1000), m)
    invalid(() => validateSignedObjectReference(signed({ expiresAt: "2030-01-01" }), 1000), m)
    invalid(() => validateSignedObjectReference(signed({ expiresAt: new Date(Number.NaN) }), 1000), m)
    invalid(() => validateSignedObjectReference(signed({ expiresAt: new Date(1000) }), 1000), m)
    invalid(() => validateSignedObjectReference(signed({ expiresAt: new Date(999) }), 1000), m)
    expect(validateSignedObjectReference(signed({ expiresAt: new Date(1001) }), 1000).url).toBe("https://x/y")
  })
  it("validates headers", () => {
    const h = "Signed object headers are invalid"
    invalid(() => validateSignedObjectReference(signed({ headers: null }), 1), h)
    invalid(() => validateSignedObjectReference(signed({ headers: "x" }), 1), h)
    invalid(() => validateSignedObjectReference(signed({ headers: ["a"] }), 1), h)
    invalid(() => validateSignedObjectReference(signed({ headers: { "": "v" } }), 1), h)
    invalid(() => validateSignedObjectReference(signed({ headers: { " ": "v" } }), 1), h)
    invalid(() => validateSignedObjectReference(signed({ headers: { a: 1 } }), 1), h)
    const ok = validateSignedObjectReference(signed({ headers: { a: "b" } }), 1)
    expect(ok.headers).toEqual({ a: "b" })
    expect(Object.isFrozen(ok)).toBe(true)
    expect(ok.expiresAt.getTime()).toBe(2000)
    expect(() => validateSignedObjectReference(signed({ extra: () => 1 }), 1)).toThrow("Signed object reference must contain data only")
  })
})
