import { runAfterHooks, runBeforeHooks } from "./hooks"
import { assertRequestBoundToOperation, createOperationRunContext, createPostCommitOperationContext, createReadOperationContext, createMutationOperationContext, createRetryableOperationContext, createRepresentationContext, createAuthorizationOperationContext, createPreparationOperationContext, type AuthorizationOperationContext, type PostCommitContext } from "./operationContext"
import type { InternalOperationRunContext } from "./operationRunContext"
import { runAfterCommitHooks } from "./hooks"
import { classifyAuditValue, defaultAuditSanitizer, type AuditRecord } from "../events/durability/audit"
import type { InteractiveTransactionProvider } from "../persistence/provider"
import { supportsInteractiveTransactions } from "../persistence/provider"
import { AuditActorMissingError, AuditSinkMissingError, ConfigurationError, OutboxSinkMissingError, RetryablePersistenceError } from "../domain"
import type { StandardOperationDefinition, StandardAtomicityMode, RetryableTransactionExecution, RetryableMutationOperationDefinition } from "./operationDefinition"
import { requireRuntimeCapability } from "../bootstrap/runtimeCapabilities"
import { runAtomicBatchOperation } from "./atomicBatchOperationPipeline"
import { assertExecutionActive } from "./deadline"
import { applyAuthorizationPlanToResult, authorizeOperation, createPlanConstrainedPersistenceProvider, revalidateAuthorizationFacts } from "./authorizationPlanEnforcement"
import { emitTelemetry, explicitlySafeTelemetryAttributes } from "../telemetry/telemetry"

type ExecutableStandardOperationDefinition<TInput, TResult> = StandardOperationDefinition<TInput, TResult> | RetryableMutationOperationDefinition<TInput, TResult>

