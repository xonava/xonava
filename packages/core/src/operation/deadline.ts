import { CancelledError, ConfigurationError, TimeoutError } from "../domain"

import type { Clock } from "../kernel/clock"
export type { Clock } from "../kernel/clock"
export interface ExecutionDeadline { readonly expiresAt: Date }

/**
 * The framework error for an aborted signal. A reason that already is a
 * framework CancelledError or TimeoutError is returned unchanged (e.g. a
 * dispatcher aborting work at its deadline); any other reason becomes a
 * CancelledError that keeps the original reason as its `cause`.
 */
export function abortSignalError(signal: AbortSignal, message = "The operation was cancelled"): CancelledError | TimeoutError {
  const reason: unknown = signal.reason
  if (reason instanceof CancelledError || reason instanceof TimeoutError) return reason
  const error = new CancelledError(message, reason instanceof Error ? reason : undefined)
  if (reason !== undefined && !(reason instanceof Error)) Object.defineProperty(error, "cause", { value: reason, writable: true, configurable: true, enumerable: false })
  return error
}

/** Throws CancelledError when `signal` is aborted and TimeoutError once `deadline` has passed. */
export function assertExecutionActive(signal: AbortSignal, deadline: ExecutionDeadline, clock: Clock): void {
  if (signal.aborted) throw abortSignalError(signal)
  const now = clock.now().getTime()
  const expiresAt = deadline.expiresAt.getTime()
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) throw new ConfigurationError("Execution clock and deadline must be valid dates")
  if (now >= expiresAt) throw new TimeoutError("operation deadline exceeded")
}

export function createExecutionDeadline(expiresAt: Date): ExecutionDeadline {
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) throw new ConfigurationError("Execution deadline must be a valid Date")
  const timestamp = expiresAt.getTime()
  return Object.freeze({ get expiresAt() { return new Date(timestamp) } })
}
