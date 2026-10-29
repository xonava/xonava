import { describe, expect, it } from "vitest"
import { TimeoutError, UnavailableError, ValidationError } from "@xonava/core/domain"
import { R2ObjectStore } from ".."

type Bucket = ConstructorParameters<typeof R2ObjectStore>[0]
interface Raw { key: string; version: string; size: number; etag: string; uploaded: Date; httpMetadata?: { contentType?: string } | undefined; customMetadata?: Record<string, string> | undefined; checksums: { toJSON(): { sha256?: string } } }
const raw = (over: Partial<Raw> = {}): Raw => ({ key: "k", version: "v1", size: 3, etag: "etag1", uploaded: new Date(1000), httpMetadata: { contentType: "text/plain" }, customMetadata: { a: "1" }, checksums: { toJSON: () => ({ sha256: "AB".repeat(32) }) }, ...over })
const body = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close() } })

function recorder(result: Raw | null = raw()) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const bucket = {
    put: (...args: unknown[]) => { calls.push({ method: "put", args }); return Promise.resolve(result) },
    get: (...args: unknown[]) => { calls.push({ method: "get", args }); return Promise.resolve(result === null ? null : { ...result, body: body() }) },
    head: (...args: unknown[]) => { calls.push({ method: "head", args }); return Promise.resolve(result) },
    delete: (...args: unknown[]) => { calls.push({ method: "delete", args }); return Promise.resolve() },
  }
  return { bucket: bucket as unknown as Bucket, calls }
}
const failing = (method: "put" | "get" | "head" | "delete", error: unknown, result: Raw | null = raw()) =>
  ({ put: () => Promise.reject(error), get: () => Promise.reject(error), head: () => Promise.resolve(result), delete: () => Promise.resolve(), [method]: () => Promise.reject(error) }) as unknown as Bucket

describe("R2ObjectStore put arguments", () => {
  it("passes key, a byte copy, and exactly the supplied content type, metadata and lowercase sha256", async () => {
    const { bucket, calls } = recorder()
    const source = new Uint8Array([1, 2, 3])
    const custom = { a: "1" }
    await new R2ObjectStore(bucket).put({ key: "k", body: source, contentLength: 3, contentType: "text/plain", metadata: custom, checksum: { algorithm: "sha256", value: "AB".repeat(32) } })
    expect(calls).toHaveLength(1)
    const [key, bytes, options] = calls[0]!.args as [string, Uint8Array, Record<string, unknown>]
    expect(key).toBe("k")
    expect([...bytes]).toEqual([1, 2, 3])
    expect(options).toEqual({ httpMetadata: { contentType: "text/plain" }, customMetadata: { a: "1" }, sha256: "ab".repeat(32) })
    expect(options.customMetadata).not.toBe(custom)
  })

  it("passes an empty options object when nothing optional is supplied", async () => {
    const { bucket, calls } = recorder()
    await new R2ObjectStore(bucket).put({ key: "k", body: new Uint8Array([1, 2, 3]), contentLength: 3 })
    expect(calls[0]!.args[2]).toEqual({})
    expect(Object.keys(calls[0]!.args[2] as object)).toEqual([])
  })

  it("passes each option independently", async () => {
    for (const [extra, expected] of [
      [{ contentType: "a/b" }, { httpMetadata: { contentType: "a/b" } }],
      [{ metadata: { x: "y" } }, { customMetadata: { x: "y" } }],
      [{ checksum: { algorithm: "sha256", value: "c".repeat(64) } }, { sha256: "c".repeat(64) }],
    ] as const) {
      const { bucket, calls } = recorder()
      await new R2ObjectStore(bucket).put({ key: "k", body: new Uint8Array([1, 2, 3]), contentLength: 3, ...extra } as never)
      expect(calls[0]!.args[2]).toEqual(expected)
    }
  })

  it("reads a stream body of the declared length", async () => {
    const { bucket, calls } = recorder()
    await new R2ObjectStore(bucket).put({ key: "k", body: body(), contentLength: 3 })
    expect([...(calls[0]!.args[1] as Uint8Array)]).toEqual([1, 2, 3])
  })

  it("does not call R2 when the request is cancelled after the body was read", async () => {
    const { bucket, calls } = recorder()
    const controller = new AbortController()
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; if (pulls === 1) c.enqueue(new Uint8Array([1])); else { controller.abort(); c.close() } } })
    await expect(new R2ObjectStore(bucket).put({ key: "k", body: stream, contentLength: 1, signal: controller.signal })).rejects.toThrow("Object request was cancelled")
    expect(calls).toHaveLength(0)
  })

  it("validates before touching R2", async () => {
    const { bucket, calls } = recorder()
    const store = new R2ObjectStore(bucket)
    await expect(store.put({ key: "k", body: new Uint8Array([1]), contentLength: 1, bucket: "other" })).rejects.toThrow("Object bucket is not served by this store")
    await expect(store.put({ key: "k", body: new Uint8Array([1]), contentLength: 1, checksum: { algorithm: "sha256", value: "zz" } })).rejects.toBeInstanceOf(ValidationError)
    expect(calls).toHaveLength(0)
  })
})

