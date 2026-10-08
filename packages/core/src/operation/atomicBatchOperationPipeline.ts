import { runAfterHooks, runBeforeHooks } from "./hooks"
import { runAfterCommitHooks } from "./hooks"
import { assertRequestBoundToOperation, createAuthorizationOperationContext, createPreparationOperationContext, createPostCommitOperationContext, createRepresentationContext, type PostCommitContext } from "./operationContext"
import type { InternalOperationRunContext } from "./operationRunContext"
import type { AtomicBatchOperationDefinition, AtomicBatchPreparationContext } from "./operationDefinition"
import { classifyAuditValue, defaultAuditSanitizer } from "../events/durability/audit"
import { requireRuntimeCapability } from "../bootstrap/runtimeCapabilities"
import type { AtomicBatchItem, AtomicBatchItemResult, AtomicBatchPlan, TenantScopedAtomicBatchPlan, TenantScopedAtomicBatchProvider } from "../persistence/provider"
import { supportsAtomicBatch, supportsTenantScopedAtomicBatch } from "../persistence/provider"
import { AuditActorMissingError, ConfigurationError } from "../domain"
import { assertExecutionActive } from "./deadline"
import { applyAuthorizationPlanToResult, assertAtomicBatchPlanSupported, authorizeOperation } from "./authorizationPlanEnforcement"
import { reportCommittedEffectFailure } from "./committedEffectFailure"

export interface CommittedEffectErrorContext {
  operationId?: string
  correlationId?: string
  result?: unknown
}

export class OperationCommittedEffectError extends Error {
  readonly committed = true
  readonly failures: readonly unknown[]
  readonly operationId?: string
  readonly correlationId?: string
  readonly result?: unknown
  override readonly cause: unknown

  constructor(message: string, cause: unknown, failures: readonly unknown[] = [cause], context: CommittedEffectErrorContext = {}) {
    super(message, { cause })
    this.name = "OperationCommittedEffectError"
    this.cause = cause
    this.failures = failures
    if (context.operationId !== undefined) this.operationId = context.operationId
    if (context.correlationId !== undefined) this.correlationId = context.correlationId
    if (context.result !== undefined) this.result = context.result
  }
}

