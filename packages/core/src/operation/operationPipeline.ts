import { createOperationRunContext, type OperationEnvironment, type PostCommitContext } from "./operationContext"
import { OperationCommittedEffectError, runAtomicBatchOperation } from "./atomicBatchOperationPipeline"
import { runStandardOperation, type NestedInvokeFactory } from "./standardOperationPipeline"
import type { AtomicBatchOperationDefinition, OperationDefinition } from "./operationDefinition"
import type { InternalOperationRunContext } from "./operationRunContext"
import { validateOperationDefinition } from "./validateOperationDefinition"
import { emitTelemetry, explicitlySafeTelemetryAttributes } from "../telemetry/telemetry"
import { ConfigurationError, FrameworkCoreError } from "../domain/errors"
import { assertExecutionActive } from "./deadline"

export type { OperationDefinition, StandardAtomicity, StandardAtomicityMode, AtomicBatchAtomicity, OperationAtomicity, OperationKind, StandardOperationDefinition, StandardReadOperationDefinition, StandardMutationOperationDefinition, AtomicBatchOperationDefinition, OperationAuditConfig, OperationAuthorizationPort } from "./operationDefinition"
export type { AuditGuarantee } from "./operationDefinition"

export interface OperationWarning {
  readonly message: string
  readonly phase?: string
  readonly effectName?: string
}

export interface OperationOutcome<TResult> {
  readonly result: TResult
  readonly operationId: string
  readonly correlationId?: string
  readonly committed: boolean
  readonly warnings: readonly OperationWarning[]
  readonly postCommitEffectFailures?: readonly OperationWarning[]
}

export async function runOperation<TInput, TResult, TCommand = unknown>(args: {
  operation: OperationEnvironment
  definition: OperationDefinition<TInput, TResult, TCommand>
  input: TInput
  onBusinessResult?: (result: TResult, operation: PostCommitContext) => Promise<void>
}): Promise<TResult> {
  const execution = await executeValidatedOperation<TInput, TResult, TCommand>({ ...args, definition: validateOperationDefinition(args.definition) })
  return execution.result
}

export async function runOperationDetailed<TInput, TResult, TCommand = unknown>(args: {
  operation: OperationEnvironment
  definition: OperationDefinition<TInput, TResult, TCommand>
  input: TInput
  onBusinessResult?: (result: TResult, operation: PostCommitContext) => Promise<void>
}): Promise<OperationOutcome<TResult>> {
  try {
    const result = await executeValidatedOperation<TInput, TResult, TCommand>({ ...args, definition: validateOperationDefinition(args.definition) })
    const operationId = result.operation.operationId
    const failures = result.operation.request?.metadata?._effectFailures
    const metadataFailures = Array.isArray(failures) ? failures : []
    const postCommitEffectFailures = [...metadataFailures, ...result.operation.effectFailures]
      .map((failure) => {
        const entry = failure as Record<string, unknown>
        return {
          // eslint-disable-next-line @typescript-eslint/no-base-to-string -- intentional fallback to string coercion
          message: String(entry.error ?? "Post-commit effect failed"),
          ...(typeof entry.phase === "string" ? { phase: entry.phase } : {}),
          ...(typeof entry.effectName === "string" ? { effectName: entry.effectName } : {}),
        }
      })
    const outcome = result.operation.correlationId === undefined
      ? { result: result.result, operationId, committed: result.committed, warnings: [] as OperationWarning[] }
      : { result: result.result, operationId, correlationId: result.operation.correlationId, committed: result.committed, warnings: [] as OperationWarning[] }
    return postCommitEffectFailures.length ? { ...outcome, postCommitEffectFailures } : outcome
  } catch (error) {
    if (error instanceof OperationCommittedEffectError) {
      const postCommitEffectFailures: OperationWarning[] = error.failures.map((failure) => ({
         
        message: String(failure instanceof Error ? failure.message : failure),
      }))
      const outcome = error.correlationId === undefined
        ? { result: error.result as TResult, operationId: error.operationId ?? "", committed: true, warnings: [] as OperationWarning[] }
        : { result: error.result as TResult, operationId: error.operationId ?? "", correlationId: error.correlationId, committed: true, warnings: [] as OperationWarning[] }
      return { ...outcome, postCommitEffectFailures }
    }
    throw error
  }
}

