import { assertOutboxScope, type OutboxRecord } from "core/events"
import { canonicalJsonString } from "core/serialization"
import { ConfigurationError, ConflictError } from "core/domain"

export const OUTBOX_FINGERPRINT_VERSION = "v2"
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

export async function fingerprintOutboxRecord(record: Pick<OutboxRecord, "type" | "version" | "scope" | "scopeId" | "aggregateType" | "aggregateId" | "payload">): Promise<string> {
  assertOutboxScope(record)
  const canonical = canonicalJsonString({
    type: record.type,
    version: record.version,
    scopeId: record.scopeId,
    aggregateType: record.aggregateType,
    aggregateId: record.aggregateId,
    payload: record.payload,
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${OUTBOX_FINGERPRINT_VERSION}:${hex}`
}

export function assertOutboxFingerprintMatches(stored: unknown, expected: string): void {
  if (typeof stored !== "string" || stored.length === 0) throw new Error(OUTBOX_FINGERPRINT_MISSING_ERROR)
  if (stored !== expected) throw new ConflictError("Outbox idempotency key was reused for a different event")
}
