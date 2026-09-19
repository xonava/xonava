import { ConfigurationError } from "../domain"

export interface Clock { now(): Date }
export interface ExecutionDeadline { readonly expiresAt: Date }

export function assertExecutionActive(signal: AbortSignal, deadline: ExecutionDeadline, clock: Clock): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("operation aborted", "AbortError")
  const now = clock.now().getTime()
  const expiresAt = deadline.expiresAt.getTime()
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) throw new ConfigurationError("Execution clock and deadline must be valid dates")
  if (now >= expiresAt) throw new DOMException("operation deadline exceeded", "TimeoutError")
}

export function createExecutionDeadline(expiresAt: Date): ExecutionDeadline {
  if (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) throw new ConfigurationError("Execution deadline must be a valid Date")
  const timestamp = expiresAt.getTime()
  return Object.freeze({ get expiresAt() { return new Date(timestamp) } })
}
