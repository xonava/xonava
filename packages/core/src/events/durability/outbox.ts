import type { PersistenceProvider } from "../../persistence/provider"
import type { EventEnvelope } from "../eventEnvelope"
import { ConfigurationError, encodeExecutionScopeId, type DurableAuthorityProvenanceV1, type ExecutionScope, type ExecutionScopeId } from "../../domain"
import { createEventEnvelope } from "../eventEnvelope"

export interface NewOutboxRecord {
  id?: string
  type: string
  version: number
  tenantId?: string | null
  scope: ExecutionScope
  scopeId: ExecutionScopeId
  aggregateType: string
  aggregateId: string
  payload: Record<string, unknown>
  idempotencyKey: string
  occurredAt?: Date
  correlationId?: string
  causationId?: string
  producer?: EventEnvelope["producer"]
  /** Authority under which the event was produced; required to publish it as an envelope. */
  provenance?: DurableAuthorityProvenanceV1
}

export interface OutboxRecord extends NewOutboxRecord {
  id: string
  occurredAt: Date
}

export function assertOutboxScope(record: Pick<NewOutboxRecord, "scope" | "scopeId">): void {
  if (encodeExecutionScopeId(record.scope) !== record.scopeId) throw new ConfigurationError("outbox scope identity mismatch")
}

export function createOutboxRecordFromEnvelope(envelope: EventEnvelope, idempotencyKey: string, aggregate: { type: string; id: string }): OutboxRecord {
  return {
    id: envelope.messageId,
    type: envelope.eventType,
    version: envelope.payloadVersion,
    scope: envelope.scope,
    scopeId: envelope.scopeId,
    correlationId: envelope.correlationId,
    ...(envelope.causationId === undefined ? {} : { causationId: envelope.causationId }),
    producer: envelope.producer,
    provenance: envelope.provenance,
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload: envelope.payload,
    idempotencyKey,
    occurredAt: new Date(envelope.occurredAt),
  }
}

/**
 * Rebuilds the publishable envelope from a committed outbox record. Fails
 * closed when the record has no producer or provenance rather than inventing
 * authority for an event.
 */
export function createEnvelopeFromOutboxRecord(record: OutboxRecord): EventEnvelope {
  if (!record.provenance) throw new ConfigurationError("Outbox record has no authority provenance; it cannot be published as an event envelope")
  if (!record.producer) throw new ConfigurationError("Outbox record has no producer identity")
  const correlationId = record.correlationId ?? record.provenance.correlationId
  if (typeof correlationId !== "string" || !correlationId) throw new ConfigurationError("Outbox record has no correlation id")
  return createEventEnvelope({
    messageId: record.id, eventType: record.type, payloadVersion: record.version, occurredAt: record.occurredAt.toISOString(),
    scope: record.scope, correlationId, ...(record.causationId !== undefined ? { causationId: record.causationId } : {}),
    producer: record.producer, provenance: record.provenance, payload: record.payload,
  })
}

export function normalizeOutboxRecord(record: NewOutboxRecord, defaults: { id: string; occurredAt: Date }): OutboxRecord {
  assertOutboxScope(record)
  return {
    ...record,
    id: record.id ?? defaults.id,
    occurredAt: record.occurredAt ?? defaults.occurredAt,
  }
}

export interface OutboxSink {
  append(record: OutboxRecord): Promise<void>
}

export interface OutboxSinkFactory {
  create(persistence: PersistenceProvider): OutboxSink
}