describe("R2ObjectStore returned metadata", () => {
  it("maps every R2 field, lowercases the checksum and freezes the result", async () => {
    const store = new R2ObjectStore(recorder().bucket, { bucket: "main" })
    const meta = await store.head({ key: "k", bucket: "main" })
    expect(meta).toEqual({ bucket: "main", key: "k", version: "v1", contentLength: 3, contentType: "text/plain", checksum: { algorithm: "sha256", value: "ab".repeat(32) }, metadata: { a: "1" }, etag: "etag1", lastModified: new Date(1000) })
    expect(Object.isFrozen(meta)).toBe(true)
    expect(Object.isFrozen(meta!.checksum)).toBe(true)
    expect(Object.isFrozen(meta!.metadata)).toBe(true)
  })

  it("omits bucket, contentType, checksum and metadata when absent or empty, and copies the date", async () => {
    const uploaded = new Date(5)
    const { bucket } = recorder(raw({ httpMetadata: undefined, customMetadata: {}, checksums: { toJSON: () => ({}) }, uploaded }))
    const meta = await new R2ObjectStore(bucket).head({ key: "k" })
    expect(Object.keys(meta!).sort()).toEqual(["contentLength", "etag", "key", "lastModified", "version"])
    expect(meta!.lastModified).not.toBe(uploaded)
    expect(meta!.lastModified?.getTime()).toBe(5)
  })

  it("omits contentType when http metadata has none and metadata when customMetadata is undefined", async () => {
    const { bucket } = recorder(raw({ httpMetadata: {}, customMetadata: undefined }))
    const meta = await new R2ObjectStore(bucket).head({ key: "k" })
    expect(meta).not.toHaveProperty("contentType")
    expect(meta).not.toHaveProperty("metadata")
  })

  it("does not alias provider custom metadata", async () => {
    const custom = { a: "1" }
    const { bucket } = recorder(raw({ customMetadata: custom }))
    const meta = await new R2ObjectStore(bucket).head({ key: "k" })
    custom.a = "2"
    expect(meta!.metadata).toEqual({ a: "1" })
  })

  it("returns put metadata under the request key", async () => {
    const meta = await new R2ObjectStore(recorder(raw({ key: "ignored" })).bucket).put({ key: "k", body: new Uint8Array([1, 2, 3]), contentLength: 3 })
    expect(meta.key).toBe("k")
    expect(meta.version).toBe("v1")
  })
})

describe("R2ObjectStore reads and deletes", () => {
  it("get returns the body and metadata, and answers null for a missing object", async () => {
    const { bucket, calls } = recorder()
    const result = await new R2ObjectStore(bucket).get({ key: "k", version: "v1" })
    expect(calls).toEqual([{ method: "get", args: ["k"] }])
    expect(result!.metadata.version).toBe("v1")
    const reader = (result!.body as ReadableStream<Uint8Array>).getReader()
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]))
    expect(await new R2ObjectStore(recorder(null).bucket).get({ key: "k" })).toBeNull()
  })

  it("get and head with a version that is current succeed, a different one answer null", async () => {
    const store = new R2ObjectStore(recorder().bucket)
    expect(await store.get({ key: "k", version: "v1" })).not.toBeNull()
    expect(await store.get({ key: "k", version: "v2" })).toBeNull()
    expect(await store.head({ key: "k", version: "v1" })).not.toBeNull()
    expect(await store.head({ key: "k", version: "v2" })).toBeNull()
    expect(await new R2ObjectStore(recorder(null).bucket).head({ key: "k" })).toBeNull()
  })

  it("get and head check cancellation before calling R2", async () => {
    const { bucket, calls } = recorder()
    const store = new R2ObjectStore(bucket)
    const controller = new AbortController(); controller.abort()
    await expect(store.get({ key: "k", signal: controller.signal })).rejects.toThrow("Object request was cancelled")
    await expect(store.head({ key: "k", deadline: Date.now() - 1 })).rejects.toBeInstanceOf(TimeoutError)
    await expect(store.delete({ key: "k", signal: controller.signal })).rejects.toThrow("Object request was cancelled")
    expect(calls).toHaveLength(0)
  })

  it("delete answers false without deleting when the object is missing, true after deleting", async () => {
    const missing = recorder(null)
    expect(await new R2ObjectStore(missing.bucket).delete({ key: "k" })).toBe(false)
    expect(missing.calls.map(c => c.method)).toEqual(["head"])
    const present = recorder()
    expect(await new R2ObjectStore(present.bucket).delete({ key: "k", version: "v1" })).toBe(true)
    expect(present.calls).toEqual([{ method: "head", args: ["k"] }, { method: "delete", args: ["k"] }])
  })

  it("delete rechecks cancellation between head and delete", async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const bucket = { head: () => { calls.push("head"); controller.abort(); return Promise.resolve(raw()) }, delete: () => { calls.push("delete"); return Promise.resolve() } } as unknown as Bucket
    await expect(new R2ObjectStore(bucket).delete({ key: "k", signal: controller.signal })).rejects.toThrow("Object request was cancelled")
    expect(calls).toEqual(["head"])
  })

  it("delete surfaces a failing R2 delete as UnavailableError", async () => {
    await expect(new R2ObjectStore(failing("delete", new Error("boom"))).delete({ key: "k" })).rejects.toBeInstanceOf(UnavailableError)
  })
})