export async function runStandardOperation<TInput, TResult>(args: {
  operation: InternalOperationRunContext
  definition: ExecutableStandardOperationDefinition<TInput, TResult>
  input: TInput
  onBusinessResult?: (result: TResult, operation: PostCommitContext) => Promise<void>
}): Promise<TResult> {
  assertExecutionActive(args.operation.signal, args.operation.deadline, args.operation.services.clock)
  assertRequestBoundToOperation(args.operation, args.definition.key)
  const mode = resolveMode(args.definition)
  const failedAttemptEffects = new WeakMap<object, boolean>()
  requireRuntimeCapabilities(args.operation, args.definition.requiredRuntimeCapabilities)
  const supportsTransactions = supportsInteractiveTransactions(args.operation.persistence)
  if (!supportsTransactions && args.definition.execution !== undefined) throw new ConfigurationError(`Operation ${args.definition.key} requires interactive transaction execution.`)
  if (mode === "required" && !supportsTransactions && args.definition.kind === "mutation" && "atomicBatch" in args.definition && args.definition.atomicBatch) {
    const batchDefinition = {
      ...args.definition,
      atomicity: { kind: "atomic-batch" as const },
      prepare: args.definition.atomicBatch.prepare,
    }
    return runAtomicBatchOperation({
      operation: args.operation,
      definition: batchDefinition,
      input: args.input,
      ...(args.onBusinessResult ? { onBusinessResult: args.onBusinessResult } : {}),
    })
  }
  if (mode === "required" && !supportsTransactions) {
    throw new ConfigurationError(`Operation ${args.definition.key} requires interactive transactions.`)
  }

  const auditMode = resolveAuditDelivery(args.definition, supportsTransactions)
  const execute = async (operation: InternalOperationRunContext): Promise<{ input: TInput; result: TResult; operation: InternalOperationRunContext }> => {
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    const plan = await authorizeOperation({ operation: createAuthorizationOperationContext(operation), definition: args.definition, input: args.input })
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    // Only lifecycle callbacks receive the plan-constrained persistence view.
    // Infrastructure sinks retain the concrete transaction provider below.
    const executionOperation = plan
      ? operation.withPersistence(createPlanConstrainedPersistenceProvider(operation.persistence, plan))
      : operation
    preflight({ operation, definition: args.definition, mode, auditMode })
    if (plan?.operationKind === "mutation" && plan.dynamicFacts.some(fact => fact.revalidation?.kind !== "mutation-predicate") && !operation.authorizationFactRevalidator) throw new ConfigurationError("Authorization plan requires a dynamic-fact revalidator.")
    const input = await runBeforeHooks({ operation: createPreparationOperationContext(executionOperation), input: args.input, ...(args.definition.before !== undefined ? { hooks: args.definition.before } : {}) })
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    let result: TResult
    if (isRetryableDefinition(args.definition)) {
      result = await args.definition.execute({ operation: createRetryableOperationContext(executionOperation), input })
    } else if (args.definition.kind === "read") {
      result = await args.definition.execute({ operation: createReadOperationContext(executionOperation), input })
    } else {
      result = await args.definition.execute({ operation: createMutationOperationContext(executionOperation), input })
    }
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    await revalidateAuthorizationFacts({ plan, operation, ...(operation.authorizationFactRevalidator !== undefined ? { revalidator: operation.authorizationFactRevalidator } : {}) })
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    const finalResult = await runAfterHooks({ operation: createRepresentationContext(operation), input, result, ...(args.definition.after !== undefined ? { hooks: args.definition.after } : {}) })
    if ((!supportsTransactions || mode === "none") && operation.outboxRecords.length > 0) {
      throw new ConfigurationError(`Operation ${args.definition.key} registered durable effects without an active transaction.`)
    }
    const audit = buildAudit({ operation, definition: args.definition, input, result: finalResult, auditMode })
    if (audit) await writeAudit(operation, audit)
    await persistOutbox(operation)
    // Durable commit obligations run inside the transaction, immediately before
    // it commits, so their marker is atomic with the business mutation.
    for (const marker of operation.commitMarkers) {
      await marker.commit?.(finalResult, operation.persistence)
    }
    assertExecutionActive(operation.signal, operation.deadline, operation.services.clock)
    return { input, result: applyAuthorizationPlanToResult(plan, finalResult), operation }
  }

  const run = async (operation: InternalOperationRunContext): Promise<{ input: TInput; result: TResult; operation: InternalOperationRunContext }> => {
    try {
      return await execute(operation)
    } catch (error) {
      // P1-07: Preserve side-effect signal before disposal so transaction retry
      // guard can observe it. `dispose()` clears collector state.
      const hadSideEffects = operation.outboxRecords.length > 0 || operation.commitMarkers.length > 0
      failedAttemptEffects.set(operation, hadSideEffects)
      operation.dispose()
      throw error
    }
  }

  const finish = async (transactionOperation: InternalOperationRunContext, input: TInput, result: TResult, pendingEffects: { bestEffortEffects: { name: string; execute: (operation?: PostCommitContext) => Promise<void> }[] }, onBusinessResult?: (result: TResult, operation: PostCommitContext) => Promise<void>): Promise<TResult> => {
    const operation = transactionOperation
    const postCommitContext = createPostCommitOperationContext(operation)
    for (const effect of pendingEffects.bestEffortEffects) operation.addBestEffortEffect(effect.name, effect.execute)
     try {
       const failures: unknown[] = []
       try {
         await onBusinessResult?.(result, postCommitContext)
       } catch (error) {
         failures.push(error)
         reportEffectFailure(operation, "onBusinessResult", "business-result", error)
       }
      for (const hook of asArray(args.definition.afterCommit)) {
        try {
           await runAfterCommitHooks({ operation: postCommitContext, input, result, hooks: hook })
        } catch (error) {
          failures.push(error)
          reportEffectFailure(operation, "afterCommit", "hooks", error)
        }
       }
       await runPendingEffects(operation, postCommitContext)
        return result
    } finally {
      operation.dispose()
    }
  }

  if (mode !== "none" && supportsTransactions) {
    const provider = args.operation.persistence as InteractiveTransactionProvider
    const execution = args.definition.execution
    const completed = await runTransactionWithRetry({
      provider,
      operation: args.operation,
      definition: args.definition,
      input: args.input,
      run,
      failedAttemptEffects,
       ...(execution?.kind === "retryable-transaction" ? { retryPolicy: execution } : {}),
      ...(args.definition.atomicity?.transactionOptions !== undefined ? { transactionOptions: args.definition.atomicity.transactionOptions } : {}),
    })
    const pendingEffects = completed.operation.takePreCommitEffects()
    return finish(completed.operation, completed.result.input, completed.result.result, pendingEffects, args.onBusinessResult)
  }
  if (mode === "preferred" && !supportsTransactions) {
    emitTelemetry(args.operation.services.telemetry, { name: "operation.transaction.unavailable", severity: "warn", timestamp: args.operation.services.clock.now(), attributes: explicitlySafeTelemetryAttributes({ operationKey: args.definition.key }) })
  }
   const operation = args.operation.withPersistence(args.operation.persistence)
  const completed = await run(operation)
  const pendingEffects = completed.operation.takePreCommitEffects()
  return finish(completed.operation, completed.input, completed.result, pendingEffects, args.onBusinessResult)
}

