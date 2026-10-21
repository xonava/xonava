export type FrameworkCoreErrorCode =
  | "FORBIDDEN"
  | "CONFLICT"
  | "RETRYABLE_PERSISTENCE_ERROR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "CAPABILITY_REQUIRED"
  | "RUNTIME_CAPABILITY_REQUIRED"
  | "VALIDATION_ERROR"
  | "BAD_REQUEST"
  | "AUDIT_SINK_MISSING"
  | "AUDIT_ACTOR_MISSING"
  | "OUTBOX_SINK_MISSING"
  | "RATE_LIMIT_EXCEEDED"
  | "CONFIGURATION_ERROR"
  | "INVALID_POLICY_CONFIGURATION"
  | "OPTIMISTIC_CONCURRENCY_FAILED"
  | "OPERATION_CONTEXT_INACTIVE"
  | "EFFECT_REGISTRATION_CLOSED"
  | "EFFECT_COLLECTOR_DISPOSED"
  | "EFFECTS_ALREADY_DRAINED"
  | "STALE_CLAIM"
  | "PERSISTENCE_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "UNAVAILABLE"
  | "REQUIRED_HEADER_MISSING"
  | "PRECONDITION_REQUIRED"

export type FrameworkErrorCategory = "authentication" | "authorization" | "validation" | "conflict" | "not-found" | "rate-limit" | "configuration" | "dependency" | "internal"
export type SafeErrorMetadata = Readonly<Record<string, string | number | boolean>>
interface ErrorDefaults { readonly safeMessage: string; readonly retryable: boolean; readonly category: FrameworkErrorCategory; readonly publicCode: string }

const internalConfiguration: ErrorDefaults = { safeMessage: "Internal Server Error", retryable: false, category: "configuration", publicCode: "INTERNAL_SERVER_ERROR" }
const internalState: ErrorDefaults = { safeMessage: "Internal Server Error", retryable: false, category: "internal", publicCode: "INTERNAL_SERVER_ERROR" }

/** Language-neutral error taxonomy: code -> public message, retryability, category, and public code. */
const ERROR_DEFAULTS: Readonly<Record<FrameworkCoreErrorCode, ErrorDefaults>> = Object.freeze({
  UNAUTHORIZED: { safeMessage: "Unauthorized", retryable: false, category: "authentication", publicCode: "UNAUTHORIZED" },
  FORBIDDEN: { safeMessage: "Forbidden", retryable: false, category: "authorization", publicCode: "FORBIDDEN" },
  CAPABILITY_REQUIRED: { safeMessage: "Forbidden", retryable: false, category: "authorization", publicCode: "CAPABILITY_REQUIRED" },
  VALIDATION_ERROR: { safeMessage: "Validation failed", retryable: false, category: "validation", publicCode: "VALIDATION_ERROR" },
  BAD_REQUEST: { safeMessage: "Business rule violation", retryable: false, category: "validation", publicCode: "BAD_REQUEST" },
  CONFLICT: { safeMessage: "Conflict", retryable: false, category: "conflict", publicCode: "CONFLICT" },
  OPTIMISTIC_CONCURRENCY_FAILED: { safeMessage: "Conflict", retryable: false, category: "conflict", publicCode: "OPTIMISTIC_CONCURRENCY_FAILED" },
  STALE_CLAIM: { safeMessage: "Conflict", retryable: false, category: "conflict", publicCode: "STALE_CLAIM" },
  REQUIRED_HEADER_MISSING: { safeMessage: "A required request header is missing", retryable: false, category: "validation", publicCode: "REQUIRED_HEADER_MISSING" },
  PRECONDITION_REQUIRED: { safeMessage: "A precondition header is required", retryable: false, category: "validation", publicCode: "PRECONDITION_REQUIRED" },
  NOT_FOUND: { safeMessage: "Not found", retryable: false, category: "not-found", publicCode: "NOT_FOUND" },
  RATE_LIMIT_EXCEEDED: { safeMessage: "Rate limit exceeded", retryable: true, category: "rate-limit", publicCode: "RATE_LIMIT_EXCEEDED" },
  RETRYABLE_PERSISTENCE_ERROR: { safeMessage: "Service temporarily unavailable", retryable: true, category: "dependency", publicCode: "SERVICE_UNAVAILABLE" },
  UNAVAILABLE: { safeMessage: "Service temporarily unavailable", retryable: true, category: "dependency", publicCode: "SERVICE_UNAVAILABLE" },
  TIMEOUT: { safeMessage: "The operation timed out", retryable: true, category: "dependency", publicCode: "TIMEOUT" },
  CANCELLED: { safeMessage: "The operation was cancelled", retryable: false, category: "internal", publicCode: "CANCELLED" },
  PERSISTENCE_ERROR: { safeMessage: "Internal Server Error", retryable: false, category: "dependency", publicCode: "INTERNAL_SERVER_ERROR" },
  RUNTIME_CAPABILITY_REQUIRED: internalConfiguration,
  CONFIGURATION_ERROR: internalConfiguration,
  INVALID_POLICY_CONFIGURATION: internalConfiguration,
  AUDIT_SINK_MISSING: internalConfiguration,
  AUDIT_ACTOR_MISSING: internalConfiguration,
  OUTBOX_SINK_MISSING: internalConfiguration,
  OPERATION_CONTEXT_INACTIVE: internalState,
  EFFECT_REGISTRATION_CLOSED: internalState,
  EFFECT_COLLECTOR_DISPOSED: internalState,
  EFFECTS_ALREADY_DRAINED: internalState,
})

