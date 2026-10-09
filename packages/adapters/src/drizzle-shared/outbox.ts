import { assertOutboxScope, type OutboxRecord } from "core/events"
import { canonicalJsonString, legacyJavaScriptOrderJsonString } from "core/serialization"
import { ConfigurationError, ConflictError } from "core/domain"

/**
 * v3: canonical JSON in RFC 8785 key order. v2 serialized integer-like object
 * keys in JavaScript property order; stored v2 fingerprints are still accepted
 * by {@link assertOutboxFingerprintMatches} (never written).
 */
export const OUTBOX_FINGERPRINT_VERSION = "v3"
const LEGACY_OUTBOX_FINGERPRINT_VERSION = "v2"
export const OUTBOX_FINGERPRINT_MISSING_ERROR = "Stored outbox fingerprint is missing; migrate fingerprints before replaying events."

export function assertOutboxProtectedFields(
  mapped: Record<string, unknown>,
  protectedFields: Record<string, unknown>,
): void {
  for (const [field, expected] of Object.entries(protectedFields)) {
    const mappedValue = mapped[field]
    if (mappedValue !== undefined && mappedValue !== expected) {
      throw new ConfigurationError(`Outbox mapper cannot override the framework-owned ${field}`)
    }
  }
}

type FingerprintedOutboxFields = Pick<OutboxRecord, "type" | "version" | "scope" | "scopeId" | "aggregateType" | "aggregateId" | "payload">

function outboxFingerprintMaterial(record: FingerprintedOutboxFields): Record<string, unknown> {
  assertOutboxScope(record)
  return {
    type: record.type,
    version: record.version,
    scopeId: record.scopeId,
    aggregateType: record.aggregateType,
    aggregateId: record.aggregateId,
    payload: record.payload,
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function fingerprintOutboxRecord(record: FingerprintedOutboxFields): Promise<string> {
  return `${OUTBOX_FINGERPRINT_VERSION}:${await sha256Hex(canonicalJsonString(outboxFingerprintMaterial(record)))}`
}

/**
 * Throws unless the stored fingerprint identifies `record`: the current
 * version, or a v2 fingerprint written before the RFC 8785 key-order fix (so
 * re-appending the same event across that deploy stays an idempotent no-op).
 */
export async function assertOutboxFingerprintMatches(stored: unknown, expected: string, record: FingerprintedOutboxFields): Promise<void> {
  if (typeof stored !== "string" || stored.length === 0) throw new Error(OUTBOX_FINGERPRINT_MISSING_ERROR)
  if (stored === expected) return
  if (stored.startsWith(`${LEGACY_OUTBOX_FINGERPRINT_VERSION}:`)
    && stored === `${LEGACY_OUTBOX_FINGERPRINT_VERSION}:${await sha256Hex(legacyJavaScriptOrderJsonString(outboxFingerprintMaterial(record)))}`) return
  throw new ConflictError("Outbox idempotency key was reused for a different event")
}

/**
 * Framework-owned provenance column: when the outbox table declares a
 * `provenance` column, the record's authority provenance is always written
 * (mappers cannot replace it), so the envelope can be rebuilt for publishing.
 */
export function outboxProvenanceColumn(columns: object, record: { provenance?: unknown }): Record<string, unknown> {
  const column = (columns as Record<string, { dataType?: unknown } | undefined>).provenance
  if (!column) return {}
  if (record.provenance === undefined || record.provenance === null) return { provenance: null }
  return { provenance: column.dataType === "json" ? record.provenance : JSON.stringify(record.provenance) }
}
