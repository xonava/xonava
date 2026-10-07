import type { InternalOperationRunContext } from "./operationRunContext"
import { emitTelemetry, explicitlySafeTelemetryAttributes } from "../telemetry/telemetry"

/** A best-effort post-commit effect failed after the operation's business commit. */
export interface CommittedEffectFailure {
  readonly operationId: string
  readonly correlationId?: string
  /** onBusinessResult | afterCommit | bestEffort | after */
  readonly phase: string
  readonly effectName: string
  readonly errorType: string
  readonly error: unknown
}

export type CommittedEffectFailureHandler = (failure: CommittedEffectFailure) => void | Promise<void>

/** Bound on retained failure records per operation; telemetry still sees every failure. */
export const MAX_RECORDED_EFFECT_FAILURES = 100

/**
 * Records a post-commit effect failure without ever throwing: it is retained
 * (bounded) for runOperationDetailed, emitted as telemetry, and passed to the
 * application's onCommittedEffectFailure handler, whose own failures are
 * swallowed so observability can never change a committed outcome.
 */
export function reportCommittedEffectFailure(operation: InternalOperationRunContext, phase: string, effectName: string, error: unknown): void {
  const errorType = error instanceof Error ? error.name : "unknown"
  if (operation.effectFailures.length < MAX_RECORDED_EFFECT_FAILURES) operation.effectFailures.push({ phase, effectName, error })
  try {
    emitTelemetry(operation.services.telemetry, { name: "operation.effect.failure", severity: "error", timestamp: operation.services.clock.now(), attributes: explicitlySafeTelemetryAttributes({ operationId: operation.operationId, ...(operation.correlationId ? { correlationId: operation.correlationId } : {}), phase, effectName, errorType: errorType.slice(0, 128) }) })
  } catch {
    // Telemetry is observational only.
  }
  const handler = operation.onCommittedEffectFailure
  if (typeof handler !== "function") return
  try {
    const pending = handler(Object.freeze({ operationId: operation.operationId, ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}), phase, effectName, errorType, error }))
    if (pending && typeof (pending).catch === "function") void (pending).catch(() => undefined)
  } catch {
    // A failing handler must not alter the committed result.
  }
}
