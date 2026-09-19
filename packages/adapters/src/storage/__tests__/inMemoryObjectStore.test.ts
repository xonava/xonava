import { describe, expect, it } from "vitest"
import { InMemoryObjectStore } from ".."

describe("O1 ObjectStore reference adapter", () => {
  it("supports put, head, get and delete with immutable byte copies", async () => {
    const store = new InMemoryObjectStore()
    const source = new Uint8Array([1, 2, 3])
    const metadata = await store.put({ bucket: "b", key: "k", body: source, contentLength: 3, contentType: "application/octet-stream", checksum: { algorithm: "sha256", value: "digest" } })
    source[0] = 9
    expect(metadata).toMatchObject({ bucket: "b", key: "k", contentLength: 3 })
    const result = await store.get({ bucket: "b", key: "k" })
    expect([...(result!.body as Uint8Array)]).toEqual([1, 2, 3])
    expect((await store.head({ bucket: "b", key: "k" }))?.checksum?.value).toBe("digest")
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
})