export async function runAtomicBatchOperation<TInput, TResult, TCommand>(args: {
  operation: InternalOperationRunContext
  definition: AtomicBatchOperationDefinition<TInput, TResult, TCommand>
  input: TInput
  onBusinessResult?: (result: TResult, operation: PostCommitContext) => Promise<void>
  /** Invoked by another operation: the request's route is bound to the root operation. */
  nested?: boolean
}): Promise<TResult> {
  assertExecutionActive(args.operation.signal, args.operation.deadline, args.operation.services.clock)
  if (args.nested !== true) assertRequestBoundToOperation(args.operation, args.definition.key)
  const provider = args.operation.persistence
  for (const capability of args.definition.requiredRuntimeCapabilities ?? []) requireRuntimeCapability(args.operation.runtimeCapabilities, capability)
  if (!supportsAtomicBatch(provider)) throw new ConfigurationError(`Operation ${args.definition.key} requires atomic-batch persistence support.`)
  const tenantScoped = supportsTenantScopedAtomicBatch(provider)
  if (provider.capabilities.atomicBatchScope === "tenant-scoped" && !tenantScoped) {
    throw new ConfigurationError(`Operation ${args.definition.key} requires a complete tenant-scoped persistence capability.`)
  }
  if (tenantScoped) {
    if (operationTenantId(args.operation) !== provider.tenantId) {
      throw new ConfigurationError(`Operation ${args.definition.key} tenant does not match the persistence provider.`)
    }
  }
    // Atomic fallback has no transaction around lifecycle hooks. Keep hooks
    // pure with respect to ordinary persistence; commands and outbox records
    // are still collected and committed by executeAtomicBatch below.
    const operation = args.operation
  let postCommitOperation: InternalOperationRunContext | undefined
  try {
    if (args.definition.kind === "mutation" && (!args.definition.authorization || typeof args.definition.authorization.authorize !== "function")) {
      throw new ConfigurationError(`Atomic-batch mutation ${args.definition.key} requires authorization.`)
    }
    const authorizationPlan = await authorizeOperation({ operation: createAuthorizationOperationContext(operation), definition: args.definition, input: args.input })
    assertAtomicBatchPlanSupported(authorizationPlan, args.definition.key)
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    const input = await runBeforeHooks({ operation: createPreparationOperationContext(operation), input: args.input, ...(args.definition.before !== undefined ? { hooks: args.definition.before } : {}) })
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    if (args.definition.audit && args.definition.audit.required !== false && !operation.request?.identity.actor) throw new AuditActorMissingError(`Audit actor missing for operation: ${args.definition.audit.action}`)
    const commands: TCommand[] = []
    const preparationOperation: AtomicBatchPreparationContext<TCommand> = {
      operationId: operation.operationId,
      ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
      ...(operation.request !== undefined ? { request: operation.request } : {}),
      services: operation.services,
      signal: operation.signal,
      deadline: operation.deadline,
      addCommand: (command) => { commands.push(command) },
      addOutboxRecord: (record) => operation.addOutboxRecord(record),
      addDurableEffect: (entry) => operation.addDurableEffect(entry),
      addBestEffortEffect: (name, execute) => operation.addBestEffortEffect(name, execute),
    }
    const prepared = await args.definition.prepare({ operation: preparationOperation, input })
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    assertPreparedBatch(args.definition.key, prepared)
    commands.push(...prepared.commands)
    const items: AtomicBatchItem<TCommand>[] = commands.map((command) => ({ kind: "command", command }))
    // The atomic audit must be derivable from deterministic pre-commit command
    // state. A post-state row cannot exist until after the batch commits.
    if (args.definition.audit) {
      const audit = args.definition.audit
      const actor = operation.request?.identity.actor
      if (actor) {
        const sanitize = (value: unknown) => (operation.auditSanitizer ?? defaultAuditSanitizer)(classifyAuditValue(value, audit.fieldClassification))
        const record = {
          id: operation.services.idGenerator(),
          occurredAt: operation.services.clock.now(),
          actor,
          action: audit.action,
          resourceType: audit.resourceType,
          resourceId: audit.resolveResourceId({ input, result: prepared.result }),
          tenantId: operation.request?.scope.kind === "tenant" ? operation.request.scope.tenantId : null,
          oldValue: audit.extractOldValue ? sanitize(audit.extractOldValue({ input }) ?? {}) as Record<string, unknown> : null,
          newValue: audit.extractNewValue
            ? sanitize(audit.extractNewValue({ input, result: prepared.result }) ?? {}) as Record<string, unknown>
            : null,
        }
        items.push({ kind: "audit", record })
      }
    }
    items.push(...operation.outboxRecords.map((record): AtomicBatchItem<TCommand> => ({
      kind: "outbox",
      record: { ...record, id: record.id || operation.services.idGenerator(), occurredAt: record.occurredAt ?? operation.services.clock.now() },
    })))
    // Close the pre-commit effect collector before the irreversible commit. Any
    // transactional/outbox registration after this point is a hard error rather
    // than silently discarded work.
    const pendingEffects = operation.takePreCommitEffects()
    // Durable commit obligations assert exclusive ownership immediately before
    // the atomic batch executes. A lost fence aborts before anything commits,
    // and self-contained markers join the batch so they are atomic with it.
    for (const marker of operation.commitMarkers) {
      await marker.fence?.(operation.persistence)
      const batchItem = await marker.batchItem?.(prepared.result)
      if (batchItem) items.push(batchItem as AtomicBatchItem<TCommand>)
    }
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    const plan: AtomicBatchPlan<TCommand> = { items }
    const itemResults = tenantScoped
      ? await (provider as TenantScopedAtomicBatchProvider<TCommand>).executeAtomicBatch({
        ...plan,
      } satisfies TenantScopedAtomicBatchPlan<TCommand>)
      : await provider.executeAtomicBatch(plan)
    let commandResults: unknown[]
    try {
      commandResults = validateBatchResults(args.definition.key, items, itemResults)
    } catch (error) {
      throw new OperationCommittedEffectError(`Operation ${args.definition.key} committed, but the persistence provider returned incomplete or malformed batch results.`, error, [error], { operationId: operation.operationId, ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}) })
    }
    try {
      await prepared.verify?.({ result: prepared.result, commandResults })
    } catch (error) {
      throw new OperationCommittedEffectError(`Operation ${args.definition.key} committed, but result verification failed.`, error, [error], { operationId: operation.operationId, ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}) })
    }
    // The generic after hooks are representation/enrichment and must only run
    // after the batch has committed so they can observe committed state.
    let finalResult: TResult
    try {
      finalResult = await runAfterHooks({ operation: createRepresentationContext(operation), input, result: prepared.result, ...(args.definition.after !== undefined ? { hooks: args.definition.after } : {}) })
    } catch (error) {
      // The batch has committed but there is no correct representation to
      // return. Callers must treat OperationCommittedEffectError as committed
      // and MUST NOT retry the mutation.
      reportCommittedEffectFailure(operation, "after", "hooks", error)
      throw new OperationCommittedEffectError(`Operation ${args.definition.key} committed, but a post-commit hook failed.`, error, [error], { operationId: operation.operationId, ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}), result: prepared.result })
    }
    // The atomic provider has committed the command, audit, and outbox items.
    const restrictedOperation = operation.withPersistence(operation.persistence)
    postCommitOperation = restrictedOperation
    const postCommitContext = createPostCommitOperationContext(restrictedOperation)
    // Same post-commit contract as the standard pipeline: best-effort work is
    // reported, never thrown, because the mutation has already committed.
    // The prepared effects were admitted (capability and budget) when they
    // were registered; re-queueing them never re-checks either.
    try {
      restrictedOperation.effects.restoreDeferredEffects(pendingEffects.bestEffortEffects)
    } catch (error) {
      reportCommittedEffectFailure(restrictedOperation, "bestEffort", "restore", error)
    }
    try {
      await args.onBusinessResult?.(finalResult, postCommitContext)
    } catch (error) {
      reportCommittedEffectFailure(operation, "onBusinessResult", "business-result", error)
    }
    for (const hook of asArray(args.definition.afterCommit)) {
      try {
        await runAfterCommitHooks({ operation: postCommitContext, input, result: finalResult, hooks: hook })
      } catch (error) {
        reportCommittedEffectFailure(restrictedOperation, "afterCommit", "hooks", error)
      }
    }
    await runPendingEffects(restrictedOperation, postCommitContext)
    return applyAuthorizationPlanToResult(authorizationPlan, finalResult, operation.maskingKey !== undefined ? { maskingKey: operation.maskingKey } : {})
  } finally {
    postCommitOperation?.dispose()
    operation.dispose()
  }
}

