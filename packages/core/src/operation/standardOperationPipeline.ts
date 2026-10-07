import { runAfterHooks, runBeforeHooks } from "./hooks"
import { assertRequestBoundToOperation, createOperationRunContext, createPostCommitOperationContext, createReadOperationContext, createMutationOperationContext, createRetryableOperationContext, createRepresentationContext, createAuthorizationOperationContext, createPreparationOperationContext, type AuthorizationOperationContext, type PostCommitContext } from "./operationContext"
import type { InternalOperationRunContext } from "./operationRunContext"
import { runAfterCommitHooks } from "./hooks"
import { classifyAuditValue, defaultAuditSanitizer, type AuditRecord } from "../events/durability/audit"
import type { InteractiveTransactionProvider } from "../persistence/provider"
import { supportsInteractiveTransactions } from "../persistence/provider"
import { AuditActorMissingError, AuditSinkMissingError, ConfigurationError, OutboxSinkMissingError, RetryablePersistenceError, TransactionRolledBackError } from "../domain"
import type { StandardOperationDefinition, StandardAtomicityMode, RetryableTransactionExecution, RetryableMutationOperationDefinition } from "./operationDefinition"
import { requireRuntimeCapability } from "../bootstrap/runtimeCapabilities"
import { runAtomicBatchOperation } from "./atomicBatchOperationPipeline"
import { assertExecutionActive } from "./deadline"
import { applyAuthorizationPlanToResult, authorizeOperation, createPlanConstrainedPersistenceProvider, revalidateAuthorizationFacts } from "./authorizationPlanEnforcement"
import { emitTelemetry, explicitlySafeTelemetryAttributes } from "../telemetry/telemetry"
import { reportCommittedEffectFailure } from "./committedEffectFailure"

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
      operation.dispose()
      throw error
    }
  }

  const finish = async (transactionOperation: InternalOperationRunContext, input: TInput, result: TResult, pendingEffects: { bestEffortEffects: { name: string; execute: (operation?: PostCommitContext) => Promise<void> }[] }, onBusinessResult?: (result: TResult, operation: PostCommitContext) => Promise<void>): Promise<TResult> => {
    const operation = transactionOperation
    const postCommitContext = createPostCommitOperationContext(operation)
    for (const effect of pendingEffects.bestEffortEffects) operation.addBestEffortEffect(effect.name, effect.execute)
    // The business transaction has committed. Post-commit work is best-effort
    // by contract: its failures never turn a committed operation into an
    // error (a caller would retry and duplicate the mutation). They are
    // reported through telemetry, onCommittedEffectFailure, and
    // runOperationDetailed instead. Correctness-critical work uses the outbox.
    try {
      try {
        await onBusinessResult?.(result, postCommitContext)
      } catch (error) {
        reportCommittedEffectFailure(operation, "onBusinessResult", "business-result", error)
      }
      for (const hook of asArray(args.definition.afterCommit)) {
        try {
          await runAfterCommitHooks({ operation: postCommitContext, input, result, hooks: hook })
        } catch (error) {
          reportCommittedEffectFailure(operation, "afterCommit", "hooks", error)
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

async function runTransactionWithRetry<TInput, TResult>(args: {
  provider: InteractiveTransactionProvider
  operation: InternalOperationRunContext
  definition: ExecutableStandardOperationDefinition<TInput, TResult>
  input: TInput
  run: (operation: InternalOperationRunContext) => Promise<{ input: TInput; result: TResult; operation: InternalOperationRunContext }>
  retryPolicy?: RetryableTransactionExecution
  transactionOptions?: import("../persistence/provider").TransactionOptions
}): Promise<{ operation: InternalOperationRunContext; result: { input: TInput; result: TResult; operation: InternalOperationRunContext } }> {
  // Transaction retry safety (P1-07, revised).
  //
  // A retry re-runs the whole transaction callback with a fresh effect
  // collector. It is safe exactly when the failed attempt is known not to have
  // committed:
  // - the callback itself threw: the provider rolls the transaction back, and
  //   with it every outbox record, audit row, and commit marker it wrote; or
  // - the provider reports TransactionRolledBackError at COMMIT.
  // Any other provider error after the callback returned has an unknown commit
  // outcome and is never retried.
  //
  // No framework-registered effect can escape a rolled-back attempt: the
  // retryable execute context exposes no effect registration, and best-effort
  // effects only run after commit. External calls made directly by user code
  // are the operation author's responsibility, which is why retry is opt-in.
  const maxAttempts = args.retryPolicy?.maxAttempts ?? 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let callbackFailed = false
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
          return { operation, result: await args.run(operation) }
        } catch (error) {
          callbackFailed = true
          throw error
        }
      }, args.definition.kind === "read"
        ? { ...args.transactionOptions, accessMode: "read only" }
        : args.transactionOptions)
    } catch (error) {
      attemptContext.dispose()
      const rolledBack = callbackFailed || error instanceof TransactionRolledBackError
      if (!rolledBack || !(error instanceof RetryablePersistenceError) || attempt >= maxAttempts) throw error
      await waitBeforeRetry(args.operation, args.retryPolicy!, attempt, error)
    }
  }
  throw new ConfigurationError(`Transaction retry policy for ${args.definition.key} produced no attempt.`)
}

/**
 * Jittered exponential backoff that never outlives the operation: it aborts
 * with the operation signal and gives up (rethrowing the last error) when the
 * delay would cross the execution deadline. Timers and listeners are always
 * released.
 */
async function waitBeforeRetry(operation: InternalOperationRunContext, policy: RetryableTransactionExecution, failedAttempt: number, lastError: unknown): Promise<void> {
  const base = Math.min(policy.maxDelay, policy.delay * Math.pow(policy.backoff, Math.min(failedAttempt - 1, 64)))
  const delayMs = Math.max(0, Math.floor(base / 2 + (Math.random() * base) / 2))
  const signal = operation.signal
  if (signal.aborted) throw signal.reason ?? lastError
  const remaining = operation.deadline.expiresAt.getTime() - operation.services.clock.now().getTime()
  if (!Number.isFinite(remaining) || remaining <= delayMs) throw lastError
  if (delayMs === 0) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { clearTimeout(timer); reject(signal.reason ?? lastError) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve() }, delayMs)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}
