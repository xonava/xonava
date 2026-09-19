import type { PersistenceProvider } from "../../persistence/provider"
import type { EventEnvelope } from "../eventEnvelope"
import { ConfigurationError, encodeExecutionScopeId, type ExecutionScope, type ExecutionScopeId } from "../../domain"

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
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload: envelope.payload,
    idempotencyKey,
    occurredAt: new Date(envelope.occurredAt),
  }
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