function isRetryableDefinition<TInput, TResult>(
  definition: ExecutableStandardOperationDefinition<TInput, TResult>,
): definition is RetryableMutationOperationDefinition<TInput, TResult> {
  return definition.kind === "mutation" && definition.execution?.kind === "retryable-transaction"
}

function resolveMode<TInput, TResult>(definition: ExecutableStandardOperationDefinition<TInput, TResult>): StandardAtomicityMode {
  if (definition.atomicity?.kind === "standard") return definition.atomicity.mode
  return "none"
}

function requireRuntimeCapabilities(operation: InternalOperationRunContext, capabilities: readonly import("../bootstrap/runtimeCapabilities").RuntimeCapability[] | undefined): void {
  for (const capability of capabilities ?? []) requireRuntimeCapability(operation.runtimeCapabilities, capability)
}

function resolveAuditDelivery<TInput, TResult>(definition: ExecutableStandardOperationDefinition<TInput, TResult>, supportsTransactions: boolean) {
  const config = definition.audit
  const requested = config?.auditGuarantee ?? "best-effort"
  if (requested === "durable" && !supportsTransactions) {
    if (config?.fallbackAuditGuarantee === "best-effort" && config.required === false) return "best-effort" as const
    throw new ConfigurationError("Outbox audit requires interactive transactions.")
  }
  if (requested === "atomic") return "transactional" as const
  if (requested === "durable") return "outbox" as const
  return "best-effort" as const
}

function preflight<TInput, TResult>(args: { operation: InternalOperationRunContext; definition: ExecutableStandardOperationDefinition<TInput, TResult>; mode: StandardAtomicityMode; auditMode: string }) {
  const audit = args.definition.audit
  if (audit && audit.required === true && args.auditMode === "best-effort") throw new ConfigurationError(`Required audit cannot use best-effort delivery: ${audit.action}`)
  if (audit && audit.required !== false && !args.operation.request?.identity.actor) throw new AuditActorMissingError(`Audit actor missing for operation: ${audit.action}`)
  if (audit && audit.required !== false && args.auditMode === "transactional" && args.mode !== "required") throw new ConfigurationError(`Transactional audit requires required standard atomicity: ${audit.action}`)
  if (audit && audit.required !== false && args.auditMode === "transactional" && !args.operation.auditSinkFactory) throw new AuditSinkMissingError(`Transactional audit sink missing for operation: ${audit.action}`)
  if (audit && audit.required !== false && args.auditMode === "outbox" && args.mode !== "required") throw new ConfigurationError(`Outbox audit requires required standard atomicity: ${audit.action}`)
  if (audit && audit.required !== false && args.auditMode === "outbox" && !args.operation.outboxSinkFactory) throw new OutboxSinkMissingError(`Outbox sink missing for operation: ${audit.action}`)
  if (audit && audit.required !== false && args.auditMode === "best-effort" && !args.operation.auditSink) throw new AuditSinkMissingError(`Audit sink missing for operation: ${audit.action}`)
  if (args.definition.outbox?.required && (!args.operation.outboxSinkFactory || args.mode !== "required")) throw new ConfigurationError("Required outbox needs a required standard atomicity and an outbox sink.")
}