async function executeValidatedOperation<TInput, TResult, TCommand>(args: {
  operation: OperationEnvironment
  definition: OperationDefinition<TInput, TResult, TCommand>
  input: TInput
  onBusinessResult?: (result: TResult, operation: PostCommitContext) => Promise<void>
  nested?: { readonly parent: InternalOperationRunContext; readonly joinTransaction: boolean }
}): Promise<{ result: TResult; operation: InternalOperationRunContext; committed: boolean }> {
  const committed = true
  const parent = args.nested?.parent
  const operation = createOperationRunContext(args.operation, {
    ...(parent?.correlationId !== undefined ? { correlationId: parent.correlationId } : {}),
    // Post-commit failures of a child are failures of the whole operation.
    ...(parent !== undefined ? { effectFailures: parent.effectFailures } : {}),
  })
  const joinedParent = args.nested?.joinTransaction === true ? parent : undefined
  const startedAt = safeNow(operation)
  try {
    if (joinedParent && isAtomicBatchDefinition(args.definition)) throw new ConfigurationError(`Atomic-batch operation ${args.definition.key} cannot run inside another operation's transaction.`)
    const result = isAtomicBatchDefinition(args.definition)
      ? await runAtomicBatchOperation({ operation, definition: args.definition, input: args.input, ...(args.onBusinessResult ? { onBusinessResult: args.onBusinessResult } : {}) })
      : await runStandardOperation({ operation, definition: args.definition, input: args.input, createNestedInvoke, ...(joinedParent ? { joinedParent } : {}), ...(args.onBusinessResult ? { onBusinessResult: args.onBusinessResult } : {}) })
    emitCompleted(operation, args.definition, startedAt, operation.effectFailures.length > 0 ? "committed_with_effect_failures" : "success")
    return { result, operation, committed }
  } catch (error) {
    emitCompleted(operation, args.definition, startedAt, error instanceof OperationCommittedEffectError ? "committed_with_effect_failures" : "error", error)
    throw error
  }
}

/**
 * The child runs on the parent's unconstrained (transaction-scoped)
 * persistence and authorizes itself: it acts with the request's identity, not
 * with the parent's authorization plan. Commit markers stay with the parent.
 */
const createNestedInvoke: NestedInvokeFactory = (parent, options) => async (definition, input) => {
  if (parent.isDisposed) throw new ConfigurationError("Nested operations cannot start after the parent operation has finished.")
  const nestingDepth = parent.nestingDepth + 1
  if (nestingDepth > parent.executionBudget.maxNestingDepth) throw new ConfigurationError(`Operation nesting depth exceeds ${parent.executionBudget.maxNestingDepth}`)
  assertExecutionActive(parent.signal, parent.deadline, parent.services.clock)
  const validated = validateOperationDefinition(definition)
  if (options.readOnly && validated.kind !== "read") throw new ConfigurationError(`Read operation cannot invoke ${validated.kind ?? "unknown"} operation ${validated.key}.`)
  const execution = await executeValidatedOperation({
    operation: childEnvironment(parent, nestingDepth),
    definition: validated,
    input,
    nested: { parent, joinTransaction: options.joinTransaction },
  })
  return execution.result
}

function childEnvironment(parent: InternalOperationRunContext, nestingDepth: number): OperationEnvironment {
  return {
    persistence: parent.persistence,
    runtimeCapabilities: parent.runtimeCapabilities,
    ...(parent.request !== undefined ? { request: parent.request } : {}),
    services: parent.services,
    signal: parent.signal,
    deadline: parent.deadline,
    executionBudget: parent.executionBudget,
    nestingDepth,
    ...(parent.auditSink !== undefined ? { auditSink: parent.auditSink } : {}),
    ...(parent.auditSanitizer !== undefined ? { auditSanitizer: parent.auditSanitizer } : {}),
    ...(parent.enforceAbac !== undefined ? { enforceAbac: parent.enforceAbac } : {}),
    ...(parent.authorizationFactRevalidator !== undefined ? { authorizationFactRevalidator: parent.authorizationFactRevalidator } : {}),
    ...(parent.auditSinkFactory !== undefined ? { auditSinkFactory: parent.auditSinkFactory } : {}),
    ...(parent.outboxSinkFactory !== undefined ? { outboxSinkFactory: parent.outboxSinkFactory } : {}),
    ...(parent.maskingKey !== undefined ? { maskingKey: parent.maskingKey } : {}),
    ...(parent.onCommittedEffectFailure !== undefined ? { onCommittedEffectFailure: parent.onCommittedEffectFailure } : {}),
  }
}

function safeNow(operation: InternalOperationRunContext): number {
  try { return operation.services.clock.now().getTime() } catch { return Number.NaN }
}

/** One `operation.completed` event per run: the core latency/outcome signal. Never throws. */
function emitCompleted(operation: InternalOperationRunContext, definition: { readonly key: string; readonly kind?: string }, startedAt: number, outcome: "success" | "committed_with_effect_failures" | "error", error?: unknown): void {
  try {
    const durationMs = Math.max(0, safeNow(operation) - startedAt)
    const errorCode = error instanceof FrameworkCoreError ? error.code : error instanceof Error ? error.name : error === undefined ? undefined : "unknown"
    emitTelemetry(operation.services.telemetry, {
      name: "operation.completed",
      severity: outcome === "error" ? "warn" : "info",
      timestamp: operation.services.clock.now(),
      attributes: explicitlySafeTelemetryAttributes({
        operationKey: definition.key.slice(0, 256),
        operationKind: definition.kind ?? "read",
        operationId: operation.operationId,
        outcome,
        ...(Number.isFinite(durationMs) ? { durationMs } : {}),
        ...(errorCode !== undefined ? { errorCode: errorCode.slice(0, 128) } : {}),
        ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId.slice(0, 256) } : {}),
      }),
    })
  } catch {
    // Telemetry is observational and must never alter operation semantics.
  }
}

function isAtomicBatchDefinition<TInput, TResult, TCommand>(
  definition: OperationDefinition<TInput, TResult, TCommand>,
): definition is AtomicBatchOperationDefinition<TInput, TResult, TCommand> {
  return definition.atomicity?.kind === "atomic-batch"
}
