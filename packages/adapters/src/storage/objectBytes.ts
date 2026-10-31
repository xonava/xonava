import { assertObjectRequestActive, type ObjectBytes, type ObjectChecksum, type ObjectRequestOptions } from "@xonava/core/object-store"
import { ValidationError } from "@xonava/core/domain"

const SHA256_HEX = /^[0-9a-f]{64}$/i

/**
 * Reads a declared-length body into memory. Streams are checked for cancellation and the deadline
 * between chunks, stop at the first byte past `contentLength`, and are cancelled on any failure so
 * the producer is released.
 */
export async function readObjectBytes(body: ObjectBytes, contentLength: number, options: ObjectRequestOptions): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.slice()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let completed = false
  try {
    for (;;) {
      assertObjectRequestActive(options)
      const item = await reader.read()
      if (item.done) break
      length += item.value.byteLength
      if (length > contentLength) throw new ValidationError("Object contentLength does not match body bytes")
      chunks.push(item.value)
    }
    completed = true
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  if (length !== contentLength) throw new ValidationError("Object contentLength does not match body bytes")
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

/** Returns the lowercase hex SHA-256 a checksum declares, or undefined when none is declared. Unsupported algorithms and malformed digests are validation failures. */
export function declaredSha256(checksum: ObjectChecksum | undefined): string | undefined {
  if (checksum === undefined) return undefined
  if (checksum.algorithm.toLowerCase() !== "sha256") throw new ValidationError("Object checksum algorithm is not supported; use sha256")
  if (!SHA256_HEX.test(checksum.value)) throw new ValidationError("Object sha256 checksum must be 64 hexadecimal characters")
  return checksum.value.toLowerCase()
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
}