export interface FrameworkErrorOptions {
  /** Underlying error. When omitted and `details` is an Error, it becomes the cause. */
  readonly cause?: unknown
}

export class FrameworkCoreError extends Error {
  public readonly code: FrameworkCoreErrorCode
  public readonly details?: unknown
  public readonly safeMessage: string
  public readonly retryable: boolean
  public readonly category: FrameworkErrorCategory
  public readonly safeMetadata: SafeErrorMetadata
  public readonly publicCode: string

  constructor(message: string, code: FrameworkCoreErrorCode, details?: unknown, safeMetadata: SafeErrorMetadata = {}, options: FrameworkErrorOptions = {}) {
    const cause = options.cause !== undefined ? options.cause : details instanceof Error ? details : undefined
    super(message, cause === undefined ? undefined : { cause })
    this.name = this.constructor.name
    // An unknown code (from untyped callers) degrades to an internal error
    // rather than crashing while the original error is being reported.
    const known = Object.hasOwn(ERROR_DEFAULTS, code)
    this.code = known ? code : "CONFIGURATION_ERROR"
    // Details may hold sensitive input; keep them off JSON/structured-clone output.
    Object.defineProperty(this, "details", { value: details, enumerable: false, writable: false, configurable: false })
    const defaults = ERROR_DEFAULTS[this.code]
    this.safeMessage = defaults.safeMessage
    this.retryable = defaults.retryable
    this.category = defaults.category
    this.safeMetadata = Object.freeze({ ...safeMetadata })
    this.publicCode = defaults.publicCode
  }
}

function assertSafeHeaderName(header: string): void {
  if (typeof header !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(header)) throw new ConfigurationError("Header name is invalid")
}

/** A required request header (for example `Idempotency-Key`) was not supplied. Public metadata carries the header name. */
export class RequiredHeaderMissingError extends FrameworkCoreError {
  constructor(header: string) {
    assertSafeHeaderName(header)
    super(`${header} header is required`, "REQUIRED_HEADER_MISSING", undefined, { header })
  }
}

/** A precondition header (for example `If-Match`) is required but was not supplied. Public metadata carries the header name. */
export class PreconditionRequiredError extends FrameworkCoreError {
  constructor(header: string) {
    assertSafeHeaderName(header)
    super(`${header} header is required`, "PRECONDITION_REQUIRED", undefined, { header })
  }
}

/** A deadline elapsed before the work completed. The work's outcome may be unknown. */
export class TimeoutError extends FrameworkCoreError {
  constructor(message: string = "The operation timed out", details?: unknown) {
    super(message, "TIMEOUT", details)
  }
}

/** The work was cancelled by its caller or by shutdown before it completed. */
export class CancelledError extends FrameworkCoreError {
  constructor(message: string = "The operation was cancelled", details?: unknown) {
    super(message, "CANCELLED", details)
  }
}

/** A dependency is temporarily unavailable; the request may be retried later. */
export class UnavailableError extends FrameworkCoreError {
  constructor(message: string = "Service temporarily unavailable", details?: unknown) {
    super(message, "UNAVAILABLE", details)
  }
}

export class ForbiddenError extends FrameworkCoreError {
  constructor(message: string = "Forbidden", details?: unknown) {
    super(message, "FORBIDDEN", details)
  }
}

