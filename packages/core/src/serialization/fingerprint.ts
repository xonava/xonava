import { sha256Hex } from "./sha256"
import { canonicalJsonBytes } from "./canonicalJson"
import { FINGERPRINT_DOMAIN_SEPARATORS } from "../spec/versions"
import { FORMAT_DEFAULT_MAX_CANONICAL_BYTES, SERIALIZATION_LIMIT_EXCEEDED_ERROR, CANONICAL_JSON_LIMITS_V1 } from "../spec/formatVersions"
import { CanonicalJsonError } from "./canonicalJson"

export interface FingerprintRecipe {
  readonly fingerprintVersion: number
  readonly canonicalizationVersion: "jcs-rfc8785-v1"
  readonly digestAlgorithmVersion: "sha256-v1"
  readonly domainSeparator: string
}

export function fingerprintWithDomainSeparator(domainSeparator: string, value: unknown): string {
  if (typeof domainSeparator !== "string" || domainSeparator.length === 0) {
    throw new CanonicalJsonError("domainSeparator must be non-empty string")
  }
  const canonicalBytes = canonicalJsonBytes(value)
  // Enforce per-format lower limit for idempotency etc is 1 MiB, but fingerprint input itself must respect absolute ceiling
  // The canonical bytes already checked against maxUtf8Bytes, but also check format specific if needed
  const domainBytes = new TextEncoder().encode(domainSeparator)
  const combined = new Uint8Array(domainBytes.byteLength + canonicalBytes.byteLength)
  combined.set(domainBytes, 0)
  combined.set(canonicalBytes, domainBytes.byteLength)
  const formatLimit = domainSeparator === FINGERPRINT_DOMAIN_SEPARATORS.cursorQuery
    ? FORMAT_DEFAULT_MAX_CANONICAL_BYTES.cursorEnvelopeBeforeEncodingOrSigning
    : FORMAT_DEFAULT_MAX_CANONICAL_BYTES.idempotencyFingerprintInputOwnedByFramework
  if (combined.byteLength > formatLimit) {
    throw new CanonicalJsonError(`fingerprint input bytes ${combined.byteLength} exceeds format limit ${formatLimit}`, { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR })
  }
  if (combined.byteLength > CANONICAL_JSON_LIMITS_V1.maxUtf8Bytes) {
    throw new CanonicalJsonError(`fingerprint input exceeds maxUtf8Bytes`, { code: SERIALIZATION_LIMIT_EXCEEDED_ERROR })
  }
  return sha256Hex(combined)
}

export function fingerprintIdempotency(value: unknown): string {
  return fingerprintWithDomainSeparator(FINGERPRINT_DOMAIN_SEPARATORS.idempotency, value)
}

export function fingerprintOutbox(value: unknown): string {
  return fingerprintWithDomainSeparator(FINGERPRINT_DOMAIN_SEPARATORS.outbox, value)
}

export function fingerprintCursorQuery(value: unknown): string {
  return fingerprintWithDomainSeparator(FINGERPRINT_DOMAIN_SEPARATORS.cursorQuery, value)
}
