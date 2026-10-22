import { describe, expect, it } from "vitest"
import { UnavailableError, ValidationError } from "@xonava/core/domain"
import { R2ObjectStore } from ".."

type Bucket = ConstructorParameters<typeof R2ObjectStore>[0]
const object = (version: string, body = new Uint8Array([1])) => ({
  key: "k", version, size: body.byteLength, etag: `etag-${version}`, uploaded: new Date(0),
  httpMetadata: { contentType: "text/plain" }, customMetadata: {} as Record<string, string>,
  checksums: { toJSON: () => ({}) }, body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); c.close() } }),
})

describe("R2ObjectStore", () => {
  it("maps a provider checksum rejection to ValidationError and other failures to UnavailableError", async () => {
    const mismatch = { put: () => Promise.reject(new Error("put: The SHA-256 checksum you specified did not match what we received.")) } as unknown as Bucket
    await expect(new R2ObjectStore(mismatch).put({ key: "k", body: new Uint8Array([1]), contentLength: 1, checksum: { algorithm: "sha256", value: "0".repeat(64) } })).rejects.toBeInstanceOf(ValidationError)
    const broken = { put: () => Promise.reject(new Error("internal 10001")) } as unknown as Bucket
    const error = await new R2ObjectStore(broken).put({ key: "k", body: new Uint8Array([1]), contentLength: 1 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnavailableError)
    expect((error as Error).message).not.toContain("10001")
    expect((error as Error).cause).toBeInstanceOf(Error)
  })

  it("cancels the body of a get whose version is not current", async () => {
    let cancelled = false
    const stale = { ...object("2"), body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }) }
    const store = new R2ObjectStore({ get: () => Promise.resolve(stale) } as unknown as Bucket)
    expect(await store.get({ key: "k", version: "1" })).toBeNull()
    expect(cancelled).toBe(true)
  })

  it("does not delete when the requested version is stale", async () => {
    let deletes = 0
    const store = new R2ObjectStore({ head: () => Promise.resolve(object("2")), delete: () => { deletes += 1; return Promise.resolve() } } as unknown as Bucket)
    expect(await store.delete({ key: "k", version: "1" })).toBe(false)
    expect(await store.delete({ key: "k", version: "2" })).toBe(true)
    expect(deletes).toBe(1)
  })

  it("rejects keys over 1024 UTF-8 bytes and unsupported checksum algorithms", async () => {
    const store = new R2ObjectStore({} as unknown as Bucket)
    await expect(store.head({ key: "é".repeat(600) })).rejects.toBeInstanceOf(ValidationError)
    await expect(store.put({ key: "k", body: new Uint8Array([1]), contentLength: 1, checksum: { algorithm: "md5", value: "00" } })).rejects.toBeInstanceOf(ValidationError)
  })

  // TM16b: the key reaches the provider exactly as the caller gave it, byte for byte: R2 treats it as an
  // opaque string too, so the adapter must neither normalize it nor let a hostile one through unchecked.
  describe("hostile object keys (TM16b)", () => {
    /** An in-memory bucket keyed by the exact string it receives, recording every call. */
    function recordingBucket() {
      const calls: Array<{ method: string; key: string }> = []
      const stored = new Map<string, Uint8Array>()
      const describeObject = (key: string) => ({
        key, version: "v1", size: stored.get(key)!.byteLength, etag: "e", uploaded: new Date(0),
        httpMetadata: {}, customMetadata: {} as Record<string, string>, checksums: { toJSON: () => ({}) },
      })
      const bucket = {
        put: (key: string, value: ArrayBufferView) => { calls.push({ method: "put", key }); stored.set(key, new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()); return Promise.resolve(describeObject(key)) },
        get: (key: string) => { calls.push({ method: "get", key }); return Promise.resolve(stored.has(key) ? { ...describeObject(key), body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(stored.get(key)!); c.close() } }) } : null) },
        head: (key: string) => { calls.push({ method: "head", key }); return Promise.resolve(stored.has(key) ? describeObject(key) : null) },
        delete: (key: string) => { calls.push({ method: "delete", key }); stored.delete(key); return Promise.resolve() },
      }
      return { bucket: bucket as unknown as Bucket, calls, stored }
    }
    const bytes = (n: number) => new Uint8Array([n])
    const read = async (store: R2ObjectStore, key: string) => {
      const result = await store.get({ key })
      if (result === null) return null
      return [...new Uint8Array(await new Response(result.body as ReadableStream<Uint8Array>).arrayBuffer())]
    }

    it("treats `tenants/a/../b/x` and `tenants/b/x` as different objects and passes each key through verbatim", async () => {
      const { bucket, calls, stored } = recordingBucket()
      const store = new R2ObjectStore(bucket)
      await store.put({ key: "tenants/b/x", body: bytes(2), contentLength: 1 })
      expect(await store.head({ key: "tenants/a/../b/x" })).toBeNull()
      await store.put({ key: "tenants/a/../b/x", body: bytes(9), contentLength: 1 })
      expect(await read(store, "tenants/b/x")).toEqual([2])
      expect(await read(store, "tenants/a/../b/x")).toEqual([9])
      expect(await store.delete({ key: "tenants/a/../b/x" })).toBe(true)
      expect([...stored.keys()]).toEqual(["tenants/b/x"])
      expect(calls.map((call) => call.key).every((key) => key === "tenants/b/x" || key === "tenants/a/../b/x")).toBe(true)
    })

    it("does not let a leading slash or a trailing space collide with the trimmed key", async () => {
      const { bucket, stored } = recordingBucket()
      const store = new R2ObjectStore(bucket)
      await store.put({ key: "tenants/b/x", body: bytes(2), contentLength: 1 })
      for (const variant of ["/tenants/b/x", "tenants/b/x ", " tenants/b/x"]) {
        expect(await store.head({ key: variant }), JSON.stringify(variant)).toBeNull()
        await store.put({ key: variant, body: bytes(7), contentLength: 1 })
        expect(await read(store, "tenants/b/x"), JSON.stringify(variant)).toEqual([2])
        expect(await read(store, variant), JSON.stringify(variant)).toEqual([7])
        expect(await store.delete({ key: variant })).toBe(true)
        expect(await read(store, "tenants/b/x")).toEqual([2])
      }
      expect([...stored.keys()]).toEqual(["tenants/b/x"])
    })

    it("rejects a key with a NUL character with a ValidationError before any provider call", async () => {
      const { bucket, calls, stored } = recordingBucket()
      const store = new R2ObjectStore(bucket)
      await store.put({ key: "tenants/b/x", body: bytes(2), contentLength: 1 })
      calls.length = 0
      for (const hostile of ["tenants/b/x\0", "tenants/b/\0/x", "\0tenants/b/x"]) {
        await expect(store.put({ key: hostile, body: bytes(6), contentLength: 1 }), JSON.stringify(hostile)).rejects.toBeInstanceOf(ValidationError)
        await expect(store.get({ key: hostile }), JSON.stringify(hostile)).rejects.toBeInstanceOf(ValidationError)
        await expect(store.head({ key: hostile }), JSON.stringify(hostile)).rejects.toBeInstanceOf(ValidationError)
        await expect(store.delete({ key: hostile }), JSON.stringify(hostile)).rejects.toBeInstanceOf(ValidationError)
      }
      expect(calls).toEqual([])
      expect([...stored.keys()]).toEqual(["tenants/b/x"])
    })

    it("rejects an empty key before any provider call", async () => {
      const { bucket, calls } = recordingBucket()
      const store = new R2ObjectStore(bucket)
      await expect(store.head({ key: "" })).rejects.toBeInstanceOf(ValidationError)
      expect(calls).toEqual([])
    })
  })
})
