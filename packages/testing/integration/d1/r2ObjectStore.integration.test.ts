import { Miniflare } from "miniflare"
import type { ObjectStore } from "@xonava/core/object-store"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { R2ObjectStore } from "@xonava/adapters/storage"
import { runObjectStoreContractTests } from "../../src/contracts/object-store"

const WORKER_SCRIPT = "export default { fetch() { return new Response('framework-r2-fixture') } }"
type Bucket = ConstructorParameters<typeof R2ObjectStore>[0]

let mf: Miniflare
let bucket: Bucket

beforeAll(async () => {
  mf = new Miniflare({ modules: true, script: WORKER_SCRIPT, compatibilityDate: "2025-09-01", r2Buckets: ["BUCKET"] })
  bucket = (await mf.getR2Bucket("BUCKET")) as unknown as Bucket
})
afterAll(async () => { await mf.dispose() })

const PROVIDER_TEXT = "r2-internal-secret-detail"
const failingBucket = (): Bucket => {
  const fail = () => Promise.reject(new Error(PROVIDER_TEXT))
  return { put: fail, get: fail, head: fail, delete: fail } as unknown as Bucket
}

runObjectStoreContractTests("Cloudflare R2 (Miniflare)", {
  createStore: () => new R2ObjectStore(bucket),
  createFailingStore: () => new R2ObjectStore(failingBucket()),
  providerFailureText: PROVIDER_TEXT,
})

describe("R2ObjectStore specifics", () => {
  it("does not offer signed URLs", () => {
    const store: ObjectStore = new R2ObjectStore(bucket)
    expect(store.signUpload).toBeUndefined()
    expect(store.signDownload).toBeUndefined()
  })

  it("stores bytes under the key with R2 http and custom metadata", async () => {
    const store = new R2ObjectStore(bucket, { bucket: "uploads" })
    const key = `r2-specific/${crypto.randomUUID()}`
    const put = await store.put({ bucket: "uploads", key, body: new Uint8Array([1, 2, 3]), contentLength: 3, contentType: "image/png", metadata: { a: "b" } })
    expect(put.bucket).toBe("uploads")
    const raw = await bucket.head(key)
    expect(raw?.httpMetadata?.contentType).toBe("image/png")
    expect(raw?.customMetadata).toEqual({ a: "b" })
    expect(put.etag).toBe(raw?.etag)
    expect(put.version).toBe(raw?.version)
    await expect(store.head({ bucket: "other", key })).rejects.toThrow("bucket")
  })
})
