import { assertMatchingPersistenceScope, createReadOnlyPersistenceProvider, type PersistenceProvider, type ReadOnlyPersistenceProvider } from "../persistence/provider"
import { defaultAuditSanitizer, type AuditSink, type AuditSinkFactory } from "../events/durability/audit"
import { requireCapability, requireRuntimeCapability, type RuntimeCapabilities } from "../bootstrap/runtimeCapabilities"
import { normalizeOutboxRecord, type NewOutboxRecord, type OutboxSinkFactory } from "../events/durability/outbox"
import type { AbacWriteEnforcer } from "../security/abac"
import type { AuthorizationFactRevalidator } from "../security/authorizationFacts"
import type { RequestContext } from "../domain"
import { ConfigurationError } from "../domain"
import { OperationEffectCollector, type CommitMarkerEntry } from "./operationEffectCollector"
import { createOperationServices, type OperationServices } from "./operationServices"
import type { InternalOperationRunContext, OperationEnvironment, OperationRunContext } from "./operationRunContext"
import { createExecutionDeadline, type Clock, type ExecutionDeadline } from "./deadline"
import { DEFAULT_EXECUTION_BUDGET, validateExecutionBudget, type ExecutionBudget } from "./executionBudget"
import type { TelemetryPort } from "../telemetry/telemetry"

export type { OperationEnvironment, OperationRunContext }

export interface ReadOperationContext {
  readonly operationId: string
  readonly correlationId?: string
  readonly request?: RequestContext
  readonly persistence: ReadOnlyPersistenceProvider
  readonly services: OperationServices
  readonly signal: AbortSignal
  readonly deadline: ExecutionDeadline
}

/** Minimal read-only surface used exclusively while deciding authorization. */
export interface AuthorizationOperationContext extends ReadOperationContext {
  readonly enforceAbac?: AbacWriteEnforcer
}

/** Minimal read-only surface used by deterministic input preparation hooks. */
export interface PreparationOperationContext extends ReadOperationContext {}

export interface MutationOperationContext {
  readonly operationId: string
  readonly correlationId?: string
  readonly request?: RequestContext
  readonly persistence: PersistenceProvider
  readonly services: OperationServices
  readonly signal: AbortSignal
  readonly deadline: ExecutionDeadline
  readonly enforceAbac?: AbacWriteEnforcer
  addDurableEffect(entry: { name: string; outbox: NewOutboxRecord }): void
  addBestEffortEffect(name: string, execute: (operation?: PostCommitContext) => Promise<void>): void
}

/** Transaction context for retryable operations. It intentionally has no effect APIs. */
export interface RetryableOperationContext {
  readonly operationId: string
  readonly correlationId?: string
  readonly request?: RequestContext
  readonly persistence: PersistenceProvider
  readonly services: OperationServices
  readonly signal: AbortSignal
  readonly deadline: ExecutionDeadline
  readonly enforceAbac?: AbacWriteEnforcer
}

export interface RepresentationContext {
  readonly operationId: string
  readonly correlationId?: string
  readonly request?: RequestContext
  readonly services: OperationServices
  readonly signal: AbortSignal
  readonly deadline: ExecutionDeadline
  readonly metadata?: Record<string, unknown>
}

export interface PostCommitContext {
  readonly operationId: string
  readonly correlationId?: string
  readonly request?: RequestContext
  readonly services: OperationServices
  readonly signal: AbortSignal
  readonly deadline: ExecutionDeadline
  readonly metadata?: Record<string, unknown>
  addBestEffortEffect(name: string, execute: (operation?: PostCommitContext) => Promise<void>): void
}

export interface CreateOperationContextArgs {
  persistence: PersistenceProvider
  runtimeCapabilities: RuntimeCapabilities
  request?: RequestContext
  auditSink?: AuditSink
  auditSanitizer?: (value: unknown) => unknown
  enforceAbac?: AbacWriteEnforcer
  authorizationFactRevalidator?: AuthorizationFactRevalidator
  auditSinkFactory?: AuditSinkFactory
  outboxSinkFactory?: OutboxSinkFactory
  /** Adapter-only commit participants. Never exposed on callback contexts. */
  commitMarkers?: readonly CommitMarkerEntry[]
  services?: OperationServices
  clock?: Clock
  idGenerator?: () => string
  telemetry?: TelemetryPort
  signal?: AbortSignal
  deadline?: ExecutionDeadline
  executionBudget?: ExecutionBudget
}

