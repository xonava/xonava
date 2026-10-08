export const GUARANTEE_STATUSES = [
  "proven",
  "unsupported",
  "experimental",
] as const

export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number]

export const GUARANTEE_IDS = [
  "transaction.interactive",
  "transaction.atomicBatch",
  "persistence.conditionalVersionedMutation",
  "persistence.conditionalAuthorizedMutation",
  "audit.atomic",
  "audit.durableEventual",
  "outbox.atomic",
  "inbox.transactional",
  "idempotency.atomicCommitReceipt",
  "cacheGeneration.atomic",
  "read.strong",
  "read.session",
  "read.eventual",
  "cursor.keyset",
  "lease.fenced",
  "exactDecimal",
  "streamingRead",
] as const

export type GuaranteeId = (typeof GUARANTEE_IDS)[number]

export const GUARANTEE_CERTIFICATION_SCHEMA = "framework.guarantee-certification"

export const GUARANTEE_CERTIFICATION_SCHEMA_VERSION = 1

export const V1_REQUIRED_GUARANTEES = Object.freeze({
  postgresql: Object.freeze([
    "transaction.interactive",
    "persistence.conditionalVersionedMutation",
    "persistence.conditionalAuthorizedMutation",
    "idempotency.atomicCommitReceipt",
    "audit.atomic",
    "outbox.atomic",
    "cacheGeneration.atomic",
  ] as const),
  d1: Object.freeze([
    "transaction.atomicBatch",
    "persistence.conditionalVersionedMutation",
    "persistence.conditionalAuthorizedMutation",
    "idempotency.atomicCommitReceipt",
    "audit.atomic",
    "outbox.atomic",
    "cacheGeneration.atomic",
  ] as const),
} as const) satisfies Readonly<Record<string, readonly GuaranteeId[]>>

export type V1AdapterKey = keyof typeof V1_REQUIRED_GUARANTEES

export const GUARANTEE_INVARIANTS = {
  onlyProvenSatisfiesProductionCompilation: true,
  missingCertificationIsUncertifiedNotExperimental: true,
  experimentalNeverSatisfiesProductionRequirement: true,
  releaseVerifierNeverTrustsPackageDeclaredBooleans: true,
} as const

export interface GuaranteeCertificationRecord {
  readonly schema: typeof GUARANTEE_CERTIFICATION_SCHEMA
  readonly schemaVersion: typeof GUARANTEE_CERTIFICATION_SCHEMA_VERSION
  readonly guaranteeId: GuaranteeId
  readonly status: GuaranteeStatus
  readonly adapterIdentity: string
  readonly adapterVersion: string
  readonly sourceRevision: string
  readonly evidenceDigest: string
  readonly evidenceLocation: string
}

export const GUARANTEE_CERTIFICATION_REQUIRED_FIELDS = [
  "schema",
  "schemaVersion",
  "guaranteeId",
  "status",
  "adapterIdentity",
  "adapterVersion",
  "sourceRevision",
  "evidenceDigest",
  "evidenceLocation",
] as const satisfies readonly (keyof GuaranteeCertificationRecord)[]
