import { ZodError } from "zod"
import { FrameworkCoreError, type FrameworkCoreErrorCode } from "core/domain"
import { InvalidJsonError, RequestBodyTooLargeError, UnsupportedMediaTypeError } from "./requestBody"

export function frameworkJson<T>(data: T, init: ResponseInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("content-type", "application/json; charset=utf-8")
  headers.set("cache-control", "no-store")
  return Response.json(data, { ...init, headers })
}

export interface FrameworkErrorHandlerOptions {
  reportError?: (error: unknown) => void
}

export type FrameworkResponseMetadata = { requestId: string; correlationId: string }

const MAX_ISSUE_PATH_LENGTH = 200
const MAX_ISSUE_MESSAGE_LENGTH = 300

function formatIssuePath(path: readonly (string | number | symbol)[]): string {
  const joined = path.map((segment) => String(segment)).join(".")
  return joined.length > MAX_ISSUE_PATH_LENGTH ? joined.slice(0, MAX_ISSUE_PATH_LENGTH) : joined
}

function defaultReportError(_error: unknown) {}

const HTTP_STATUS_BY_FRAMEWORK_CODE: Readonly<Record<FrameworkCoreErrorCode, number>> = Object.freeze({
  UNAUTHORIZED: 401, FORBIDDEN: 403, CAPABILITY_REQUIRED: 403,
  VALIDATION_ERROR: 400, BAD_REQUEST: 400,
  CONFLICT: 409, OPTIMISTIC_CONCURRENCY_FAILED: 409, STALE_CLAIM: 409,
  NOT_FOUND: 404, RATE_LIMIT_EXCEEDED: 429, RETRYABLE_PERSISTENCE_ERROR: 503,
  PERSISTENCE_ERROR: 500, RUNTIME_CAPABILITY_REQUIRED: 500, CONFIGURATION_ERROR: 500,
  INVALID_POLICY_CONFIGURATION: 500, AUDIT_SINK_MISSING: 500, AUDIT_ACTOR_MISSING: 500,
  OUTBOX_SINK_MISSING: 500, OPERATION_CONTEXT_INACTIVE: 500, EFFECT_REGISTRATION_CLOSED: 500,
  EFFECT_COLLECTOR_DISPOSED: 500, EFFECTS_ALREADY_DRAINED: 500,
  TIMEOUT: 504, UNAVAILABLE: 503, CANCELLED: 503,
})

export function frameworkErrorHttpStatus(code: FrameworkCoreErrorCode): number {
  return HTTP_STATUS_BY_FRAMEWORK_CODE[code]
}

/** Default Retry-After (seconds) for 503 responses without an explicit hint. */
export const DEFAULT_UNAVAILABLE_RETRY_AFTER_SECONDS = 1

function retryAfterHeader(error: FrameworkCoreError, status: number): Record<string, string> | undefined {
  const metadata = error.safeMetadata
  const ms = metadata.retryAfterMs
  const seconds = metadata.retryAfterSeconds
  const hint = typeof ms === "number" && Number.isFinite(ms) && ms >= 0
    ? Math.ceil(ms / 1000)
    : typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
      ? Math.ceil(seconds)
      : undefined
  if (hint !== undefined) return { "Retry-After": String(hint) }
  return status === 503 ? { "Retry-After": String(DEFAULT_UNAVAILABLE_RETRY_AFTER_SECONDS) } : undefined
}

export function createFrameworkErrorHandler(options: FrameworkErrorHandlerOptions = {}) {
  const { reportError = defaultReportError } = options
  return (error: unknown, metadata?: FrameworkResponseMetadata): Response => {
    const finish = (response: Response): Response => {
      if (metadata?.requestId) response.headers.set("x-request-id", metadata.requestId)
      if (metadata?.correlationId) response.headers.set("x-correlation-id", metadata.correlationId)
      return response
    }
    const json = <T>(data: T, init?: ResponseInit) => finish(frameworkJson(data, init))
    if (error instanceof InvalidJsonError) {
      return json({ error: "Invalid JSON body", code: error.code }, { status: 400 })
    }

    if (error instanceof RequestBodyTooLargeError) {
      return json({ error: "Request body is too large", code: error.code }, { status: 413 })
    }

    if (error instanceof UnsupportedMediaTypeError) {
      return json({ error: "Unsupported media type", code: error.code }, { status: 415 })
    }

    if (error instanceof FrameworkCoreError) {
      const status = frameworkErrorHttpStatus(error.code)
      if (status >= 500 || status === 401 || status === 403) reportError(error)
      const headers = status === 429 || status === 503 ? retryAfterHeader(error, status) : undefined
      return json({ error:error.safeMessage,code:error.publicCode }, { status,...(headers?{headers}:{}) })
    }

    if (error instanceof ZodError) {
      return json({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: error.issues.map((issue) => ({
          code: issue.code,
          path: formatIssuePath(issue.path),
          message: issue.message.slice(0, MAX_ISSUE_MESSAGE_LENGTH),
        })),
      }, { status: 400 })
    }

    reportError(error)
    return json({ error: "Internal Server Error", code: "INTERNAL_SERVER_ERROR" }, { status: 500 })
  }
}

export { InvalidJsonError, RequestBodyTooLargeError, UnsupportedMediaTypeError, parseJsonBodySafely } from "./requestBody"
