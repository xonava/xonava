import { describe, expect, it } from "vitest"
import * as errors from "../errors"

describe("framework error defaults and metadata", () => {
  it("constructs every exported error with defaults", () => {
    const instances = [
      new errors.ForbiddenError(), new errors.UnauthorizedError(), new errors.ConflictError(), new errors.RetryablePersistenceError(), new errors.NotFoundError(),
      new errors.CapabilityError(), new errors.RuntimeCapabilityError(), new errors.ValidationError(), new errors.BusinessRuleError(), new errors.AuditSinkMissingError(),
      new errors.AuditActorMissingError(), new errors.OutboxSinkMissingError(), new errors.ConfigurationError(), new errors.UnsupportedCapabilityError(),
      new errors.OptimisticConcurrencyError(), new errors.TenantScopeViolationError(), new errors.ImmutableFieldViolationError(), new errors.TransactionUnavailableError(),
      new errors.OperationContextInactiveError(), new errors.EffectRegistrationClosedError(), new errors.EffectCollectorDisposedError(),
      new errors.EffectCollectorDrainedError(), new errors.PersistenceError(),
    ]
    expect(instances.every((error) => error instanceof errors.FrameworkCoreError)).toBe(true)
    expect(instances.every((error) => typeof error.safeMessage === "string" && typeof error.retryable === "boolean" && typeof error.category === "string" && Object.isFrozen(error.safeMetadata))).toBe(true)
    expect(new errors.RateLimitError(42).retryAfterMs).toBe(42)
    expect(new errors.InvalidPolicyConfigurationError("bad", { moduleKey: "m", policyId: null, issues: [], catalogModuleKey: "catalog" }).catalogModuleKey).toBe("catalog")
  })
})