export class UnauthorizedError extends FrameworkCoreError {
  constructor(message: string = "Unauthorized", details?: unknown) {
    super(message, "UNAUTHORIZED", details)
  }
}

export class ConflictError extends FrameworkCoreError {
  constructor(message: string = "Conflict", details?: unknown) {
    super(message, "CONFLICT", details)
  }
}

export class StaleClaimError extends FrameworkCoreError {
  constructor(message: string = "Claim token is stale or its lease has expired", details?: unknown) {
    super(message, "STALE_CLAIM", details)
  }
}

export class RetryablePersistenceError extends FrameworkCoreError {
  readonly kind = "retryable" as const

  constructor(message: string = "A transient persistence failure occurred", details?: unknown) {
    super(message, "RETRYABLE_PERSISTENCE_ERROR", details)
  }
}

/**
 * The provider guarantees the transaction did not commit (for example a
 * serialization failure or deadlock reported at COMMIT). Unlike an unknown
 * commit outcome, the whole transaction may safely be re-run.
 */
export class TransactionRolledBackError extends RetryablePersistenceError {
  constructor(message: string = "The transaction was rolled back by the database", details?: unknown) {
    super(message, details)
  }
}

export class NotFoundError extends FrameworkCoreError {
  constructor(message: string = "Not found", details?: unknown) {
    super(message, "NOT_FOUND", details)
  }
}

export class CapabilityError extends FrameworkCoreError {
  constructor(message: string = "Required capability is not available", details?: unknown) {
    super(message, "CAPABILITY_REQUIRED", details)
  }
}

export class RuntimeCapabilityError extends FrameworkCoreError {
  constructor(message: string = "Required runtime capability is not available", details?: unknown) {
    super(message, "RUNTIME_CAPABILITY_REQUIRED", details)
  }
}

export class ValidationError extends FrameworkCoreError {
  constructor(message: string = "Validation error", details?: unknown) {
    super(message, "VALIDATION_ERROR", details)
  }
}

export class BusinessRuleError extends FrameworkCoreError {
  constructor(message: string = "Business rule violation", details?: unknown) {
    super(message, "BAD_REQUEST", details)
  }
}

const PUBLIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/
/** Codes transports answer with before an operation runs; an application code must not collide with them. */
const TRANSPORT_RESERVED_PUBLIC_CODES: ReadonlySet<string> = new Set(["INVALID_JSON", "REQUEST_BODY_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "BODY_NOT_ACCEPTED"])
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

export interface PublicBusinessErrorInput {
  /** Stable machine-readable code, `^[A-Z][A-Z0-9_]{2,63}$`, distinct from every registry code. */
  readonly publicCode: string
  /** Application-authored message that is safe to show to the caller (1-200 characters, no control characters). */
  readonly publicMessage: string
  /** Names of the request fields the caller should correct (at most 20, each 1-200 characters). */
  readonly fields?: readonly string[]
}

/**
 * A business-rule failure whose code and message are authored by the application and are safe to expose.
 * Never use it for authentication or authorization failures; 401, 403 and 404 stay fixed.
 */
export class PublicBusinessError extends BusinessRuleError {
  readonly fields: readonly string[]

  constructor(input: PublicBusinessErrorInput, details?: unknown) {
    const { publicCode, publicMessage, fields = [] } = input ?? ({} as PublicBusinessErrorInput)
    if (typeof publicCode !== "string" || !PUBLIC_CODE_PATTERN.test(publicCode)) throw new ConfigurationError("publicCode must match /^[A-Z][A-Z0-9_]{2,63}$/")
    if (Object.hasOwn(ERROR_DEFAULTS, publicCode) || Object.values(ERROR_DEFAULTS).some((d) => d.publicCode === publicCode) || TRANSPORT_RESERVED_PUBLIC_CODES.has(publicCode))
      throw new ConfigurationError("publicCode must not equal a framework error code")
    if (typeof publicMessage !== "string" || publicMessage.length < 1 || publicMessage.length > 200 || CONTROL_CHARACTERS.test(publicMessage))
      throw new ConfigurationError("publicMessage must be 1-200 characters without control characters")
    if (!Array.isArray(fields) || fields.length > 20 || fields.some((f) => typeof f !== "string" || f.length < 1 || f.length > 200))
      throw new ConfigurationError("fields must have at most 20 entries of 1-200 characters")
    super(publicMessage, details)
    // The base constructor assigns the registry values; override with the validated application values.
    Object.defineProperty(this, "safeMessage", { value: publicMessage, enumerable: true, writable: false, configurable: false })
    Object.defineProperty(this, "publicCode", { value: publicCode, enumerable: true, writable: false, configurable: false })
    this.fields = Object.freeze([...fields])
  }
}

export class RateLimitError extends FrameworkCoreError {
  public readonly retryAfterMs: number

  constructor(retryAfterMs: number) {
    super("Rate limit exceeded", "RATE_LIMIT_EXCEEDED", { retryAfterMs }, { retryAfterMs })
    this.retryAfterMs = retryAfterMs
  }
}

export class PersistenceError extends FrameworkCoreError {
  constructor(message:string="Persistence operation failed",details?:unknown){super(message,"PERSISTENCE_ERROR",details)}
}

export class AuditSinkMissingError extends FrameworkCoreError {
  constructor(message: string = "Audit sink is required but missing", details?: unknown) {
    super(message, "AUDIT_SINK_MISSING", details)
  }
}

export class AuditActorMissingError extends FrameworkCoreError {
  constructor(message: string = "Audit actor is required but missing", details?: unknown) {
    super(message, "AUDIT_ACTOR_MISSING", details)
  }
}

export class OutboxSinkMissingError extends FrameworkCoreError {
  constructor(message: string = "Outbox sink is required but missing", details?: unknown) {
    super(message, "OUTBOX_SINK_MISSING", details)
  }
}

export class ConfigurationError extends FrameworkCoreError {
  constructor(message: string = "Configuration error", details?: unknown) {
    super(message, "CONFIGURATION_ERROR", details)
  }
}

export class InvalidPolicyConfigurationError extends FrameworkCoreError {
  readonly moduleKey: string
  readonly policyId: string | null
  readonly issues: unknown[]
  readonly catalogModuleKey?: string
  /** Field names that policies reference but the module catalog does not list. */
  readonly missingFields?: string[]

  constructor(message: string, details: { moduleKey: string; policyId: string | null; issues: unknown[]; catalogModuleKey?: string; missingFields?: string[] }) {
    super(message, "INVALID_POLICY_CONFIGURATION", { moduleKey: details.moduleKey, policyId: details.policyId })
    this.moduleKey = details.moduleKey
    this.policyId = details.policyId
    this.issues = details.issues
    if (details.catalogModuleKey !== undefined) this.catalogModuleKey = details.catalogModuleKey
    if (details.missingFields !== undefined) this.missingFields = details.missingFields
  }
}

export class UnsupportedCapabilityError extends FrameworkCoreError {
  constructor(message: string = "Unsupported capability", details?: unknown) {
    super(message, "CAPABILITY_REQUIRED", details)
  }
}

export class OptimisticConcurrencyError extends FrameworkCoreError {
  constructor(message: string = "Optimistic concurrency conflict — version mismatch", details?: unknown) {
    super(message, "OPTIMISTIC_CONCURRENCY_FAILED", details)
  }
}

export class TenantScopeViolationError extends FrameworkCoreError {
  constructor(message: string = "Tenant scope violation", details?: unknown) {
    super(message, "CONFIGURATION_ERROR", details)
  }
}

export class ImmutableFieldViolationError extends FrameworkCoreError {
  constructor(message: string = "Immutable field violation", details?: unknown) {
    super(message, "VALIDATION_ERROR", details)
  }
}

export class TransactionUnavailableError extends FrameworkCoreError {
  constructor(message: string = "Transaction is unavailable", details?: unknown) {
    super(message, "CONFIGURATION_ERROR", details)
  }
}

export class OperationContextInactiveError extends FrameworkCoreError {
  constructor(message = "Operation context is no longer active", details?: unknown) {
    super(message, "OPERATION_CONTEXT_INACTIVE", details)
  }
}

export class EffectRegistrationClosedError extends FrameworkCoreError {
  constructor(message = "Effect registration is closed", details?: unknown) {
    super(message, "EFFECT_REGISTRATION_CLOSED", details)
  }
}

export class EffectCollectorDisposedError extends FrameworkCoreError {
  constructor(message = "Effect collector has been disposed", details?: unknown) {
    super(message, "EFFECT_COLLECTOR_DISPOSED", details)
  }
}

export class EffectCollectorDrainedError extends FrameworkCoreError {
  constructor(message = "Deferred effects have already been drained", details?: unknown) {
    super(message, "EFFECTS_ALREADY_DRAINED", details)
  }
}
