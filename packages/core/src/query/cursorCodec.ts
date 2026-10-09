import { ValidationError } from "../domain/errors.js"
import { canonicalJsonString, decodeBase64UrlUnpadded, decodeCanonicalJson, encodeBase64UrlUnpadded } from "../serialization/canonicalJson.js"
import type { CursorPayloadV1, CursorValue } from "./cursor.js"
export interface CursorIntegrityPort { sign(payload: Uint8Array): Promise<Uint8Array>; verify(payload: Uint8Array, signature: Uint8Array): Promise<boolean> }
function validate(value: unknown): CursorPayloadV1 {
  if (!value || typeof value !== "object") throw new ValidationError("malformed cursor payload")
  const p = value as Partial<CursorPayloadV1>; const values = p.values
  if (p.expiresAt !== undefined && (!Number.isSafeInteger(p.expiresAt) || p.expiresAt < 0)) throw new ValidationError("malformed cursor payload")
  if (p.format !== "framework.cursor" || p.version !== 1 || (p.direction !== "after" && p.direction !== "before") || !Array.isArray(values) || values.some(v => !(["string", "number", "boolean"].includes(typeof v) || v === null)) || [p.routeHash, p.queryHash, p.scopeHash, p.sortHash].some(v => typeof v !== "string" || !v)) throw new ValidationError("malformed cursor payload")
  return p as CursorPayloadV1
}
export async function encodeCursor(payload: CursorPayloadV1, integrity: CursorIntegrityPort, maxBytes = 8192): Promise<string> {
  assertByteLimit(maxBytes); validate(payload)
  const bytes = new TextEncoder().encode(canonicalJsonString(payload)); if (bytes.byteLength > maxBytes) throw new ValidationError("cursor payload exceeds byte limit")
  return `v1.${encodeBase64UrlUnpadded(bytes)}.${encodeBase64UrlUnpadded(await integrity.sign(bytes))}`
}
export interface DecodeCursorOptions {
  /** Current time (Unix ms) used to enforce `expiresAt`; defaults to Date.now(). */
  readonly now?: number
}

export async function decodeCursor(cursor: string, integrity: CursorIntegrityPort, maxBytes = 8192, options: DecodeCursorOptions = {}): Promise<CursorPayloadV1> {
  assertByteLimit(maxBytes)
  if (typeof cursor !== "string") throw new ValidationError("cursor must be a string")
  if (new TextEncoder().encode(cursor).byteLength > maxBytes * 2) throw new ValidationError("cursor exceeds byte limit")
  const parts = cursor.split("."); const [prefix, encoded, signed] = parts; if (parts.length !== 3 || prefix !== "v1" || !encoded || !signed) throw new ValidationError("malformed cursor")
  let bytes: Uint8Array; let signature: Uint8Array
  try { bytes = decodeBase64UrlUnpadded(encoded); signature = decodeBase64UrlUnpadded(signed) } catch { throw new ValidationError("malformed cursor encoding") }
  if (bytes.byteLength > maxBytes || (await integrity.verify(bytes, signature)) !== true) throw new ValidationError("cursor integrity verification failed")
  let parsed: unknown; try { parsed = decodeCanonicalJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new ValidationError("malformed or non-canonical cursor payload") }
  const payload = validate(parsed); if (canonicalJsonString(payload) !== new TextDecoder().decode(bytes)) throw new ValidationError("non-canonical cursor payload")
  if (payload.expiresAt !== undefined && (options.now ?? Date.now()) >= payload.expiresAt) throw new ValidationError("cursor expired")
  return Object.freeze({ ...payload, values: Object.freeze([...(payload.values)]) })
}

function assertByteLimit(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new ValidationError("cursor byte limit must be a positive safe integer") }

/**
 * Key rotation without a cursor format change: sign with the current key and
 * accept signatures from the current or any listed previous key. Retire a
 * previous key once every cursor it signed has expired.
 */
export function createRotatingCursorIntegrity(current: CursorIntegrityPort, previous: readonly CursorIntegrityPort[] = []): CursorIntegrityPort {
  if (previous.length > 8) throw new ValidationError("too many previous cursor keys")
  const verifiers = [current, ...previous]
  return {
    sign: (payload) => current.sign(payload),
    async verify(payload, signature) {
      for (const verifier of verifiers) if ((await verifier.verify(payload, signature)) === true) return true
      return false
    },
  }
}
