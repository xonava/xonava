import { describe, expect, it } from "vitest"
import { ConfigurationError, ValidationError } from "../../domain"
import { validateOperationDefinition } from "../validateOperationDefinition"

const execute = async () => ({})
const audit = { action: "read", resourceType: "record", resolveResourceId: () => "record-1" }

describe("operation definition validation branches", () => {
  it("requires an explicit operation kind and atomic-batch authorization", () => {
    expect(() => validateOperationDefinition({ key: "missing-kind", execute } as never)).toThrow("Invalid operation kind")
    expect(() => validateOperationDefinition({ key: "missing-batch-authorization", kind: "mutation", atomicity: { kind: "atomic-batch" }, prepare: async () => ({}) as never } as never)).toThrow("requires authorization")
  })

  it("validates base, standard, and atomic-batch definitions", () => {
    expect(Object.isFrozen(validateOperationDefinition({ key: "base", kind: "read", execute }))).toBe(true)
    expect(validateOperationDefinition({ key: "standard", kind: "read", atomicity: { kind: "standard", mode: "preferred" }, audit, outbox: { required: false }, execute })).toBeTruthy()
    expect(validateOperationDefinition({ key: "batch", kind: "mutation", atomicity: { kind: "atomic-batch" }, authorization: { authorize: async () => ({ allowed: true }) }, audit, outbox: { required: true }, prepare: async () => ({}) as never })).toBeTruthy()
  })

  it.each([
    [null, "object"], [{ key: "" }, "key"], [{ key: "x", kind: "read", atomicity: "bad" }, "atomicity"],
    [{ key: "x", kind: "read", atomicity: { kind: "standard", mode: "bad" }, execute }, "mode"],
    [{ key: "x", kind: "read", atomicity: { kind: "weird" }, execute }, "kind"],
    [{ key: "x", kind: "mutation", atomicity: { kind: "atomic-batch" }, authorization: { authorize: async () => ({ allowed: true }) } }, "prepare"],
    [{ key: "x", kind: "mutation", atomicity: { kind: "atomic-batch" }, authorization: { authorize: async () => ({ allowed: true }) }, prepare: async () => ({}), execute }, "cannot define execute"],
  ] as const)("rejects invalid definition %#", (definition, message) => expect(() => validateOperationDefinition(definition as never)).toThrow(message))

  it("rejects audit, outbox, and runtime capability combinations", () => {
    expect(() => validateOperationDefinition({ key: "x", kind: "read", execute, audit: { ...audit, action: "" } })).toThrow(ValidationError)
    expect(() => validateOperationDefinition({ key: "x", kind: "read", execute, audit: { ...audit, fallbackAuditGuarantee: "atomic" as never } })).toThrow(ValidationError)
    expect(() => validateOperationDefinition({ key: "x", kind: "read", execute, audit: { ...audit, auditGuarantee: "atomic" } })).toThrow(ConfigurationError)
    expect(() => validateOperationDefinition({ key: "x", kind: "read", execute, audit: { ...audit, auditGuarantee: "durable" } })).toThrow(ConfigurationError)
    expect(() => validateOperationDefinition({ key: "x", kind: "read", execute, outbox: { required: true } })).toThrow(ConfigurationError)
    expect(() => validateOperationDefinition({ key: "x", kind: "read", execute, requiredRuntimeCapabilities: "cache" as never })).toThrow("must be an array")
    expect(() => validateOperationDefinition({ key: "x", kind: "read", execute, requiredRuntimeCapabilities: ["cache", "deferredExecution"] })).not.toThrow()
    expect(() => validateOperationDefinition({ key: "x", kind: "mutation", atomicity: { kind: "atomic-batch" }, authorization: { authorize: async () => ({ allowed: true }) }, prepare: async () => ({}) as never })).not.toThrow()
  })

  it("accepts optional audit fallbacks and freezes framework-owned children", () => {
    const definition = validateOperationDefinition({ key: "freeze", kind: "read", execute, requiredRuntimeCapabilities: ["cache"], audit: { ...audit, auditGuarantee: "durable", fallbackAuditGuarantee: "best-effort" } })
    expect(Object.isFrozen(definition.audit)).toBe(true)
    expect(Object.isFrozen(definition.requiredRuntimeCapabilities)).toBe(true)
    expect(() => validateOperationDefinition({ key: "batch-no-outbox", kind: "mutation", atomicity: { kind: "atomic-batch" }, authorization: { authorize: async () => ({ allowed: true }) }, outbox: { required: false }, prepare: async () => ({}) as never })).toThrow("outbox configuration")
  })
})