/** Create reusable services and persistence configuration. Effects are run-scoped only. */
export function createOperationContext<TPersistence extends PersistenceProvider>(
  args: CreateOperationContextArgs & { persistence: TPersistence },
): OperationEnvironment<TPersistence> {
  const providedServices = args.services
  const services = providedServices
    ? Object.freeze({
      clock: providedServices.clock,
      idGenerator: providedServices.idGenerator,
      telemetry: providedServices.telemetry,
    })
    : createOperationServices({
    ...(args.clock !== undefined ? { clock: args.clock } : {}),
    ...(args.idGenerator !== undefined ? { idGenerator: args.idGenerator } : {}),
    ...(args.telemetry !== undefined ? { telemetry: args.telemetry } : {}),
  })
  const executionBudget = validateExecutionBudget(args.executionBudget ?? DEFAULT_EXECUTION_BUDGET)
  return {
    persistence: args.persistence,
    runtimeCapabilities: args.runtimeCapabilities,
    ...(args.request !== undefined ? { request: args.request } : {}),
    services,
    signal: args.signal ?? new AbortController().signal,
    deadline: args.deadline ?? createExecutionDeadline(new Date(services.clock.now().getTime() + executionBudget.maxDurationMs)),
    executionBudget,
    nestingDepth: 0,
    ...(args.auditSink !== undefined ? { auditSink: args.auditSink } : {}),
    auditSanitizer: args.auditSanitizer ?? defaultAuditSanitizer,
    ...(args.enforceAbac !== undefined ? { enforceAbac: args.enforceAbac } : {}),
    ...(args.authorizationFactRevalidator !== undefined ? { authorizationFactRevalidator: args.authorizationFactRevalidator } : {}),
    ...(args.auditSinkFactory !== undefined ? { auditSinkFactory: args.auditSinkFactory } : {}),
    ...(args.outboxSinkFactory !== undefined ? { outboxSinkFactory: args.outboxSinkFactory } : {}),
    ...(args.commitMarkers !== undefined ? { commitMarkers: args.commitMarkers } : {}),
  }
}

export function createOperationRunContext<TPersistence extends PersistenceProvider>(
  environment: OperationEnvironment<TPersistence>,
  options?: { operationId?: string; correlationId?: string },
): InternalOperationRunContext<TPersistence> {
  const internalEnvironment = environment as OperationEnvironment & { readonly commitMarkers?: readonly CommitMarkerEntry[] }
  const correlationId = options?.correlationId ?? environment.request?.correlationId ?? environment.request?.requestId
  const executionBudget = validateExecutionBudget(environment.executionBudget ?? DEFAULT_EXECUTION_BUDGET)
  const signal = environment.signal ?? new AbortController().signal
  const deadline = environment.deadline ?? createExecutionDeadline(new Date(environment.services.clock.now().getTime() + executionBudget.maxDurationMs))
  const operationId = options?.operationId ?? environment.services.idGenerator()
  const collector = new OperationEffectCollector(
    internalEnvironment.commitMarkers ? { commitMarkers: [...internalEnvironment.commitMarkers] } : undefined,
  )

  return createRunContext(
    { ...environment, signal, deadline, executionBudget, nestingDepth: environment.nestingDepth ?? 0 },
    collector,
    operationId,
    correlationId,
    [],
  )
}

/**
 * Binds a live request's compiled route identity to the operation selected for
 * execution. Background and internal operations have no request and remain
 * intentionally supported.
 */
export function assertRequestBoundToOperation(
  operation: Pick<InternalOperationRunContext, "request">,
  operationKey: string,
): void {
  const route = operation.request?.route
  if (!route) return
  if (route.operationKey !== operationKey) {
    throw new ConfigurationError(
      `Request route "${route.routeKey}" is bound to operation "${route.operationKey}", not "${operationKey}".`,
    )
  }
}

