import { ConfigurationError, TimeoutError } from "../domain"
import { abortSignalError } from "../resilience/abortSignal"

import type { Clock } from "../kernel/clock"
export type { Clock } from "../kernel/clock"
export interface ExecutionDeadline { readonly expiresAt: Date }

/** Re-exported from the resilience layer, which owns it so foundation modules can use it too. */
export { abortSignalError } from "../resilience/abortSignal"

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
