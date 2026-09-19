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

export type FrameworkErrorCategory = "authentication" | "authorization" | "validation" | "conflict" | "not-found" | "rate-limit" | "configuration" | "dependency" | "internal"
export type SafeErrorMetadata = Readonly<Record<string, string | number | boolean>>
interface ErrorDefaults { readonly safeMessage:string; readonly retryable:boolean; readonly category:FrameworkErrorCategory; readonly publicCode:string }
const ERROR_DEFAULTS:Readonly<Record<FrameworkCoreErrorCode,ErrorDefaults>>={
  UNAUTHORIZED:{safeMessage:"Unauthorized",retryable:false,category:"authentication",publicCode:"UNAUTHORIZED"},FORBIDDEN:{safeMessage:"Forbidden",retryable:false,category:"authorization",publicCode:"FORBIDDEN"},CAPABILITY_REQUIRED:{safeMessage:"Forbidden",retryable:false,category:"authorization",publicCode:"CAPABILITY_REQUIRED"},VALIDATION_ERROR:{safeMessage:"Validation failed",retryable:false,category:"validation",publicCode:"VALIDATION_ERROR"},BAD_REQUEST:{safeMessage:"Business rule violation",retryable:false,category:"validation",publicCode:"BAD_REQUEST"},CONFLICT:{safeMessage:"Conflict",retryable:false,category:"conflict",publicCode:"CONFLICT"},OPTIMISTIC_CONCURRENCY_FAILED:{safeMessage:"Conflict",retryable:false,category:"conflict",publicCode:"OPTIMISTIC_CONCURRENCY_FAILED"},STALE_CLAIM:{safeMessage:"Conflict",retryable:false,category:"conflict",publicCode:"STALE_CLAIM"},NOT_FOUND:{safeMessage:"Not found",retryable:false,category:"not-found",publicCode:"NOT_FOUND"},RATE_LIMIT_EXCEEDED:{safeMessage:"Rate limit exceeded",retryable:true,category:"rate-limit",publicCode:"RATE_LIMIT_EXCEEDED"},RETRYABLE_PERSISTENCE_ERROR:{safeMessage:"Service temporarily unavailable",retryable:true,category:"dependency",publicCode:"SERVICE_UNAVAILABLE"},PERSISTENCE_ERROR:{safeMessage:"Internal Server Error",retryable:false,category:"dependency",publicCode:"INTERNAL_SERVER_ERROR"},RUNTIME_CAPABILITY_REQUIRED:{safeMessage:"Internal Server Error",retryable:false,category:"configuration",publicCode:"INTERNAL_SERVER_ERROR"},CONFIGURATION_ERROR:{safeMessage:"Internal Server Error",retryable:false,category:"configuration",publicCode:"INTERNAL_SERVER_ERROR"},INVALID_POLICY_CONFIGURATION:{safeMessage:"Internal Server Error",retryable:false,category:"configuration",publicCode:"INTERNAL_SERVER_ERROR"},AUDIT_SINK_MISSING:{safeMessage:"Internal Server Error",retryable:false,category:"configuration",publicCode:"INTERNAL_SERVER_ERROR"},AUDIT_ACTOR_MISSING:{safeMessage:"Internal Server Error",retryable:false,category:"configuration",publicCode:"INTERNAL_SERVER_ERROR"},OUTBOX_SINK_MISSING:{safeMessage:"Internal Server Error",retryable:false,category:"configuration",publicCode:"INTERNAL_SERVER_ERROR"},OPERATION_CONTEXT_INACTIVE:{safeMessage:"Internal Server Error",retryable:false,category:"internal",publicCode:"INTERNAL_SERVER_ERROR"},EFFECT_REGISTRATION_CLOSED:{safeMessage:"Internal Server Error",retryable:false,category:"internal",publicCode:"INTERNAL_SERVER_ERROR"},EFFECT_COLLECTOR_DISPOSED:{safeMessage:"Internal Server Error",retryable:false,category:"internal",publicCode:"INTERNAL_SERVER_ERROR"},EFFECTS_ALREADY_DRAINED:{safeMessage:"Internal Server Error",retryable:false,category:"internal",publicCode:"INTERNAL_SERVER_ERROR"},
}

export class FrameworkCoreError extends Error {
  public readonly code: FrameworkCoreErrorCode
  public readonly details?: unknown
  public readonly safeMessage: string
  public readonly retryable: boolean
  public readonly category: FrameworkErrorCategory
  public readonly safeMetadata: SafeErrorMetadata
  public readonly publicCode: string

  constructor(message: string, code: FrameworkCoreErrorCode, details?: unknown, safeMetadata: SafeErrorMetadata = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    this.details = details
    const defaults=ERROR_DEFAULTS[code]
    this.safeMessage=defaults.safeMessage
    this.retryable=defaults.retryable
    this.category=defaults.category
    this.safeMetadata=Object.freeze({...safeMetadata})
    this.publicCode=defaults.publicCode
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

  constructor(message: string, details: { moduleKey: string; policyId: string | null; issues: unknown[]; catalogModuleKey?: string }) {
    super(message, "INVALID_POLICY_CONFIGURATION", { moduleKey: details.moduleKey, policyId: details.policyId })
    this.moduleKey = details.moduleKey
    this.policyId = details.policyId
    this.issues = details.issues
    if (details.catalogModuleKey !== undefined) this.catalogModuleKey = details.catalogModuleKey
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
