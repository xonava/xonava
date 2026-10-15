import { isEntityVersion, type EntityVersion } from "@xonava/core/serialization"
import type { IdempotencyAcquireResult, IdempotencyRequest } from "@xonava/core/events"

export function serializeInvalidations(invalidations: readonly string[] | undefined): string | null {
  if (!invalidations || invalidations.length === 0) return null
  return JSON.stringify([...new Set(invalidations)])
}

export function parseInvalidations(raw: unknown): string[] {
  if (raw === null || raw === undefined) return []
  if (typeof raw !== "string") throw new Error(`Corrupted idempotency invalidation data: expected string, got ${typeof raw}`)
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error("Corrupted idempotency invalidation data: expected array")
    if (!parsed.every((entry): entry is string => typeof entry === "string")) {
      throw new Error("Corrupted idempotency invalidation data: expected string entries")
    }
    return [...new Set(parsed)]
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Corrupted idempotency invalidation data: malformed JSON")
    throw error
  }
}

export function encodeResourceVersion(version: EntityVersion): string {
  return JSON.stringify({ type: "number", value: version })
}

export function decodeResourceVersion(raw: string | undefined | null): EntityVersion | undefined {
  if (raw === undefined || raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null && "type" in parsed && "value" in parsed) {
      const record = parsed as { type?: unknown; value?: unknown }
      if (record.type === "number" && isEntityVersion(record.value)) return record.value
    }
  } catch {
    // Normalize malformed persisted data to the corruption error below.
  }
  throw new Error("Corrupted idempotency resource version: expected numeric envelope")
}

export function resolveExistingIdempotency<TResult>(
  request: IdempotencyRequest,
  row: Record<string, unknown>,
): IdempotencyAcquireResult<TResult> | undefined {
  if (row.fingerprint !== request.fingerprint) return { outcome: "conflict" }
  if (row.status === "completed" && typeof row.result === "string") {
    return { outcome: "replay", result: JSON.parse(row.result) as TResult }
  }
  if (row.status === "business-committed") {
    const resourceEntity = row.resourceEntity as string | undefined
    const resourceId = row.resourceId as string | undefined
    const resourceVersion = decodeResourceVersion(row.resourceVersion as string | undefined)
    return {
      outcome: "business-committed",
      token: row.token as string,
      ...(resourceEntity && resourceId ? { resource: { entity: resourceEntity, id: resourceId, ...(resourceVersion !== undefined ? { version: resourceVersion } : {}) } } : {}),
      invalidations: parseInvalidations(row.pendingInvalidations),
    }
  }
  return undefined
}
