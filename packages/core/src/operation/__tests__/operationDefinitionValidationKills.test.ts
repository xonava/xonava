import { describe, expect, it } from "vitest"
import { ConfigurationError, ValidationError } from "../../domain"
import { validateOperationDefinition } from "../validateOperationDefinition"
import {
  defineInfrastructureRawDataAccess,
  defineOperationDataAccess,
} from "../operationResources"

const execute = async () => undefined
const prepare = async () => []
const authorization = { authorize: async () => ({ allowed: true }) }
const resolveResourceId = () => "id"

function read(extra: Record<string, unknown> = {}): never {
  return { key: "op", kind: "read", execute, ...extra } as never
}

function mutation(extra: Record<string, unknown> = {}): never {
  return {
    key: "m", kind: "mutation", execute, authorization,
    atomicity: { kind: "standard", mode: "required" },
    ...extra,
  } as never
}

function batch(extra: Record<string, unknown> = {}): never {
  return {
    key: "m", kind: "mutation", authorization,
    atomicity: { kind: "atomic-batch" }, prepare,
    ...extra,
  } as never
}

function audit(extra: Record<string, unknown> = {}) {
  return { action: "records.read", resourceType: "record", resolveResourceId, ...extra }
}

describe("operation definition shape", () => {
  it("rejects non-objects, blank keys and unknown kinds", () => {
    expect(() => validateOperationDefinition(null as never)).toThrow(new ValidationError("Operation definition must be an object."))
    expect(() => validateOperationDefinition("op" as never)).toThrow("Operation definition must be an object.")
    expect(() => validateOperationDefinition({ key: "", kind: "read", execute } as never)).toThrow("Operation definition key must be non-empty.")
    expect(() => validateOperationDefinition({ key: "   ", kind: "read", execute } as never)).toThrow("Operation definition key must be non-empty.")
    expect(() => validateOperationDefinition({ key: 5, kind: "read", execute } as never)).toThrow("Operation definition key must be non-empty.")
    expect(() => validateOperationDefinition({ key: "op", kind: "write", execute } as never)).toThrow("Invalid operation kind for operation op.")
    expect(() => validateOperationDefinition({ key: "op", execute } as never)).toThrow("Invalid operation kind for operation op.")
  })

  it("requires a boolean security-sensitivity flag when declared", () => {
    expect(() => validateOperationDefinition(read({ securitySensitive: "yes" }))).toThrow(
      new ValidationError("Security-sensitive operation flag must be boolean for operation op."),
    )
    expect(validateOperationDefinition(read({ securitySensitive: false })).key).toBe("op")
  })

  it("requires authorization for mutations", () => {
    expect(() => validateOperationDefinition(mutation({ authorization: undefined }))).toThrow(
      new ConfigurationError("Mutation operation m requires authorization."),
    )
    expect(() => validateOperationDefinition(mutation({ authorization: { authorize: 1 } }))).toThrow("Mutation operation m requires authorization.")
  })

  it("requires required atomicity for mutations", () => {
    expect(() => validateOperationDefinition(mutation({ atomicity: undefined }))).toThrow(
      new ConfigurationError("Mutation operation m requires required atomicity."),
    )
    expect(() => validateOperationDefinition(mutation({ atomicity: { kind: "standard", mode: "preferred" } }))).toThrow(
      "Mutation operation m requires required atomicity.",
    )
  })

  it("requires mutation authorization and required atomicity for security-sensitive operations", () => {
    expect(() => validateOperationDefinition(read({ securitySensitive: true }))).toThrow(
      new ConfigurationError("Security-sensitive operation op requires mutation authorization and required atomicity."),
    )
    // A mutation without required atomicity is rejected by the mutation check before the security-sensitive check.
    expect(() => validateOperationDefinition(mutation({ securitySensitive: true, atomicity: { kind: "standard", mode: "preferred" } }))).toThrow(
      "Mutation operation m requires required atomicity.",
    )
    expect(() => validateOperationDefinition(read({ securitySensitive: true, atomicity: { kind: "standard", mode: "required" } }))).toThrow(
      "Security-sensitive operation op requires mutation authorization and required atomicity.",
    )
    expect(validateOperationDefinition(mutation({ securitySensitive: true })).key).toBe("m")
    expect(validateOperationDefinition(batch({ securitySensitive: true })).key).toBe("m")
  })

  it("accepts a valid definition and returns a frozen snapshot", () => {
    const result = validateOperationDefinition(read())
    expect(result).toMatchObject({ key: "op", kind: "read" })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it("validates audit configuration shape", () => {
    expect(() => validateOperationDefinition(read({ audit: null }))).toThrow("Audit configuration must be an object.")
    expect(() => validateOperationDefinition(read({ audit: [] }))).toThrow("Audit configuration must be an object.")
    expect(() => validateOperationDefinition(read({ audit: audit({ required: "yes" }) }))).toThrow("Audit required flag must be boolean.")
    expect(() => validateOperationDefinition(read({ audit: audit({ action: "" }) }))).toThrow("Audit configuration is incomplete for operation op.")
    expect(() => validateOperationDefinition(read({ audit: audit({ action: "   " }) }))).toThrow("Audit configuration is incomplete for operation op.")
    expect(() => validateOperationDefinition(read({ audit: audit({ resourceType: "" }) }))).toThrow("Audit configuration is incomplete for operation op.")
    expect(() => validateOperationDefinition(read({ audit: audit({ resolveResourceId: "id" }) }))).toThrow("Audit configuration is incomplete for operation op.")
    expect(() => validateOperationDefinition(read({ audit: audit({ auditGuarantee: "forever" }) }))).toThrow(
      "Invalid audit guarantee for operation op.",
    )
    expect(() => validateOperationDefinition(read({ audit: audit({ fallbackAuditGuarantee: "durable" }) }))).toThrow(
      "Invalid fallback audit guarantee for operation op.",
    )
    expect(validateOperationDefinition(read({ audit: audit() })).key).toBe("op")
  })

  it("requires a boolean outbox flag when outbox is declared", () => {
    expect(() => validateOperationDefinition(read({ outbox: null }))).toThrow("Outbox configuration must declare a boolean required flag.")
    expect(() => validateOperationDefinition(read({ outbox: {} }))).toThrow("Outbox configuration must declare a boolean required flag.")
    expect(() => validateOperationDefinition(read({ outbox: { required: "yes" } }))).toThrow("Outbox configuration must declare a boolean required flag.")
  })
})

describe("standard atomicity", () => {
  it("rejects unknown atomicity shapes", () => {
    expect(() => validateOperationDefinition(read({ atomicity: "standard" }))).toThrow("Invalid atomicity configuration for operation op.")
    expect(() => validateOperationDefinition(read({ atomicity: null }))).toThrow("Invalid atomicity configuration for operation op.")
    expect(() => validateOperationDefinition(read({ atomicity: { kind: "stream" } }))).toThrow("Invalid atomicity kind for operation op.")
    expect(() => validateOperationDefinition(read({ atomicity: { kind: "standard", mode: "none", extra: 1 } }))).toThrow(
      'Unknown property "extra" in standard atomicity for operation op.',
    )
    expect(() => validateOperationDefinition(read({ atomicity: { kind: "standard", mode: "maybe" } }))).toThrow(
      "Invalid standard atomicity mode for operation op.",
    )
  })

  it("requires execute to be a function", () => {
    expect(() => validateOperationDefinition({ key: "op", kind: "read" } as never)).toThrow("Operation execute must be a function.")
    expect(() => validateOperationDefinition({ key: "op", kind: "read", atomicity: { kind: "standard", mode: "none" } } as never)).toThrow(
      "Operation execute must be a function.",
    )
  })

  it("validates transaction options", () => {
    const withOptions = (transactionOptions: unknown) => read({ atomicity: { kind: "standard", mode: "none", transactionOptions } })
    expect(() => validateOperationDefinition(withOptions(5))).toThrow("Invalid transaction options for operation op.")
    expect(() => validateOperationDefinition(withOptions(null))).toThrow("Invalid transaction options for operation op.")
    expect(() => validateOperationDefinition(withOptions({ bogus: true }))).toThrow(
      'Unknown property "bogus" in transaction options for operation op.',
    )
    expect(() => validateOperationDefinition(withOptions({ timeoutMs: 0 }))).toThrow(
      "Transaction timeoutMs must be an integer from 1 to 3600000 for operation op.",
    )
    expect(() => validateOperationDefinition(withOptions({ timeoutMs: 3_600_001 }))).toThrow("Transaction timeoutMs must be an integer from 1 to 3600000")
    expect(() => validateOperationDefinition(withOptions({ timeoutMs: 1.5 }))).toThrow("Transaction timeoutMs must be an integer from 1 to 3600000")
    expect(() => validateOperationDefinition(withOptions({ isolationLevel: "snapshot" }))).toThrow(
      "Invalid transaction isolation level for operation op.",
    )
    expect(() => validateOperationDefinition(withOptions({ accessMode: "append" }))).toThrow(
      "Invalid transaction access mode for operation op.",
    )
    expect(validateOperationDefinition(withOptions({})).key).toBe("op")
    expect(validateOperationDefinition(withOptions({ timeoutMs: 1, isolationLevel: "serializable", accessMode: "read only" })).key).toBe("op")
    expect(validateOperationDefinition(withOptions({ timeoutMs: 3_600_000, isolationLevel: "read committed", accessMode: "read write" })).key).toBe("op")
  })

  it("validates the transaction execution mode against atomicity", () => {
    expect(() => validateOperationDefinition(read({ execution: null }))).toThrow("Invalid execution configuration for operation op.")
    expect(() => validateOperationDefinition(read({ execution: { kind: "transaction", extra: 1 } }))).toThrow(
      'Unknown property "extra" in execution for operation op.',
    )
    expect(() => validateOperationDefinition(read({ execution: { kind: "transaction" } }))).toThrow(
      new ConfigurationError("Transaction execution requires transactional atomicity for operation op."),
    )
    expect(() => validateOperationDefinition(read({ execution: { kind: "other" } }))).toThrow("Invalid execution kind for operation op.")
    expect(validateOperationDefinition(read({ atomicity: { kind: "standard", mode: "preferred" }, execution: { kind: "transaction" } })).key).toBe("op")
  })

  it("validates retryable transaction execution", () => {
    const retry = (overrides: Record<string, unknown> = {}) => mutation({
      execution: { kind: "retryable-transaction", maxAttempts: 3, delay: 10, backoff: 2, maxDelay: 100, ...overrides },
    })
    expect(validateOperationDefinition(retry()).key).toBe("m")
    expect(() => validateOperationDefinition(read({ atomicity: { kind: "standard", mode: "preferred" }, execution: { kind: "retryable-transaction", maxAttempts: 1, delay: 0, backoff: 1, maxDelay: 0 } }))).toThrow(
      "Retryable transaction execution requires required atomicity for operation op.",
    )
    expect(() => validateOperationDefinition(retry({ extra: 1 }))).toThrow(
      'Unknown property "extra" in execution for operation m.',
    )
    expect(() => validateOperationDefinition(retry({ maxAttempts: 0 }))).toThrow(
      "Execution maxAttempts must be an integer from 1 through 5 for operation m.",
    )
    expect(() => validateOperationDefinition(retry({ maxAttempts: 6 }))).toThrow("Execution maxAttempts must be an integer from 1 through 5 for operation m.")
    expect(() => validateOperationDefinition(retry({ maxAttempts: 1.5 }))).toThrow("Execution maxAttempts must be an integer from 1 through 5")
    expect(validateOperationDefinition(retry({ maxAttempts: 1 })).key).toBe("m")
    expect(validateOperationDefinition(retry({ maxAttempts: 5 })).key).toBe("m")
    expect(() => validateOperationDefinition(retry({ delay: -1 }))).toThrow(
      "Execution delay must be finite and non-negative for operation m.",
    )
    expect(() => validateOperationDefinition(retry({ delay: Number.POSITIVE_INFINITY }))).toThrow("Execution delay must be finite and non-negative")
    expect(() => validateOperationDefinition(retry({ backoff: 0.5 }))).toThrow(
      "Execution backoff must be finite and at least 1 for operation m.",
    )
    expect(() => validateOperationDefinition(retry({ maxDelay: 5, delay: 10 }))).toThrow(
      "Execution maxDelay must be finite, non-negative, and at least delay for operation m.",
    )
    expect(validateOperationDefinition(retry({ maxDelay: 10, delay: 10, backoff: 1 })).key).toBe("m")
  })
})

describe("atomic-batch atomicity", () => {
  it("accepts a well-formed atomic-batch mutation", () => {
    const result = validateOperationDefinition(batch())
    expect(result).toMatchObject({ key: "m", kind: "mutation" })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it("rejects execution modes combined with atomic-batch atomicity", () => {
    expect(() => validateOperationDefinition(batch({ execution: { kind: "transaction" } }))).toThrow(
      "Execution modes cannot be combined with atomic-batch atomicity for operation m.",
    )
  })

  it("rejects extra atomicity keys and non-mutation kinds", () => {
    expect(() => validateOperationDefinition(batch({ atomicity: { kind: "atomic-batch", extra: 1 } }))).toThrow(
      'Unknown property "extra" in atomic-batch atomicity for operation m.',
    )
    expect(() => validateOperationDefinition(batch({ kind: "read" }))).toThrow("Atomic-batch operation m must be a mutation.")
    // Mutation kind is checked for authorization before the atomic-batch branch.
    expect(() => validateOperationDefinition(batch({ authorization: undefined }))).toThrow(
      new ConfigurationError("Mutation operation m requires authorization."),
    )
  })

  it("requires prepare, forbids execute, and restricts the batch outbox flag", () => {
    expect(() => validateOperationDefinition(batch({ prepare: undefined }))).toThrow("Operation prepare must be a function.")
    expect(() => validateOperationDefinition(batch({ execute }))).toThrow(
      new ConfigurationError("Atomic-batch operation m cannot define execute."),
    )
    expect(() => validateOperationDefinition(batch({ outbox: { required: false } }))).toThrow(
      "Atomic-batch outbox configuration is invalid for operation m.",
    )
    expect(validateOperationDefinition(batch({ outbox: { required: true } })).key).toBe("m")
  })

  it("rejects unknown atomicity kinds", () => {
    expect(() => validateOperationDefinition(read({ atomicity: { kind: "stream" } }))).toThrow("Invalid atomicity kind for operation op.")
  })

  it("allows audits at atomic-batch atomicity but not durable standard audits", () => {
    expect(validateOperationDefinition(batch({ audit: audit({ auditGuarantee: "atomic" }) })).key).toBe("m")
    expect(() => validateOperationDefinition(batch({ audit: audit({ auditGuarantee: "durable" }) }))).toThrow(
      "Durable audit requires required standard atomicity for operation m.",
    )
  })
})

describe("atomic-batch fallback", () => {
  it("accepts a fallback alongside required standard atomicity", () => {
    expect(validateOperationDefinition(mutation({ atomicBatch: { prepare } })).key).toBe("m")
  })

  it("rejects a fallback on reads and on non-standard atomicity", () => {
    expect(() => validateOperationDefinition(read({ atomicBatch: { prepare } }))).toThrow(
      new ConfigurationError("Atomic-batch fallback cannot replace an explicit execution mode."),
    )
    expect(() => validateOperationDefinition(batch({ atomicBatch: { prepare } }))).toThrow(
      "Atomic-batch fallback cannot replace an explicit execution mode.",
    )
  })

  it("rejects a fallback that declares an execution mode", () => {
    expect(() => validateOperationDefinition(mutation({ execution: { kind: "transaction" }, atomicBatch: { prepare } }))).toThrow(
      "Atomic-batch fallback cannot replace an explicit execution mode.",
    )
  })

  it("requires prepare, and rejects transaction options and durable audit", () => {
    expect(() => validateOperationDefinition(mutation({ atomicBatch: {} }))).toThrow(
      new ValidationError("Atomic-batch fallback requires prepare."),
    )
    expect(() => validateOperationDefinition(mutation({ atomicBatch: null }))).toThrow("Atomic-batch fallback requires prepare.")
    expect(() => validateOperationDefinition(mutation({
      atomicity: { kind: "standard", mode: "required", transactionOptions: {} },
      atomicBatch: { prepare },
    }))).toThrow("Atomic-batch fallback cannot enforce interactive transaction options.")
    expect(() => validateOperationDefinition(mutation({
      atomicBatch: { prepare },
      audit: audit({ auditGuarantee: "durable" }),
    }))).toThrow("Atomic-batch fallback cannot enforce durable standard audit delivery.")
  })
})

describe("runtime capabilities", () => {
  it("accepts supported, non-repeating capability lists", () => {
    expect(validateOperationDefinition(read({ requiredRuntimeCapabilities: [] })).key).toBe("op")
    expect(validateOperationDefinition(read({ requiredRuntimeCapabilities: ["deferredExecution", "objectStore", "cache"] })).key).toBe("op")
  })

  it("rejects non-array, unknown, non-string and repeated capabilities", () => {
    expect(() => validateOperationDefinition(read({ requiredRuntimeCapabilities: "cache" }))).toThrow(
      "Runtime capabilities must be an array for operation op.",
    )
    expect(() => validateOperationDefinition(read({ requiredRuntimeCapabilities: ["gpu"] }))).toThrow(
      "Invalid runtime capability for operation op.",
    )
    expect(() => validateOperationDefinition(read({ requiredRuntimeCapabilities: [5] }))).toThrow("Invalid runtime capability for operation op.")
    expect(() => validateOperationDefinition(read({ requiredRuntimeCapabilities: ["cache", "cache"] }))).toThrow(
      "Duplicate runtime capability for operation op.",
    )
  })
})

describe("data access declarations", () => {
  const writeTo = (source: string | undefined) => ({ kind: "entity", key: `t-${source ?? "default"}`, access: "write", ...(source === undefined ? {} : { source }) })

  it("forbids a mutation from writing to more than one datasource", () => {
    expect(() => validateOperationDefinition(mutation({
      dataAccess: { kind: "declared", datasourceKey: "primary", resources: [writeTo("a"), writeTo("b")] },
    }))).toThrow(
      "Mutation operation m cannot mutate more than one datasource in a local transaction; use a workflow or event boundary.",
    )
    expect(() => validateOperationDefinition(mutation({
      dataAccess: { kind: "declared", datasourceKey: "primary", resources: [writeTo(undefined), writeTo("b")] },
    }))).toThrow("cannot mutate more than one datasource")
  })

  it("permits writes that share one datasource and reads elsewhere", () => {
    const shared = mutation({
      dataAccess: { kind: "declared", datasourceKey: "primary", resources: [writeTo("a"), { kind: "entity", key: "x", access: "write", source: "a" }, { kind: "entity", key: "r", access: "read", source: "b" }] },
    })
    expect(validateOperationDefinition(shared).key).toBe("m")
    expect(validateOperationDefinition(read({
      dataAccess: { kind: "declared", datasourceKey: "primary", resources: [writeTo("a"), writeTo("b")] },
    })).key).toBe("op")
  })
})

describe("data access definitions", () => {
  it("requires a declared kind, a datasource key and at least one resource", () => {
    expect(() => defineOperationDataAccess({ kind: "raw" } as never)).toThrow(new ConfigurationError("Operation data access kind must be declared."))
    expect(() => defineOperationDataAccess(null as never)).toThrow("Operation data access kind must be declared.")
    expect(() => defineOperationDataAccess({ kind: "declared", datasourceKey: "", resources: [] } as never)).toThrow(
      "Operation datasource key must be non-empty.",
    )
    expect(() => defineOperationDataAccess({ kind: "declared", datasourceKey: "p", resources: [] })).toThrow(
      new ConfigurationError("Operation data access must declare at least one resource."),
    )
  })

  it("validates each resource declaration", () => {
    const declare = (resource: unknown) => defineOperationDataAccess({ kind: "declared", datasourceKey: "p", resources: [resource as never] })
    expect(() => declare(null)).toThrow(new ConfigurationError("Operation resource must be an object."))
    expect(() => declare({ kind: "table", key: "a", access: "read" })).toThrow("Operation resource kind is invalid.")
    expect(() => declare({ kind: "entity", key: "a", access: "delete" })).toThrow("Operation resource access is invalid.")
    expect(() => declare({ kind: "entity", key: " ", access: "read" })).toThrow("Operation resource key must be non-empty.")
    expect(() => declare({ kind: "entity", key: "a", access: "read", source: "" })).toThrow("Operation resource datasource must be non-empty.")
  })

  it("rejects duplicate resource identities", () => {
    expect(() => defineOperationDataAccess({
      kind: "declared", datasourceKey: "p",
      resources: [{ kind: "entity", key: "a", access: "read" }, { kind: "entity", key: "a", access: "write" }],
    })).toThrow(new ConfigurationError("Duplicate operation resource declaration: entity:a."))
  })

  it("returns a frozen declaration and omits absent sources", () => {
    const result = defineOperationDataAccess({
      kind: "declared", datasourceKey: "p",
      resources: [{ kind: "port", key: "mailer", access: "write" }, { kind: "read-model", key: "summary", access: "read", source: "replica" }],
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.resources)).toBe(true)
    expect(result.resources[0]).toEqual({ kind: "port", key: "mailer", access: "write" })
    expect("source" in result.resources[0]!).toBe(false)
    expect(result.resources[1]).toEqual({ kind: "read-model", key: "summary", access: "read", source: "replica" })
    expect(result).toMatchObject({ kind: "declared", datasourceKey: "p" })
  })
})

describe("infrastructure raw data access", () => {
  const capability = { kind: "infrastructure-raw", datasourceKey: "ds", justification: "migration", reviewKey: "REV-1" } as const

  it("validates every field", () => {
    expect(() => defineInfrastructureRawDataAccess({ ...capability, kind: "declared" } as never)).toThrow(
      new ConfigurationError("Infrastructure raw access kind is invalid."),
    )
    expect(() => defineInfrastructureRawDataAccess({ ...capability, datasourceKey: "" })).toThrow("Infrastructure datasource key must be non-empty.")
    expect(() => defineInfrastructureRawDataAccess({ ...capability, justification: " " })).toThrow(
      "Infrastructure raw-access justification must be non-empty.",
    )
    expect(() => defineInfrastructureRawDataAccess({ ...capability, reviewKey: "" })).toThrow(
      "Infrastructure raw-access review key must be non-empty.",
    )
  })

  it("returns a frozen copy of a valid capability", () => {
    const result = defineInfrastructureRawDataAccess({ ...capability })
    expect(result).toEqual(capability)
    expect(Object.isFrozen(result)).toBe(true)
    expect(result).not.toBe(capability)
  })
})