describe("R2ObjectStore reference checks", () => {
  it("accepts a key of exactly 1024 UTF-8 bytes and rejects 1025 with the exact message", async () => {
    const { bucket } = recorder()
    const store = new R2ObjectStore(bucket)
    expect(await store.head({ key: "é".repeat(512) })).not.toBeNull()
    const error = await store.head({ key: `${"é".repeat(512)}a` }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe("Object key must be at most 1024 bytes in UTF-8 for R2")
  })

  it("serves unnamed references, and named ones only for the configured bucket", async () => {
    const { bucket, calls } = recorder()
    const named = new R2ObjectStore(bucket, { bucket: "main" })
    expect(await named.head({ key: "k" })).not.toBeNull()
    expect(await named.head({ key: "k", bucket: "main" })).not.toBeNull()
    await expect(named.head({ key: "k", bucket: "other" })).rejects.toThrow("Object bucket is not served by this store")
    const anonymous = new R2ObjectStore(bucket)
    await expect(anonymous.head({ key: "k", bucket: "main" })).rejects.toThrow("Object bucket is not served by this store")
    expect(calls).toHaveLength(2)
  })

  it("rejects an invalid key with the core message before any provider call", async () => {
    const { bucket, calls } = recorder()
    await expect(new R2ObjectStore(bucket).get({ key: "" })).rejects.toBeInstanceOf(ValidationError)
    expect(calls).toHaveLength(0)
  })
})

describe("R2ObjectStore provider errors", () => {
  const input = { key: "k", body: new Uint8Array([1, 2, 3]), contentLength: 3 }
  it("passes framework errors through untouched", async () => {
    const original = new ValidationError("mine")
    for (const call of [
      (b: Bucket) => new R2ObjectStore(b).put(input),
      (b: Bucket) => new R2ObjectStore(b).get({ key: "k" }),
      (b: Bucket) => new R2ObjectStore(b).head({ key: "k" }),
    ]) {
      const bucket = failing("put", original); (bucket as unknown as Record<string, unknown>).get = () => Promise.reject(original); (bucket as unknown as Record<string, unknown>).head = () => Promise.reject(original)
      expect(await call(bucket).catch((e: unknown) => e)).toBe(original)
    }
  })

  it("wraps other failures with the fixed message and the provider error as cause", async () => {
    const cause = new Error("secret detail")
    for (const run of [
      () => new R2ObjectStore(failing("put", cause)).put(input),
      () => new R2ObjectStore(failing("get", cause)).get({ key: "k" }),
      () => new R2ObjectStore(failing("head", cause)).head({ key: "k" }),
    ]) {
      const error = await run().catch((e: unknown) => e)
      expect(error).toBeInstanceOf(UnavailableError)
      expect((error as Error).message).toBe("Object store is unavailable")
      expect((error as Error).cause).toBe(cause)
    }
  })

  it("maps a checksum mismatch on put only, case- and newline-insensitively, with the exact message", async () => {
    const mismatch = new Error("The CHECKSUM you\nspecified DID NOT MATCH what we received")
    const error = await new R2ObjectStore(failing("put", mismatch)).put(input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe("Object checksum does not match body bytes")
    expect(await new R2ObjectStore(failing("get", mismatch)).get({ key: "k" }).catch((e: unknown) => e)).toBeInstanceOf(UnavailableError)
    expect(await new R2ObjectStore(failing("head", mismatch)).head({ key: "k" }).catch((e: unknown) => e)).toBeInstanceOf(UnavailableError)
  })

  it("does not map near-miss messages or non-Error values to a validation error", async () => {
    for (const thrown of [new Error("checksum is wrong"), new Error("did not match"), "checksum did not match", { message: "checksum did not match" }]) {
      const error = await new R2ObjectStore(failing("put", thrown)).put(input).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(UnavailableError)
    }
  })
})

describe("R2ObjectStore put input validation", () => {
  it("rejects malformed put input before touching R2", async () => {
    const { bucket, calls } = recorder()
    const store = new R2ObjectStore(bucket)
    const bad: Array<Record<string, unknown>> = [
      { body: new Uint8Array([1, 2]), contentLength: 3 },
      { body: new Uint8Array([1]), contentLength: 1, contentType: "  " },
      { body: new Uint8Array([1]), contentLength: 1, metadata: { "": "x" } },
      { body: "text", contentLength: 4 },
      { body: new Uint8Array([1]), contentLength: -1 },
    ]
    for (const input of bad) await expect(store.put({ key: "k", ...input } as never)).rejects.toBeInstanceOf(ValidationError)
    expect(calls).toHaveLength(0)
  })
})
