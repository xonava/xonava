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
})
