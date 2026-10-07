import { sha256Bytes } from "./sha256"

const BLOCK_SIZE = 64

/** HMAC-SHA256 (RFC 2104 / RFC 4231), synchronous and dependency-free. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || !(message instanceof Uint8Array)) throw new TypeError("hmacSha256 expects Uint8Array key and message")
  const normalizedKey = key.length > BLOCK_SIZE ? sha256Bytes(key) : key
  const inner = new Uint8Array(BLOCK_SIZE + message.length)
  const outer = new Uint8Array(BLOCK_SIZE + 32)
  for (let index = 0; index < BLOCK_SIZE; index++) {
    const byte = normalizedKey[index] ?? 0
    inner[index] = byte ^ 0x36
    outer[index] = byte ^ 0x5c
  }
  inner.set(message, BLOCK_SIZE)
  outer.set(sha256Bytes(inner), BLOCK_SIZE)
  return sha256Bytes(outer)
}

export function hmacSha256Hex(key: Uint8Array, message: Uint8Array): string {
  let hex = ""
  for (const byte of hmacSha256(key, message)) hex += byte.toString(16).padStart(2, "0")
  return hex
}
