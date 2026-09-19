import { describe, expect, it } from "vitest"
import { ConfigurationError, ValidationError } from "../../domain"
import { validateOperationDefinition } from "../validateOperationDefinition"

const execute = async () => ({})

describe("validateOperationDefinition", () => {
  it("rejects unknown audit guarantees", () => {
    expect(() => validateOperationDefinition({
      key: "invalid-audit",
      kind: "read",
      audit: {
        action: "read",
        resourceType: "record",
        auditGuarantee: "nonsense" as never,
        resolveResourceId: () => "record-1",
      },
      execute,
    })).toThrow(ValidationError)
  })

  it("rejects required best-effort audit", () => {
    expect(() => validateOperationDefinition({
      key: "required-best-effort-audit",
      kind: "mutation",
      atomicity: { kind: "standard", mode: "required" },
      authorization: { authorize: async () => ({ allowed: true }) },
      execute,
      audit: {
        required: true,
        action: "write",
        resourceType: "record",
        auditGuarantee: "best-effort",
        resolveResourceId: () => "record-1",
      },
    })).toThrow(ConfigurationError)
  })

  it("rejects invalid and duplicate runtime capabilities", () => {
    expect(() => validateOperationDefinition({
      key: "invalid-capability",
      kind: "read",
      requiredRuntimeCapabilities: ["unknown" as never],
      execute,
    })).toThrow(ValidationError)

    expect(() => validateOperationDefinition({
      key: "duplicate-capability",
      kind: "read",
      requiredRuntimeCapabilities: ["cache", "cache"],
      execute,
    })).toThrow("Duplicate runtime capability")
  })

  it("rejects unknown atomicity properties", () => {
    expect(() => validateOperationDefinition({
      key: "unknown-atomicity-property",
      kind: "read",
      atomicity: { kind: "standard", mode: "required", extra: true } as never,
      execute,
    })).toThrow("Unknown property")
  })

  it("validates bounded transaction retry configuration", () => {
    expect(() => validateOperationDefinition({
      key: "invalid-retry",
      kind: "read",
       atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 6, delay: 0, backoff: 2, maxDelay: 100 },
      execute,
    })).toThrow("maxAttempts")

    expect(() => validateOperationDefinition({
      key: "invalid-retry-delay",
      kind: "read",
       atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 2, delay: 100, backoff: 2, maxDelay: 50 },
      execute,
    })).toThrow("maxDelay")

    expect(() => validateOperationDefinition({
      key: "retry-without-transaction",
      kind: "read",
       atomicity: { kind: "standard", mode: "none" }, execution: { kind: "retryable-transaction", maxAttempts: 2, delay: 0, backoff: 2, maxDelay: 0 },
      execute,
    })).toThrow("requires required atomicity")
  })

  it("accepts valid audit and runtime capability configuration", () => {
    expect(validateOperationDefinition({
      key: "valid-definition",
      kind: "read",
      requiredRuntimeCapabilities: ["cache"],
      audit: {
        action: "read",
        resourceType: "record",
        auditGuarantee: "best-effort",
        resolveResourceId: () => "record-1",
      },
      execute,
    }).key).toBe("valid-definition")
  })

  it("requires authorization and required atomicity for explicit mutations", () => {
    expect(() => validateOperationDefinition({
      key: "mutation-without-authorization",
      kind: "mutation",
      atomicity: { kind: "standard", mode: "required" },
      execute,
    } as never)).toThrow(ConfigurationError)

    expect(() => validateOperationDefinition({
      key: "mutation-without-transaction",
      kind: "mutation",
      authorization: { authorize: async () => ({ allowed: true }) },
      atomicity: { kind: "standard", mode: "preferred" },
      execute,
    } as never)).toThrow(ConfigurationError)

    expect(() => validateOperationDefinition({
      key: "sensitive-read",
      kind: "read",
      securitySensitive: true,
      execute,
    })).toThrow(ConfigurationError)
  })
})
