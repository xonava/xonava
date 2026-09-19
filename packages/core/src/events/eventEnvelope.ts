import type { DurableAuthorityProvenanceV1, ExecutionScope, ExecutionScopeId } from "../domain"
import { assertDurableAuthorityProvenance, encodeExecutionScopeId, validateExecutionScope } from "../domain"
import { ConfigurationError } from "../domain/errors"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"

export interface EventProducerIdentity {
  readonly service: string
  readonly instance?: string
}

export interface EventEnvelope<TPayload = Record<string, unknown>> {
  readonly format: "framework.event"
  readonly formatVersion: 1
  readonly messageId: string
  readonly eventType: string
  readonly payloadVersion: number
  readonly occurredAt: string
  readonly scope: ExecutionScope
  readonly scopeId: ExecutionScopeId
  readonly correlationId: string
  readonly causationId?: string
  readonly producer: EventProducerIdentity
  readonly provenance: DurableAuthorityProvenanceV1
  readonly payload: TPayload
}

const required = (value: string, field: string): void => {
  if (value.trim().length === 0) throw new ConfigurationError(`${field} must be non-empty`)
}

function assertCanonicalTimestamp(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new ConfigurationError(`${field} must be an RFC 3339 UTC millisecond timestamp`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ConfigurationError(`${field} must be a valid RFC 3339 UTC millisecond timestamp`)
  }
}

export function createEventEnvelope<TPayload>(input: Omit<EventEnvelope<TPayload>, "format" | "formatVersion" | "scopeId">): EventEnvelope<TPayload> {
  required(input.messageId, "messageId")
  required(input.eventType, "eventType")
  required(input.correlationId, "correlationId")
  required(input.producer.service, "producer.service")
  if (!Number.isSafeInteger(input.payloadVersion) || input.payloadVersion < 1) throw new ConfigurationError("payloadVersion must be a positive integer")
  assertCanonicalTimestamp(input.occurredAt, "occurredAt")
  const scope = validateExecutionScope(input.scope)
  const scopeId = encodeExecutionScopeId(scope)
  assertDurableAuthorityProvenance(input.provenance)
  const provenanceScopeId = input.provenance.target?.scopeId
  if (!input.provenance.target || provenanceScopeId !== scopeId || encodeExecutionScopeId(input.provenance.target.scope) !== scopeId) {
    throw new ConfigurationError("event provenance target scope does not match envelope scope")
  }
  if (input.provenance.correlationId !== input.correlationId) {
    throw new ConfigurationError("event provenance correlationId does not match envelope correlationId")
  }
  if (input.provenance.causationId !== input.causationId) {
    throw new ConfigurationError("event provenance causationId does not match envelope causationId")
  }
  return Object.freeze({
    ...cloneAndFreezeDefinition({ ...input, payload: input.payload, provenance: input.provenance }, true),
    format: "framework.event", formatVersion: 1, scope: Object.freeze({ ...scope }), scopeId,
    producer: Object.freeze({ ...input.producer }),
  }) as EventEnvelope<TPayload>
}
