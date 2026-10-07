import { createOperationRunContext, type OperationEnvironment, type PostCommitContext } from "./operationContext"
import { OperationCommittedEffectError, runAtomicBatchOperation } from "./atomicBatchOperationPipeline"
import { runStandardOperation } from "./standardOperationPipeline"
import type { AtomicBatchOperationDefinition, OperationDefinition } from "./operationDefinition"
import type { InternalOperationRunContext } from "./operationRunContext"
import { validateOperationDefinition } from "./validateOperationDefinition"
import { emitTelemetry, explicitlySafeTelemetryAttributes } from "../telemetry/telemetry"
import { FrameworkCoreError } from "../domain/errors"

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
}): Promise<{ result: TResult; operation: InternalOperationRunContext; committed: boolean }> {
  const committed = true
  const operation = createOperationRunContext(args.operation)
  const startedAt = safeNow(operation)
  try {
    const result = isAtomicBatchDefinition(args.definition)
      ? await runAtomicBatchOperation({ operation, definition: args.definition, input: args.input, ...(args.onBusinessResult ? { onBusinessResult: args.onBusinessResult } : {}) })
      : await runStandardOperation({ operation, definition: args.definition, input: args.input, ...(args.onBusinessResult ? { onBusinessResult: args.onBusinessResult } : {}) })
    emitCompleted(operation, args.definition, startedAt, operation.effectFailures.length > 0 ? "committed_with_effect_failures" : "success")
    return { result, operation, committed }
  } catch (error) {
    emitCompleted(operation, args.definition, startedAt, error instanceof OperationCommittedEffectError ? "committed_with_effect_failures" : "error", error)
    throw error
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
