import { RuntimeCapabilityError } from "../domain/errors"

export interface PersistenceCapabilities {
  interactiveTransactions: boolean
  atomicBatch: boolean
  atomicBatchScope?: "unscoped" | "tenant-scoped"
  atomicBatchIdempotency?: boolean
  atomicBatchCacheGeneration?: boolean
  returningInsert: boolean
  readSessions: boolean
  jsonQueries: boolean
  exactDecimal: boolean
  persistentConnection: boolean
  conditionalAbacUpdate?: boolean
  maxBindParams?: number
  maxStatementBytes?: number
  maxBatchItems?: number
  maxPageSize?: number
  execution?: Readonly<Partial<Record<PersistenceExecutionCapability, CapabilityClaim>>>
}

export type CapabilityClaimStatus = "proven" | "unsupported" | "experimental"
export type PersistenceExecutionCapability = "transaction.interactive" | "transaction.atomicBatch" | "locking.pessimistic" | "bulk.versioned.atomic" | "bulk.versioned.partial" | "read.streaming" | "read.boundedPagedScan"
export interface CapabilityClaim { readonly status: CapabilityClaimStatus; readonly evidence?: string }

export function requireProvenPersistenceCapability(capabilities: PersistenceCapabilities, capability: PersistenceExecutionCapability): void {
  const claim = capabilities.execution?.[capability]
  if (claim?.status === "proven" && typeof claim.evidence === "string" && claim.evidence.length > 0) return
  throw new RuntimeCapabilityError(`Persistence capability "${capability}" is not proven.`, { capability, status: claim?.status ?? "unsupported" })
}
