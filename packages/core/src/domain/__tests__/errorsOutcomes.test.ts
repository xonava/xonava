import { describe, expect, it } from "vitest"
import {
  AuditActorMissingError,
  AuditSinkMissingError,
  BusinessRuleError,
  CancelledError,
  CapabilityError,
  ConfigurationError,
  ConflictError,
  EffectCollectorDisposedError,
  EffectCollectorDrainedError,
  EffectRegistrationClosedError,
  FrameworkCoreError,
  ForbiddenError,
  ImmutableFieldViolationError,
  InvalidPolicyConfigurationError,
  NotFoundError,
  OperationContextInactiveError,
  OptimisticConcurrencyError,
  OutboxSinkMissingError,
  PersistenceError,
  PreconditionRequiredError,
  PublicBusinessError,
  RateLimitError,
  RequiredHeaderMissingError,
  RetryablePersistenceError,
  RuntimeCapabilityError,
  StaleClaimError,
  TenantScopeViolationError,
  TimeoutError,
  TransactionRolledBackError,
  TransactionUnavailableError,
  UnauthorizedError,
  UnavailableError,
  UnsupportedCapabilityError,
  ValidationError,
} from "../errors"

describe("default error taxonomy", () => {
  it.each([
    ["ForbiddenError", new ForbiddenError(), "Forbidden", "FORBIDDEN", "authorization", false, "Forbidden", "FORBIDDEN"],
    ["UnauthorizedError", new UnauthorizedError(), "Unauthorized", "UNAUTHORIZED", "authentication", false, "Unauthorized", "UNAUTHORIZED"],
    ["ConflictError", new ConflictError(), "Conflict", "CONFLICT", "conflict", false, "Conflict", "CONFLICT"],
    ["StaleClaimError", new StaleClaimError(), "Claim token is stale or its lease has expired", "STALE_CLAIM", "conflict", false, "Conflict", "STALE_CLAIM"],
    ["NotFoundError", new NotFoundError(), "Not found", "NOT_FOUND", "not-found", false, "Not found", "NOT_FOUND"],
    ["CapabilityError", new CapabilityError(), "Required capability is not available", "CAPABILITY_REQUIRED", "authorization", false, "Forbidden", "CAPABILITY_REQUIRED"],
    ["UnsupportedCapabilityError", new UnsupportedCapabilityError(), "Unsupported capability", "CAPABILITY_REQUIRED", "authorization", false, "Forbidden", "CAPABILITY_REQUIRED"],
    ["RuntimeCapabilityError", new RuntimeCapabilityError(), "Required runtime capability is not available", "RUNTIME_CAPABILITY_REQUIRED", "configuration", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["ValidationError", new ValidationError(), "Validation error", "VALIDATION_ERROR", "validation", false, "Validation failed", "VALIDATION_ERROR"],
    ["BusinessRuleError", new BusinessRuleError(), "Business rule violation", "BAD_REQUEST", "validation", false, "Business rule violation", "BAD_REQUEST"],
    ["PersistenceError", new PersistenceError(), "Persistence operation failed", "PERSISTENCE_ERROR", "dependency", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["AuditSinkMissingError", new AuditSinkMissingError(), "Audit sink is required but missing", "AUDIT_SINK_MISSING", "configuration", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["AuditActorMissingError", new AuditActorMissingError(), "Audit actor is required but missing", "AUDIT_ACTOR_MISSING", "configuration", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["OutboxSinkMissingError", new OutboxSinkMissingError(), "Outbox sink is required but missing", "OUTBOX_SINK_MISSING", "configuration", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["ConfigurationError", new ConfigurationError(), "Configuration error", "CONFIGURATION_ERROR", "configuration", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["TenantScopeViolationError", new TenantScopeViolationError(), "Tenant scope violation", "CONFIGURATION_ERROR", "configuration", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["TransactionUnavailableError", new TransactionUnavailableError(), "Transaction is unavailable", "CONFIGURATION_ERROR", "configuration", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["ImmutableFieldViolationError", new ImmutableFieldViolationError(), "Immutable field violation", "VALIDATION_ERROR", "validation", false, "Validation failed", "VALIDATION_ERROR"],
    ["OptimisticConcurrencyError", new OptimisticConcurrencyError(), "Optimistic concurrency conflict — version mismatch", "OPTIMISTIC_CONCURRENCY_FAILED", "conflict", false, "Conflict", "OPTIMISTIC_CONCURRENCY_FAILED"],
    ["OperationContextInactiveError", new OperationContextInactiveError(), "Operation context is no longer active", "OPERATION_CONTEXT_INACTIVE", "internal", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["EffectRegistrationClosedError", new EffectRegistrationClosedError(), "Effect registration is closed", "EFFECT_REGISTRATION_CLOSED", "internal", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["EffectCollectorDisposedError", new EffectCollectorDisposedError(), "Effect collector has been disposed", "EFFECT_COLLECTOR_DISPOSED", "internal", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["EffectCollectorDrainedError", new EffectCollectorDrainedError(), "Deferred effects have already been drained", "EFFECTS_ALREADY_DRAINED", "internal", false, "Internal Server Error", "INTERNAL_SERVER_ERROR"],
    ["CancelledError", new CancelledError(), "The operation was cancelled", "CANCELLED", "internal", false, "The operation was cancelled", "CANCELLED"],
    ["TimeoutError", new TimeoutError(), "The operation timed out", "TIMEOUT", "dependency", true, "The operation timed out", "TIMEOUT"],
    ["UnavailableError", new UnavailableError(), "Service temporarily unavailable", "UNAVAILABLE", "dependency", true, "Service temporarily unavailable", "SERVICE_UNAVAILABLE"],
    ["RetryablePersistenceError", new RetryablePersistenceError(), "A transient persistence failure occurred", "RETRYABLE_PERSISTENCE_ERROR", "dependency", true, "Service temporarily unavailable", "SERVICE_UNAVAILABLE"],
    ["TransactionRolledBackError", new TransactionRolledBackError(), "The transaction was rolled back by the database", "RETRYABLE_PERSISTENCE_ERROR", "dependency", true, "Service temporarily unavailable", "SERVICE_UNAVAILABLE"],
  ])("%s has the documented message, code and public mapping", (name, error, message, code, category, retryable, safeMessage, publicCode) => {
    expect(error.name).toBe(name)
    expect(error.message).toBe(message)
    expect(error.code).toBe(code)
    expect(error.category).toBe(category)
    expect(error.retryable).toBe(retryable)
    expect(error.safeMessage).toBe(safeMessage)
    expect(error.publicCode).toBe(publicCode)
    expect(error.safeMetadata).toEqual({})
    expect(error).toBeInstanceOf(FrameworkCoreError)
  })

  it("marks retryable persistence errors with their kind", () => {
    expect(new RetryablePersistenceError().kind).toBe("retryable")
    expect(new TransactionRolledBackError().kind).toBe("retryable")
    expect(new TransactionRolledBackError()).toBeInstanceOf(RetryablePersistenceError)
  })

  it("accepts a custom message and passes details through", () => {
    const error = new ForbiddenError("custom", { reason: "x" })
    expect(error.message).toBe("custom")
    expect(error.details).toEqual({ reason: "x" })
    expect(new TimeoutError("late").message).toBe("late")
    expect(new CancelledError("stopped").message).toBe("stopped")
    expect(new RetryablePersistenceError("blip").message).toBe("blip")
  })
})

describe("FrameworkCoreError base behaviour", () => {
  it("degrades an unknown code to a configuration error", () => {
    const error = new FrameworkCoreError("boom", "NOT_A_CODE" as never)
    expect(error.code).toBe("CONFIGURATION_ERROR")
    expect(error.category).toBe("configuration")
    expect(error.publicCode).toBe("INTERNAL_SERVER_ERROR")
  })

  it("keeps details non-enumerable and out of JSON", () => {
    const error = new ForbiddenError("x", { secret: "s" })
    expect(error.details).toEqual({ secret: "s" })
    expect(Object.prototype.propertyIsEnumerable.call(error, "details")).toBe(false)
    expect(JSON.parse(JSON.stringify(error))).not.toHaveProperty("details")
  })

  it("uses an Error detail as the cause unless an explicit cause is given", () => {
    const inner = new Error("inner")
    expect(new PersistenceError("outer", inner).cause).toBe(inner)
    const explicit = new Error("explicit")
    expect(new FrameworkCoreError("outer", "PERSISTENCE_ERROR", inner, {}, { cause: explicit }).cause).toBe(explicit)
  })

  it("sets no cause when there is no error to attach", () => {
    expect(new ForbiddenError("x", { plain: true })).not.toHaveProperty("cause")
    expect(new ForbiddenError()).not.toHaveProperty("cause")
  })

  it("freezes a copy of the safe metadata", () => {
    const metadata = { retry: 1 }
    const error = new FrameworkCoreError("x", "UNAVAILABLE", undefined, metadata)
    expect(error.safeMetadata).toEqual({ retry: 1 })
    expect(Object.isFrozen(error.safeMetadata)).toBe(true)
    metadata.retry = 2
    expect(error.safeMetadata.retry).toBe(1)
  })
})

describe("header and precondition errors", () => {
  it("names the missing request header", () => {
    const error = new RequiredHeaderMissingError("Idempotency-Key")
    expect(error.message).toBe("Idempotency-Key header is required")
    expect(error.code).toBe("REQUIRED_HEADER_MISSING")
    expect(error.safeMessage).toBe("A required request header is missing")
    expect(error.safeMetadata).toEqual({ header: "Idempotency-Key" })
    expect(error.category).toBe("validation")
  })

  it("names the required precondition header", () => {
    const error = new PreconditionRequiredError("If-Match")
    expect(error.message).toBe("If-Match header is required")
    expect(error.code).toBe("PRECONDITION_REQUIRED")
    expect(error.safeMessage).toBe("A precondition header is required")
    expect(error.safeMetadata).toEqual({ header: "If-Match" })
  })

  it("accepts header names up to 100 characters and rejects invalid names", () => {
    expect(new RequiredHeaderMissingError("a".repeat(100)).safeMetadata.header).toBe("a".repeat(100))
    expect(() => new RequiredHeaderMissingError("a".repeat(101))).toThrow(new ConfigurationError("Header name is invalid"))
    expect(() => new PreconditionRequiredError("bad header")).toThrow("Header name is invalid")
    expect(() => new PreconditionRequiredError("" )).toThrow("Header name is invalid")
    expect(() => new RequiredHeaderMissingError(123 as never)).toThrow("Header name is invalid")
  })
})

describe("rate limit and invalid policy configuration errors", () => {
  it("reports the retry delay in metadata and details", () => {
    const error = new RateLimitError(5000)
    expect(error.message).toBe("Rate limit exceeded")
    expect(error.retryAfterMs).toBe(5000)
    expect(error.safeMetadata).toEqual({ retryAfterMs: 5000 })
    expect(error.details).toEqual({ retryAfterMs: 5000 })
    expect(error.retryable).toBe(true)
    expect(error.category).toBe("rate-limit")
    expect(error.safeMessage).toBe("Rate limit exceeded")
  })

  it("keeps only safe policy identifiers in details and optional catalog fields when given", () => {
    const bare = new InvalidPolicyConfigurationError("bad policy", { moduleKey: "m", policyId: null, issues: [1] })
    expect(bare.code).toBe("INVALID_POLICY_CONFIGURATION")
    expect(bare.message).toBe("bad policy")
    expect(bare.moduleKey).toBe("m")
    expect(bare.policyId).toBeNull()
    expect(bare.issues).toEqual([1])
    expect(bare.details).toEqual({ moduleKey: "m", policyId: null })
    expect(bare.catalogModuleKey).toBeUndefined()
    expect(bare.missingFields).toBeUndefined()
    const full = new InvalidPolicyConfigurationError("bad policy", {
      moduleKey: "m",
      policyId: "p1",
      issues: [],
      catalogModuleKey: "catalog",
      missingFields: ["name"],
    })
    expect(full.catalogModuleKey).toBe("catalog")
    expect(full.missingFields).toEqual(["name"])
    expect(full.policyId).toBe("p1")
  })
})

describe("PublicBusinessError", () => {
  it("exposes the application code, message and fields", () => {
    const error = new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "Order is locked", fields: ["status"] }, { internal: 1 })
    expect(error.message).toBe("Order is locked")
    expect(error.publicCode).toBe("ORDER_LOCKED")
    expect(error.safeMessage).toBe("Order is locked")
    expect(error.code).toBe("BAD_REQUEST")
    expect(error.category).toBe("validation")
    expect(error.retryable).toBe(false)
    expect(error.fields).toEqual(["status"])
    expect(Object.isFrozen(error.fields)).toBe(true)
    expect(error.details).toEqual({ internal: 1 })
  })

  it("defaults the fields to an empty list", () => {
    const error = new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "Locked" })
    expect(error.fields).toEqual([])
  })

  it("rejects an application code that does not match the public pattern", () => {
    const expected = new ConfigurationError("publicCode must match /^[A-Z][A-Z0-9_]{2,63}$/")
    expect(() => new PublicBusinessError({ publicCode: "order", publicMessage: "x" })).toThrow(expected.message)
    expect(() => new PublicBusinessError({ publicCode: "AB", publicMessage: "x" })).toThrow(expected.message)
    expect(() => new PublicBusinessError({ publicCode: "A".repeat(65), publicMessage: "x" })).toThrow(expected.message)
    expect(() => new PublicBusinessError(undefined as never)).toThrow(expected.message)
  })

  it("rejects codes that collide with framework or transport codes", () => {
    const expected = "publicCode must not equal a framework error code"
    expect(() => new PublicBusinessError({ publicCode: "FORBIDDEN", publicMessage: "x" })).toThrow(expected)
    expect(() => new PublicBusinessError({ publicCode: "SERVICE_UNAVAILABLE", publicMessage: "x" })).toThrow(expected)
    expect(() => new PublicBusinessError({ publicCode: "INVALID_JSON", publicMessage: "x" })).toThrow(expected)
  })

  it("bounds the public message to 1-200 characters without control characters", () => {
    const expected = "publicMessage must be 1-200 characters without control characters"
    expect(() => new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "" })).toThrow(expected)
    expect(() => new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "a".repeat(201) })).toThrow(expected)
    expect(() => new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "a\nb" })).toThrow(expected)
    expect(() => new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "a\u007fb" })).toThrow(expected)
    expect(new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "a".repeat(200) }).message).toHaveLength(200)
  })

  it("bounds fields to at most 20 entries of 1-200 characters", () => {
    const expected = "fields must have at most 20 entries of 1-200 characters"
    expect(() => new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "x", fields: Array.from({ length: 21 }, () => "f") })).toThrow(expected)
    expect(() => new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "x", fields: [""] })).toThrow(expected)
    expect(() => new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "x", fields: ["a".repeat(201)] })).toThrow(expected)
    expect(() => new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "x", fields: "name" as never })).toThrow(expected)
    expect(new PublicBusinessError({ publicCode: "ORDER_LOCKED", publicMessage: "x", fields: Array.from({ length: 20 }, () => "f") }).fields).toHaveLength(20)
  })
})
