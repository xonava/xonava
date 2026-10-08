import { CANONICALIZATION_VERSION, DIGEST_ALGORITHM_VERSION } from "./versions"

export const CANONICAL_JSON_LIMITS_V1 = Object.freeze({
  maxUtf8Bytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxTotalNodes: 250_000,
  maxObjectMembers: 100_000,
  maxArrayItems: 100_000,
  maxStringUtf8Bytes: 8 * 1024 * 1024,
  maxPropertyNameUtf8Bytes: 1_024,
} as const)

export type CanonicalJsonLimits = typeof CANONICAL_JSON_LIMITS_V1

export const SERIALIZATION_LIMIT_EXCEEDED_ERROR = "SERIALIZATION_LIMIT_EXCEEDED"

export interface DurableFormatRegistration {
  readonly formatId: string
  readonly formatVersion: number
  readonly kind: "framework-envelope" | "identity-encoding"
}

export const DURABLE_FORMAT_REGISTRY_V1: readonly DurableFormatRegistration[] = [
  {
    formatId: "framework.event-envelope",
    formatVersion: 1,
    kind: "framework-envelope",
  },
  {
    formatId: "framework.authority-provenance",
    formatVersion: 1,
    kind: "framework-envelope",
  },
  {
    formatId: "framework.execution-scope-id",
    formatVersion: 1,
    kind: "identity-encoding",
  },
]

export const FORMAT_DEFAULT_MAX_CANONICAL_BYTES = Object.freeze({
  executionScopeIdentitySource: 4 * 1024,
  authorityProvenance: 64 * 1024,
  cursorEnvelopeBeforeEncodingOrSigning: 16 * 1024,
  idempotencyFingerprintInputOwnedByFramework: 1024 * 1024,
  eventOutboxEnvelope: 1024 * 1024,
  inboxDurableEnvelope: 1024 * 1024,
  jobDurableEnvelope: 1024 * 1024,
  workflowSignalCheckpoint: 1024 * 1024,
  auditRecord: 1024 * 1024,
} as const)

export const DURABLE_FORMAT_RULES = {
  canonicalizationVersion: CANONICALIZATION_VERSION,
  digestAlgorithmVersion: DIGEST_ALGORITHM_VERSION,
  readersBeforeWritersRolloutRequired: true,
  publishedVersionsAreSemanticallyImmutable: true,
  unknownFutureVersionsFailClosed: true,
  adaptersMayAdvertiseLowerLimitsNeverHigher: true,
} as const
