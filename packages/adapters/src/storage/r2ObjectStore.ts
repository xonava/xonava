import { assertObjectRequestActive, validateObjectKey, validatePutObjectInput, type ObjectMetadata, type ObjectReadResult, type ObjectReference, type ObjectRequestOptions, type ObjectStore, type PutObjectInput } from "@xonava/core/object-store"
import { FrameworkCoreError, UnavailableError, ValidationError } from "@xonava/core/domain"
import { declaredSha256, readObjectBytes } from "./objectBytes"

interface R2HttpMetadata { contentType?: string }
interface R2Object {
  readonly key: string
  readonly version: string
  readonly size: number
  readonly etag: string
  readonly uploaded: Date
  readonly httpMetadata?: R2HttpMetadata
  readonly customMetadata?: Record<string, string>
  readonly checksums: { toJSON(): { sha256?: string } }
}
interface R2ObjectBody extends R2Object { readonly body: ReadableStream<Uint8Array> }
declare class R2Bucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView, options?: { httpMetadata?: R2HttpMetadata; customMetadata?: Record<string, string>; sha256?: string }): Promise<R2Object>
  get(key: string): Promise<R2ObjectBody | null>
  head(key: string): Promise<R2Object | null>
  delete(key: string): Promise<void>
}

export interface R2ObjectStoreOptions {
  /** Name this binding serves. References that name a bucket must name this one; returned metadata carries it. */
  readonly bucket?: string
}

const MAX_KEY_BYTES = 1024
const encoder = new TextEncoder()
const CHECKSUM_MISMATCH = /checksum.*did not match/is

/**
 * `ObjectStore` over a Cloudflare R2 bucket binding. The binding cannot sign URLs, so `signUpload` and
 * `signDownload` are omitted; use presigned URLs from the S3-compatible API outside this adapter if needed.
 *
 * - `put` buffers the declared-length body (R2 needs a known length for streams), verifies and passes a
 *   `sha256` checksum to R2, and maps a provider checksum mismatch to `ValidationError`.
 * - `get` returns R2's stream. `get` and `head` answer `null` when a requested `version` is not current.
 * - R2's `delete` reports nothing, so `delete` answers from a preceding `head`. A concurrent writer between
 *   the two calls can make the boolean stale, and a versioned delete is likewise check-then-delete.
 * - Provider failures surface as `UnavailableError` whose message carries no provider text; the provider error is its `cause`.
 */
export class R2ObjectStore implements ObjectStore {
  constructor(private readonly bucket: R2Bucket, private readonly options: R2ObjectStoreOptions = {}) {}

  async put(input: PutObjectInput): Promise<ObjectMetadata> {
    validatePutObjectInput(input)
    this.checkReference(input)
    const sha256 = declaredSha256(input.checksum)
    const bytes = await readObjectBytes(input.body, input.contentLength, input)
    assertObjectRequestActive(input)
    const stored = await this.provider(() => this.bucket.put(input.key, bytes, {
      ...(input.contentType === undefined ? {} : { httpMetadata: { contentType: input.contentType } }),
      ...(input.metadata === undefined ? {} : { customMetadata: { ...input.metadata } }),
      ...(sha256 === undefined ? {} : { sha256 }),
    }), true)
    return this.metadata(stored, input)
  }

  async get(reference: ObjectReference & ObjectRequestOptions): Promise<ObjectReadResult | null> {
    this.checkReference(reference)
    assertObjectRequestActive(reference)
    const object = await this.provider(() => this.bucket.get(reference.key))
    if (object === null) return null
    if (reference.version !== undefined && reference.version !== object.version) {
      await object.body.cancel().catch(() => undefined)
      return null
    }
    return { body: object.body, metadata: this.metadata(object, reference) }
  }

  async head(reference: ObjectReference & ObjectRequestOptions): Promise<ObjectMetadata | null> {
    this.checkReference(reference)
    assertObjectRequestActive(reference)
    const object = await this.provider(() => this.bucket.head(reference.key))
    if (object === null || (reference.version !== undefined && reference.version !== object.version)) return null
    return this.metadata(object, reference)
  }

  async delete(reference: ObjectReference & ObjectRequestOptions): Promise<boolean> {
    this.checkReference(reference)
    assertObjectRequestActive(reference)
    const existing = await this.provider(() => this.bucket.head(reference.key))
    if (existing === null || (reference.version !== undefined && reference.version !== existing.version)) return false
    assertObjectRequestActive(reference)
    await this.provider(() => this.bucket.delete(reference.key))
    return true
  }

  private checkReference(reference: ObjectReference): void {
    validateObjectKey(reference.key)
    if (encoder.encode(reference.key).byteLength > MAX_KEY_BYTES) throw new ValidationError("Object key must be at most 1024 bytes in UTF-8 for R2")
    if (reference.bucket !== undefined && reference.bucket !== this.options.bucket) throw new ValidationError("Object bucket is not served by this store")
  }

  private metadata(object: R2Object, reference: ObjectReference): ObjectMetadata {
    const sha256 = object.checksums.toJSON().sha256
    return Object.freeze({
      ...(this.options.bucket === undefined ? {} : { bucket: this.options.bucket }),
      key: reference.key,
      version: object.version,
      contentLength: object.size,
      ...(object.httpMetadata?.contentType === undefined ? {} : { contentType: object.httpMetadata.contentType }),
      ...(sha256 === undefined ? {} : { checksum: Object.freeze({ algorithm: "sha256", value: sha256.toLowerCase() }) }),
      ...(object.customMetadata === undefined || Object.keys(object.customMetadata).length === 0 ? {} : { metadata: Object.freeze({ ...object.customMetadata }) }),
      etag: object.etag,
      lastModified: new Date(object.uploaded),
    })
  }

  private async provider<T>(call: () => Promise<T>, mapChecksumMismatch = false): Promise<T> {
    try {
      return await call()
    } catch (error) {
      if (error instanceof FrameworkCoreError) throw error
      if (mapChecksumMismatch && error instanceof Error && CHECKSUM_MISMATCH.test(error.message)) throw new ValidationError("Object checksum does not match body bytes")
      throw new UnavailableError("Object store is unavailable", error)
    }
  }
}
