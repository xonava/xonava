import { ConfigurationError } from "../domain"
import { validateBackoffPolicy, type BackoffPolicy } from "../resilience/backoff"

export interface ConsumerDefinition {
  readonly key: string
  readonly definitionVersion: number
  readonly eventType: string
  readonly acceptedPayloadVersions: readonly number[]
  readonly authority: "event-provenance" | "service-authority"
  readonly retry: { readonly maxAttempts: number; readonly delayMs: (attempt: number) => number }
  /**
   * Serializable backoff policy (preferred, portable). When present it
   * governs both the attempt limit and the retry delay, overriding `retry`.
   */
  readonly backoff?: BackoffPolicy
  readonly transaction: { readonly mode: "required" | "at-least-once-idempotent" }
}

export function defineConsumer(definition: ConsumerDefinition): ConsumerDefinition {
  if (!definition.key.trim() || !definition.eventType.trim()) throw new ConfigurationError("Consumer key and eventType must be non-empty")
  if (!Number.isSafeInteger(definition.definitionVersion) || definition.definitionVersion < 1) throw new ConfigurationError("Consumer definitionVersion must be positive")
  if (!Number.isSafeInteger(definition.retry.maxAttempts) || definition.retry.maxAttempts < 1) throw new ConfigurationError("Consumer maxAttempts must be positive")
  if (definition.acceptedPayloadVersions.length === 0 || definition.acceptedPayloadVersions.some(v => !Number.isSafeInteger(v) || v < 1)) throw new ConfigurationError("Consumer accepted versions are invalid")
  if (definition.transaction.mode === "at-least-once-idempotent" && definition.retry.maxAttempts < 2) throw new ConfigurationError("At-least-once consumers must permit redelivery")
  const backoff = definition.backoff === undefined ? undefined : validateBackoffPolicy(definition.backoff, `Consumer ${definition.key} backoff`)
  if (definition.transaction.mode === "at-least-once-idempotent" && backoff !== undefined && backoff.maxAttempts < 2) throw new ConfigurationError("At-least-once consumers must permit redelivery")
  return Object.freeze({ ...definition, ...(backoff !== undefined ? { backoff } : {}), acceptedPayloadVersions: Object.freeze([...new Set(definition.acceptedPayloadVersions)]), retry: Object.freeze({ ...definition.retry }), transaction: Object.freeze({ ...definition.transaction }) })
}