function buildAudit<TInput, TResult>(args: { operation: InternalOperationRunContext; definition: ExecutableStandardOperationDefinition<TInput, TResult>; input: TInput; result: TResult; auditMode: string }): AuditRecord | null {
  const config = args.definition.audit
  const actor = args.operation.request?.identity.actor
  if (!config || !actor) return null
  const sanitize = (value: unknown) => (args.operation.auditSanitizer ?? defaultAuditSanitizer)(classifyAuditValue(value, config.fieldClassification))
  const record: AuditRecord = {
    id: args.operation.services.idGenerator(), occurredAt: args.operation.services.clock.now(), actor,
    action: config.action, resourceType: config.resourceType, resourceId: config.resolveResourceId({ input: args.input, result: args.result }),
    tenantId: args.operation.request?.scope.kind === "tenant" ? args.operation.request.scope.tenantId : null,
    oldValue: config.extractOldValue ? sanitize(config.extractOldValue({ input: args.input }) ?? {}) as Record<string, unknown> : null,
    newValue: config.extractNewValue ? sanitize(config.extractNewValue({ input: args.input, result: args.result }) ?? {}) as Record<string, unknown> : null,
  }
  if (args.auditMode === "transactional") return record
  if (args.auditMode === "outbox") {
    args.operation.addOutboxRecord({ id: args.operation.services.idGenerator(), type: "framework.audit.write", version: 1, tenantId: record.tenantId, scope: args.operation.request!.scope, scopeId: args.operation.request!.scopeId, aggregateType: record.resourceType, aggregateId: record.resourceId, payload: record as unknown as Record<string, unknown>, idempotencyKey: `audit:${args.operation.operationId}:${config.action}`, occurredAt: record.occurredAt })
  } else if (args.operation.auditSink) {
    args.operation.addBestEffortEffect("audit-write", () => args.operation.auditSink!.write(record))
  }
  return null
}

async function writeAudit(operation: InternalOperationRunContext, record: AuditRecord) {
  const factory = operation.auditSinkFactory
  if (!factory) throw new AuditSinkMissingError("Transactional audit sink factory missing.")
  await factory.create(operation.persistence).write(record)
}

async function persistOutbox(operation: InternalOperationRunContext) {
  const records = operation.outboxRecords
  if (!records.length) return
  const factory = operation.outboxSinkFactory
  if (!factory) throw new OutboxSinkMissingError("Outbox sink factory missing.")
  const sink = factory.create(operation.persistence)
  for (const record of records) {
    await sink.append({
      ...record,
      id: record.id || operation.services.idGenerator(),
      occurredAt: record.occurredAt ?? operation.services.clock.now(),
    })
  }
}

async function runEffects(operation: InternalOperationRunContext, postCommitContext: PostCommitContext, effects: { name: string; execute: (operation?: PostCommitContext) => Promise<void> }[], phase: string, required: boolean): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const effect of effects) {
    try { await effect.execute(postCommitContext) } catch (error) {
      if (required) failures.push(error)
      reportEffectFailure(operation, phase, effect.name, error)
    }
  }
  return failures
}

async function runPendingEffects(operation: InternalOperationRunContext, postCommitContext: PostCommitContext): Promise<void> {
  while (operation.bestEffortEffects.length) {
    const drained = operation.takeDeferredEffects()
    await runEffects(operation, postCommitContext, drained.bestEffortEffects, "bestEffort", false)
  }
}