function createRunContext<TPersistence extends PersistenceProvider>(
  environment: OperationEnvironment<TPersistence> & Required<Pick<OperationEnvironment<TPersistence>, "signal" | "deadline" | "executionBudget" | "nestingDepth">>,
  collector: OperationEffectCollector,
  operationId: string,
  correlationId: string | undefined,
  effectFailures: Array<{ phase: string; effectName: string; error: unknown }>,
): InternalOperationRunContext<TPersistence> {
  const context: InternalOperationRunContext<TPersistence> = {
    ...environment,
    operationId,
    ...(correlationId !== undefined ? { correlationId } : {}),
    effects: collector,
    get isDisposed() { return collector.isDisposed },
    get outboxRecords() { return collector.outboxRecords },
    get bestEffortEffects() { return collector.bestEffortEffects },
    get commitMarkers() { return collector.commitMarkers },
    effectFailures,
    requireRuntimeCapability: (capability) => requireRuntimeCapability(environment.runtimeCapabilities, capability),
    addOutboxRecord: (record) => collector.addOutboxRecord(normalizeOutboxRecord(record, {
      id: record.id ?? environment.services.idGenerator(),
      occurredAt: record.occurredAt ?? environment.services.clock.now(),
    })),
    addDurableEffect: ({ name, outbox }) => {
      if (!name || typeof name !== "string") {
        throw new ConfigurationError("addDurableEffect requires a non-empty effect name.")
      }
      collector.addOutboxRecord(normalizeOutboxRecord(outbox, {
        id: outbox.id ?? environment.services.idGenerator(),
        occurredAt: outbox.occurredAt ?? environment.services.clock.now(),
      }))
    },
    addBestEffortEffect: (name, execute) => {
      requireCapability(environment.runtimeCapabilities, "deferredExecution")
      collector.addBestEffortEffect(name, execute)
    },
    withPersistence: (persistence) => {
      assertMatchingPersistenceScope(context.persistence, persistence)
      return createRunContext(
        { ...environment, persistence },
        collector,
        operationId,
        correlationId,
        effectFailures,
      )
    },
    takePreCommitEffects: () => collector.takePreCommitEffects(),
    takeDeferredEffects: () => collector.takeDeferredEffects(),
    dispose: () => collector.dispose(),
  }
  return context
}

export function createPostCommitOperationContext(operation: InternalOperationRunContext): PostCommitContext {
  const restricted: PostCommitContext = {
    operationId: operation.operationId,
    ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
    ...(operation.request !== undefined ? { request: operation.request } : {}),
    services: operation.services,
    signal: operation.signal,
    deadline: operation.deadline,
    ...(operation.request?.metadata !== undefined ? { metadata: operation.request.metadata } : {}),
    addBestEffortEffect: (name, execute) => {
      operation.addBestEffortEffect(name, async () => execute(restricted))
    },
  }
  return Object.freeze(restricted)
}

export function createReadOperationContext(operation: InternalOperationRunContext): ReadOperationContext {
  return Object.freeze({
    operationId: operation.operationId,
    ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
    ...(operation.request !== undefined ? { request: operation.request } : {}),
    persistence: createReadOnlyPersistenceProvider(operation.persistence),
    services: operation.services,
    signal: operation.signal,
    deadline: operation.deadline,
  })
}

export function createAuthorizationOperationContext(operation: InternalOperationRunContext): AuthorizationOperationContext {
  return Object.freeze({
    operationId: operation.operationId,
    ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
    ...(operation.request !== undefined ? { request: operation.request } : {}),
    persistence: createReadOnlyPersistenceProvider(operation.persistence),
    services: operation.services,
    signal: operation.signal,
    deadline: operation.deadline,
    ...(operation.enforceAbac !== undefined ? { enforceAbac: operation.enforceAbac } : {}),
  })
}

export function createPreparationOperationContext(operation: InternalOperationRunContext): PreparationOperationContext {
  return Object.freeze({
    operationId: operation.operationId,
    ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
    ...(operation.request !== undefined ? { request: operation.request } : {}),
    persistence: createReadOnlyPersistenceProvider(operation.persistence),
    services: operation.services,
    signal: operation.signal,
    deadline: operation.deadline,
  })
}

export function createMutationOperationContext(operation: InternalOperationRunContext): MutationOperationContext {
  return Object.freeze({
    operationId: operation.operationId,
    ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
    ...(operation.request !== undefined ? { request: operation.request } : {}),
    persistence: operation.persistence,
    services: operation.services,
    signal: operation.signal,
    deadline: operation.deadline,
    ...(operation.enforceAbac !== undefined ? { enforceAbac: operation.enforceAbac } : {}),
    addDurableEffect: operation.addDurableEffect.bind(operation),
    addBestEffortEffect: operation.addBestEffortEffect.bind(operation),
  })
}

export function createRetryableOperationContext(operation: InternalOperationRunContext): RetryableOperationContext {
  return Object.freeze({
    operationId: operation.operationId,
    ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
    ...(operation.request !== undefined ? { request: operation.request } : {}),
    persistence: operation.persistence,
    services: operation.services,
    signal: operation.signal,
    deadline: operation.deadline,
    ...(operation.enforceAbac !== undefined ? { enforceAbac: operation.enforceAbac } : {}),
  })
}

export function createRepresentationContext(operation: InternalOperationRunContext): RepresentationContext {
  return Object.freeze({
    operationId: operation.operationId,
    ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
    ...(operation.request !== undefined ? { request: operation.request } : {}),
    services: operation.services,
    signal: operation.signal,
    deadline: operation.deadline,
    ...(operation.request?.metadata !== undefined ? { metadata: operation.request.metadata } : {}),
  })
}
