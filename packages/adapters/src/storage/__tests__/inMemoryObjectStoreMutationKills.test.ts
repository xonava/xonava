import { describe, expect, it } from "vitest"
import { TimeoutError, ValidationError } from "@xonava/core/domain"
import { InMemoryObjectStore } from ".."

const SHA_010203 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"
const put = (store: InMemoryObjectStore, extra: Record<string, unknown> = {}) => store.put({ key: "k", body: new Uint8Array([1, 2, 3]), contentLength: 3, ...extra } as never)

describe("InMemoryObjectStore metadata", () => {
  it("records exactly the supplied fields, numbered versions and a frozen result", async () => {
    const store = new InMemoryObjectStore()
    const before = Date.now()
    const first = await put(store, { bucket: "b", contentType: "text/plain", metadata: { a: "1" }, checksum: { algorithm: "sha256", value: SHA_010203.toUpperCase() } })
    expect(first).toMatchObject({ bucket: "b", key: "k", version: "1", contentLength: 3, contentType: "text/plain", metadata: { a: "1" }, checksum: { algorithm: "sha256", value: SHA_010203 }, etag: "mem-1-3" })
    expect(first.lastModified).toBeInstanceOf(Date)
    expect(first.lastModified?.getTime()).toBeGreaterThanOrEqual(before)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.checksum)).toBe(true)
    expect(Object.isFrozen(first.metadata)).toBe(true)
    const second = await put(store, { key: "k2" })
    expect(second.version).toBe("2")
    expect(second.etag).toBe("mem-2-3")
    expect(Object.keys(second).sort()).toEqual(["contentLength", "etag", "key", "lastModified", "version"])
  })

  it("does not alias the caller's metadata object", async () => {
    const store = new InMemoryObjectStore()
    const custom = { a: "1" }
    const stored = await put(store, { metadata: custom })
    custom.a = "2"
    expect(stored.metadata).toEqual({ a: "1" })
  })
})

describe("InMemoryObjectStore identity and versions", () => {
  it("keeps the same key in different buckets (and no bucket) apart", async () => {
    const store = new InMemoryObjectStore()
    await store.put({ bucket: "a", key: "k", body: new Uint8Array([1]), contentLength: 1 })
    await store.put({ bucket: "b", key: "k", body: new Uint8Array([2]), contentLength: 1 })
    await store.put({ key: "k", body: new Uint8Array([3]), contentLength: 1 })
    expect([...((await store.get({ bucket: "a", key: "k" }))!.body as Uint8Array)]).toEqual([1])
    expect([...((await store.get({ bucket: "b", key: "k" }))!.body as Uint8Array)]).toEqual([2])
    expect([...((await store.get({ key: "k" }))!.body as Uint8Array)]).toEqual([3])
    expect(await store.head({ bucket: "c", key: "k" })).toBeNull()
    expect(await store.delete({ bucket: "a", key: "k" })).toBe(true)
    expect(await store.head({ bucket: "b", key: "k" })).not.toBeNull()
    expect(await store.head({ key: "k" })).not.toBeNull()
  })

  it("answers versioned get, head and delete only for the current version", async () => {
    const store = new InMemoryObjectStore()
    const v1 = await put(store)
    expect((await store.get({ key: "k", version: "1" }))!.metadata.version).toBe("1")
    expect((await store.head({ key: "k", version: "1" }))!.version).toBe("1")
    expect(await store.get({ key: "k", version: "2" })).toBeNull()
    expect(await store.head({ key: "k", version: "2" })).toBeNull()
    expect(await store.delete({ key: "k", version: "2" })).toBe(false)
    expect(await store.head({ key: "k" })).not.toBeNull()
    const v2 = await put(store)
    expect(v2.version).toBe("2")
    expect(await store.head({ key: "k", version: "1" })).toBeNull()
    expect(await store.delete({ key: "k", version: "2" })).toBe(true)
    expect(await store.head({ key: "k" })).toBeNull()
  })

  it("answers null/false for missing objects and does not mutate stored bytes through a returned body", async () => {
    const store = new InMemoryObjectStore()
    expect(await store.get({ key: "missing" })).toBeNull()
    expect(await store.head({ key: "missing" })).toBeNull()
    expect(await store.delete({ key: "missing" })).toBe(false)
    await put(store)
    const body = (await store.get({ key: "k" }))!.body as Uint8Array
    body[0] = 99
    expect([...((await store.get({ key: "k" }))!.body as Uint8Array)]).toEqual([1, 2, 3])
  })

  it("validates the key and request state on every read", async () => {
    const store = new InMemoryObjectStore()
    await expect(store.get({ key: "" })).rejects.toBeInstanceOf(ValidationError)
    await expect(store.head({ key: "a\0b" })).rejects.toBeInstanceOf(ValidationError)
    await expect(store.delete({ key: "" })).rejects.toBeInstanceOf(ValidationError)
    const controller = new AbortController(); controller.abort()
    await expect(store.get({ key: "k", signal: controller.signal })).rejects.toThrow("Object request was cancelled")
    await expect(store.head({ key: "k", deadline: Date.now() - 1 })).rejects.toBeInstanceOf(TimeoutError)
  })
})

describe("InMemoryObjectStore put", () => {
  it("rejects a wrong checksum with the exact message and stores nothing", async () => {
    const store = new InMemoryObjectStore()
    const error = await put(store, { checksum: { algorithm: "sha256", value: "0".repeat(64) } }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as Error).message).toBe("Object checksum does not match body bytes")
    expect(await store.head({ key: "k" })).toBeNull()
  })

  it("rechecks cancellation after the body was read and stores nothing", async () => {
    const store = new InMemoryObjectStore()
    const controller = new AbortController()
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; if (pulls === 1) c.enqueue(new Uint8Array([1])); else { controller.abort(); c.close() } } })
    await expect(store.put({ key: "k", body, contentLength: 1, signal: controller.signal })).rejects.toThrow("Object request was cancelled")
    expect(await store.head({ key: "k" })).toBeNull()
  })

  it("stores a stream body and reports its byte length", async () => {
    const store = new InMemoryObjectStore()
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([1, 2])); c.enqueue(new Uint8Array([3])); c.close() } })
    const meta = await store.put({ key: "s", body, contentLength: 3 })
    expect(meta.contentLength).toBe(3)
    expect([...((await store.get({ key: "s" }))!.body as Uint8Array)]).toEqual([1, 2, 3])
  })
})