async function runTransactionWithRetry<TInput, TResult>(args: {
  provider: InteractiveTransactionProvider
  operation: InternalOperationRunContext
  definition: ExecutableStandardOperationDefinition<TInput, TResult>
  input: TInput
  run: (operation: InternalOperationRunContext) => Promise<{ input: TInput; result: TResult; operation: InternalOperationRunContext }>
  failedAttemptEffects: WeakMap<object, boolean>
  retryPolicy?: RetryableTransactionExecution
  transactionOptions?: import("../persistence/provider").TransactionOptions
}): Promise<{ operation: InternalOperationRunContext; result: { input: TInput; result: TResult; operation: InternalOperationRunContext } }> {
  // P1-07: Transaction retry safety.
  //
  // The operation callback (including its hooks and transactional effects) is
  // rerun from the beginning for each retry attempt. This is safe only when the
  // callback is idempotent — i.e., rerunning it produces the same result and
  // has no observable side effects outside the transaction.
  //
  // Risks of non-idempotent retries:
  // - Transactional effects may have already sent external messages (email,
  //   webhooks, notifications) that cannot be retracted on rollback.
  // - Outbox records may have been written but the retry writes them again,
  //   causing duplicate processing.
  // - External API calls (HTTP, gRPC, message queues) inside the callback
  //   are not rolled back by the database transaction.
  //
  // Current mitigation: If the operation registered any transactional effects
  // or outbox records during the failed attempt, we do NOT retry — the side
  // effects may have partially executed and rerunning could duplicate them.
  //
  const maxAttempts = args.retryPolicy?.maxAttempts ?? 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let callbackFailed = false
    let hadSideEffects = false
    const attemptContext = args.retryPolicy
      ? createOperationRunContext(args.operation, {
           operationId: args.operation.operationId,
           ...(args.operation.correlationId !== undefined ? { correlationId: args.operation.correlationId } : {}),
         })
      : args.operation
    try {
      return await args.provider.runInTransaction(async (scoped) => {
          const operation = attemptContext.withPersistence(scoped)
        try {
          const result = await args.run(operation)
          // Detect transactional side effects that would make retry unsafe.
          // Include commit markers: they assert ownership and are non-idempotent.
           hadSideEffects = operation.outboxRecords.length > 0 || operation.commitMarkers.length > 0
          return { operation, result }
        } catch (error) {
          callbackFailed = true
          // Read private attempt state captured before disposal. Never mutate or trust the thrown error.
          const flagged = args.failedAttemptEffects.get(operation)
          if (typeof flagged === "boolean") hadSideEffects = flagged
           else hadSideEffects = operation.outboxRecords.length > 0 || operation.commitMarkers.length > 0
          throw error
        }
      }, args.definition.kind === "read"
        ? { ...args.transactionOptions, accessMode: "read only" }
        : args.transactionOptions)
    } catch (error) {
      // A provider error after the callback returns may have an unknown commit
      // outcome, so it is never safe to rerun the operation.
      if (!callbackFailed) {
        attemptContext.dispose()
        throw error
      }
      // P1-07: Do not retry if the failed attempt registered transactional
      // effects or outbox records — these may have partially executed external
      // side effects (emails, webhooks, messages) that cannot be retracted.
      if (hadSideEffects) {
        attemptContext.dispose()
        throw error
      }
      if (!(error instanceof RetryablePersistenceError) || attempt >= maxAttempts) {
        attemptContext.dispose()
        throw error
      }
      // Retry with fresh collector — dispose the failed attempt's collector first
      attemptContext.dispose()
      const delayMs = Math.min(
         args.retryPolicy!.maxDelay,
         args.retryPolicy!.delay * Math.pow(args.retryPolicy!.backoff, attempt - 1),
      )
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new ConfigurationError(`Transaction retry policy for ${args.definition.key} produced no attempt.`)
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function reportEffectFailure(operation: InternalOperationRunContext, phase: string, effectName: string, error: unknown) {
  operation.effectFailures.push({ phase, effectName, error })
  emitTelemetry(operation.services.telemetry, { name: "operation.effect.failure", severity: "error", timestamp: operation.services.clock.now(), attributes: explicitlySafeTelemetryAttributes({ operationId: operation.operationId, ...(operation.correlationId ? { correlationId: operation.correlationId } : {}), phase, effectName, errorType: error instanceof Error ? error.name : "unknown" }) })
}
