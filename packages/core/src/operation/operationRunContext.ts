import type { NewOutboxRecord, OutboxRecord } from "../events/durability/outbox"
import type { PersistenceProvider } from "../persistence/provider"
import type { RuntimeCapability } from "../bootstrap/runtimeCapabilities"
import type { RequestContext } from "../domain"
import type { OperationServices } from "./operationServices"
import type { PostCommitContext } from "./operationContext"
import type { OperationEffectCollector } from "./operationEffectCollector"
import type { ExecutionBudget } from "./executionBudget"
import type { ExecutionDeadline } from "./deadline"

export interface OperationEnvironment<TPersistence extends PersistenceProvider = PersistenceProvider> {
  readonly persistence: TPersistence
  readonly runtimeCapabilities: import("../bootstrap/runtimeCapabilities").RuntimeCapabilities
  readonly request?: RequestContext
  readonly services: OperationServices
  readonly signal?: AbortSignal
  readonly deadline?: ExecutionDeadline
  readonly executionBudget?: ExecutionBudget
  readonly nestingDepth?: number
  readonly auditSink?: import("../events/durability/audit").AuditSink
  readonly auditSanitizer?: (value: unknown) => unknown
  readonly enforceAbac?: import("../security/abac").AbacWriteEnforcer
  readonly authorizationFactRevalidator?: import("../security/authorizationFacts").AuthorizationFactRevalidator
  readonly auditSinkFactory?: import("../events/durability/audit").AuditSinkFactory
  readonly outboxSinkFactory?: import("../events/durability/outbox").OutboxSinkFactory
  /**
   * Called for every best-effort post-commit failure (afterCommit hooks,
   * onBusinessResult, best-effort effects). Use it for alerting: the operation
   * has committed and returns normally. Errors thrown here are ignored.
   */
  /** Secret for keyed `hash` masking of authorized results (>= 16 bytes). */
  readonly maskingKey?: Uint8Array
  readonly onCommittedEffectFailure?: import("./committedEffectFailure").CommittedEffectFailureHandler
}

export interface OperationRunContext<TPersistence extends PersistenceProvider = PersistenceProvider> extends OperationEnvironment<TPersistence> {
  readonly operationId: string
  readonly correlationId?: string
  requireRuntimeCapability(capability: RuntimeCapability): void
  addOutboxRecord(record: NewOutboxRecord): void
  /**
   * Registers a DURABLE post-commit obligation: the outbox record is committed
   * atomically with the mutation, so a correctness-critical effect survives a
   * crash and is processed by a durable consumer with its own idempotency.
   * Unlike best-effort effects, this work is never lost.
   */
  addDurableEffect(entry: { name: string; outbox: NewOutboxRecord }): void
  addBestEffortEffect(name: string, execute: (operation?: PostCommitContext) => Promise<void>): void
  withPersistence(persistence: TPersistence): OperationRunContext<TPersistence>
}

export interface InternalOperationRunContext<TPersistence extends PersistenceProvider = PersistenceProvider> extends OperationRunContext<TPersistence> {
  readonly signal: AbortSignal
  readonly deadline: ExecutionDeadline
  readonly executionBudget: ExecutionBudget
  readonly nestingDepth: number
  readonly effects: OperationEffectCollector
  readonly isDisposed: boolean
  readonly outboxRecords: OutboxRecord[]
  readonly bestEffortEffects: import("./operationEffectCollector").BestEffortEffectEntry[]
  readonly commitMarkers: import("./operationEffectCollector").CommitMarkerEntry[]
  readonly effectFailures: Array<{ phase: string; effectName: string; error: unknown }>
  takePreCommitEffects(): ReturnType<OperationEffectCollector["takePreCommitEffects"]>
  takeDeferredEffects(): ReturnType<OperationEffectCollector["takeDeferredEffects"]>
  dispose(): void
  withPersistence(persistence: TPersistence): InternalOperationRunContext<TPersistence>
}

export type SideEffectEntry = {
  name: string
  execute: (operation?: OperationRunContext) => Promise<void>
}