function operationTenantId(operation: InternalOperationRunContext): string | undefined {
  return operation.request?.scope.kind === "tenant" ? operation.request.scope.tenantId : undefined
}

function assertPreparedBatch<TCommand, TResult>(
  key: string,
  prepared: unknown,
): asserts prepared is {
  commands: readonly TCommand[]
  result: TResult
  verify?: (args: { result: TResult; commandResults: readonly unknown[] }) => unknown
} {
  if (typeof prepared !== "object" || prepared === null) {
    throw new ConfigurationError(`Atomic operation ${key} prepare must return a prepared batch.`)
  }
  const candidate = prepared as { commands?: unknown; result?: unknown; verify?: unknown }
  if (!Array.isArray(candidate.commands) || !Object.prototype.hasOwnProperty.call(candidate, "result")) {
    throw new ConfigurationError(`Atomic operation ${key} prepare must return commands and a result.`)
  }
  if (candidate.verify !== undefined && typeof candidate.verify !== "function") {
    throw new ConfigurationError(`Atomic operation ${key} prepare.verify must be a function when provided.`)
  }
}

function validateBatchResults(
  key: string,
  items: readonly AtomicBatchItem[],
  results: unknown,
): unknown[] {
  if (!Array.isArray(results) || results.length !== items.length) {
    throw new Error(`Expected ${items.length} results for ${items.length} atomic batch items.`)
  }
  const commandResults: unknown[] = []
  for (const [index, item] of items.entries()) {
    const result: unknown = results[index]
    if (!isAtomicBatchItemResult(result) || result.kind !== item.kind) {
      throw new Error(`Atomic batch result at index ${index} does not match the submitted ${item.kind} item.`)
    }
    if (item.kind === "command") commandResults.push(result.result)
  }
  return commandResults
}

function isAtomicBatchItemResult(value: unknown): value is AtomicBatchItemResult {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { kind?: unknown }
  return (candidate.kind === "command" || candidate.kind === "audit" || candidate.kind === "outbox" || candidate.kind === "cache-generation" || candidate.kind === "idempotency") &&
    Object.prototype.hasOwnProperty.call(value, "result")
}

async function runPendingEffects(operation: InternalOperationRunContext, postCommitContext: PostCommitContext): Promise<void> {
  while (operation.bestEffortEffects.length) {
    const drained = operation.takeDeferredEffects()
    for (const effect of drained.bestEffortEffects) {
      try { await effect.execute(postCommitContext) } catch (error) {
        reportCommittedEffectFailure(operation, "bestEffort", effect.name, error)
      }
    }
  }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}
