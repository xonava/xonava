import { describe, expect, it } from "vitest"
import { ValidationError } from "@xonava/core/domain"
import { InMemoryObjectStore } from ".."

const SHA256_OF_010203 = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81"

describe("O1 ObjectStore reference adapter", () => {
  it("supports put, head, get and delete with immutable byte copies", async () => {
    const store = new InMemoryObjectStore()
    const source = new Uint8Array([1, 2, 3])
    const metadata = await store.put({ bucket: "b", key: "k", body: source, contentLength: 3, contentType: "application/octet-stream", checksum: { algorithm: "sha256", value: SHA256_OF_010203 } })
    source[0] = 9
    expect(metadata).toMatchObject({ bucket: "b", key: "k", contentLength: 3 })
    const result = await store.get({ bucket: "b", key: "k" })
    expect([...(result!.body as Uint8Array)]).toEqual([1, 2, 3])
    expect((await store.head({ bucket: "b", key: "k" }))?.checksum?.value).toBe(SHA256_OF_010203)
    expect(await store.delete({ bucket: "b", key: "k" })).toBe(true)
    expect(await store.get({ bucket: "b", key: "k" })).toBeNull()
  })

  it("accepts Web streams and enforces declared length", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([4, 5])); controller.close() } })
    const store = new InMemoryObjectStore()
    await store.put({ key: "stream", body: stream, contentLength: 2 })
    await expect(store.put({ key: "bad", body: new Uint8Array([1]), contentLength: 2 })).rejects.toThrow("does not match")
  })

  it("honors cancellation and deadlines", async () => {
    const store = new InMemoryObjectStore()
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(store.get({ key: "x", signal: controller.signal })).rejects.toThrow("cancelled")
    await expect(store.head({ key: "x", deadline: 0 })).rejects.toThrow("deadline")
  })

  // TM16b: keys are opaque strings. The store never normalizes, resolves or trims them, so a hostile key
  // cannot reach an object stored under another tenant's prefix. Callers derive keys from trusted scope.
  describe("hostile object keys (TM16b)", () => {
    const bytesOf = async (store: InMemoryObjectStore, key: string) => {
      const result = await store.get({ key })
      return result === null ? null : [...(result.body as Uint8Array)]
    }

    it("treats `tenants/a/../b/x` and `tenants/b/x` as different objects", async () => {
      const store = new InMemoryObjectStore()
      await store.put({ key: "tenants/b/x", body: new Uint8Array([2]), contentLength: 1 })
      expect(await bytesOf(store, "tenants/a/../b/x")).toBeNull()
      expect(await store.head({ key: "tenants/a/../b/x" })).toBeNull()
      await store.put({ key: "tenants/a/../b/x", body: new Uint8Array([9]), contentLength: 1 })
      expect(await bytesOf(store, "tenants/b/x")).toEqual([2])
      expect(await bytesOf(store, "tenants/a/../b/x")).toEqual([9])
      expect(await store.delete({ key: "tenants/a/../b/x" })).toBe(true)
      expect(await bytesOf(store, "tenants/b/x")).toEqual([2])
      expect(await store.delete({ key: "tenants/a/../b/x" })).toBe(false)
    })

    it("does not resolve dot segments, repeated slashes or encoded separators", async () => {
      const store = new InMemoryObjectStore()
      await store.put({ key: "tenants/b/x", body: new Uint8Array([2]), contentLength: 1 })
      for (const hostile of ["tenants/./b/x", "tenants//b/x", "tenants/a/%2e%2e/b/x", "tenants\\b\\x", "tenants/b/x/.", "./tenants/b/x", "../tenants/b/x", "tenants/b/x/../x"]) {
        expect(await store.head({ key: hostile }), hostile).toBeNull()
        expect(await store.delete({ key: hostile }), hostile).toBe(false)
      }
      expect(await bytesOf(store, "tenants/b/x")).toEqual([2])
    })

    it("does not let a leading slash collide with the trimmed key", async () => {
      const store = new InMemoryObjectStore()
      await store.put({ key: "tenants/b/x", body: new Uint8Array([2]), contentLength: 1 })
      expect(await store.head({ key: "/tenants/b/x" })).toBeNull()
      await store.put({ key: "/tenants/b/x", body: new Uint8Array([7]), contentLength: 1 })
      expect(await bytesOf(store, "tenants/b/x")).toEqual([2])
      expect(await bytesOf(store, "/tenants/b/x")).toEqual([7])
      expect(await store.delete({ key: "/tenants/b/x" })).toBe(true)
      expect(await bytesOf(store, "tenants/b/x")).toEqual([2])
    })

    it("does not let a trailing or leading space collide with the trimmed key", async () => {
      const store = new InMemoryObjectStore()
      await store.put({ key: "tenants/b/x", body: new Uint8Array([2]), contentLength: 1 })
      for (const spaced of ["tenants/b/x ", " tenants/b/x", "tenants/b/x\t", "tenants/b/x\n"]) {
        expect(await store.head({ key: spaced }), JSON.stringify(spaced)).toBeNull()
        await store.put({ key: spaced, body: new Uint8Array([5]), contentLength: 1 })
        expect(await bytesOf(store, "tenants/b/x"), JSON.stringify(spaced)).toEqual([2])
        expect(await bytesOf(store, spaced), JSON.stringify(spaced)).toEqual([5])
        expect(await store.delete({ key: spaced })).toBe(true)
        expect(await bytesOf(store, "tenants/b/x")).toEqual([2])
      }
    })

    it("rejects a key with a NUL character on every operation and stores nothing", async () => {
      const store = new InMemoryObjectStore()
      await store.put({ key: "tenants/b/x", body: new Uint8Array([2]), contentLength: 1 })
      for (const hostile of ["tenants/b/x\0", "tenants/b/\0/x", "\0tenants/b/x", "tenants/b/x\0.png"]) {
        await expect(store.put({ key: hostile, body: new Uint8Array([6]), contentLength: 1 }), JSON.stringify(hostile)).rejects.toBeInstanceOf(ValidationError)
        await expect(store.get({ key: hostile }), JSON.stringify(hostile)).rejects.toBeInstanceOf(ValidationError)
        await expect(store.head({ key: hostile }), JSON.stringify(hostile)).rejects.toBeInstanceOf(ValidationError)
        await expect(store.delete({ key: hostile }), JSON.stringify(hostile)).rejects.toBeInstanceOf(ValidationError)
      }
      // The truncated form was neither written nor deleted.
      expect(await bytesOf(store, "tenants/b/x")).toEqual([2])
    })

    it("rejects an empty key and a key over 1024 characters", async () => {
      const store = new InMemoryObjectStore()
      await expect(store.put({ key: "", body: new Uint8Array([1]), contentLength: 1 })).rejects.toBeInstanceOf(ValidationError)
      await expect(store.head({ key: "k".repeat(1025) })).rejects.toBeInstanceOf(ValidationError)
    })
  })
})
