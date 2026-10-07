import { CancelledError, TimeoutError } from "../domain/errors"

/**
 * The framework error for an aborted signal. A reason that already is a
 * framework CancelledError or TimeoutError is returned unchanged (e.g. a
 * dispatcher aborting work at its deadline). A platform timeout reason (an
 * Error or DOMException named "TimeoutError", as from `AbortSignal.timeout`)
 * becomes a TimeoutError; any other reason becomes a CancelledError. The
 * original reason is kept as the `cause`.
 */
export function abortSignalError(signal: AbortSignal, message = "The operation was cancelled"): CancelledError | TimeoutError {
  const reason: unknown = signal.reason
  if (reason instanceof CancelledError || reason instanceof TimeoutError) return reason
  if (isPlatformTimeout(reason)) return new TimeoutError("The operation timed out", reason)
  const error = new CancelledError(message, reason instanceof Error ? reason : undefined)
  if (reason !== undefined && !(reason instanceof Error)) Object.defineProperty(error, "cause", { value: reason, writable: true, configurable: true, enumerable: false })
  return error
}

function isPlatformTimeout(reason: unknown): reason is Error {
  return (reason instanceof Error || (typeof DOMException !== "undefined" && reason instanceof DOMException)) && reason.name === "TimeoutError"
}
