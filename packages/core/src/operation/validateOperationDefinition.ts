import { ConfigurationError, ValidationError } from "../domain"
import type { AtomicBatchOperationDefinition, OperationDefinition, StandardOperationDefinition } from "./operationDefinition"
import type { RuntimeCapability } from "../bootstrap/runtimeCapabilities"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"
import { defineOperationDataAccess } from "./operationResources"

const AUDIT_GUARANTEES = new Set(["atomic", "durable", "best-effort"])
const RUNTIME_CAPABILITIES = new Set<RuntimeCapability>(["deferredExecution", "objectStore", "cache"])

export function validateOperationDefinition<TInput, TResult, TCommand>(
  definition: OperationDefinition<TInput, TResult, TCommand>,
): OperationDefinition<TInput, TResult, TCommand> {
  if (!definition || typeof definition !== "object") {
    throw new ValidationError("Operation definition must be an object.")
  }
  if (typeof definition.key !== "string" || definition.key.trim().length === 0) {
    throw new ValidationError("Operation definition key must be non-empty.")
  }

  const kind = (definition as unknown as { kind?: unknown }).kind
  if (kind !== "read" && kind !== "mutation") {
    throw new ValidationError(`Invalid operation kind for operation ${definition.key}.`)
  }
  if (definition.securitySensitive !== undefined && typeof definition.securitySensitive !== "boolean") {
    throw new ValidationError(`Security-sensitive operation flag must be boolean for operation ${definition.key}.`)
  }
  if (definition.kind === "mutation") {
    if (!definition.authorization || typeof definition.authorization.authorize !== "function") {
      throw new ConfigurationError(`Mutation operation ${definition.key} requires authorization.`)
    }
    if (!hasRequiredAtomicity(definition.atomicity)) {
      throw new ConfigurationError(`Mutation operation ${definition.key} requires required atomicity.`)
    }
  }
  if (definition.securitySensitive && (definition.kind !== "mutation" || !definition.authorization || !hasRequiredAtomicity(definition.atomicity))) {
    throw new ConfigurationError(`Security-sensitive operation ${definition.key} requires mutation authorization and required atomicity.`)
  }

  if (definition.audit !== undefined && (!definition.audit || typeof definition.audit !== "object" || Array.isArray(definition.audit))) throw new ValidationError("Audit configuration must be an object.")
  if (definition.audit?.required !== undefined && typeof definition.audit.required !== "boolean") throw new ValidationError("Audit required flag must be boolean.")
  if (definition.outbox !== undefined && (!definition.outbox || typeof definition.outbox !== "object" || typeof definition.outbox.required !== "boolean")) throw new ValidationError("Outbox configuration must declare a boolean required flag.")
  if ("atomicBatch" in definition && definition.atomicBatch !== undefined) {
    if (definition.kind !== "mutation" || definition.atomicity?.kind !== "standard" || definition.execution !== undefined) throw new ConfigurationError("Atomic-batch fallback cannot replace an explicit execution mode.")
    if (!definition.atomicBatch || typeof definition.atomicBatch.prepare !== "function") throw new ValidationError("Atomic-batch fallback requires prepare.")
    if (definition.atomicity.transactionOptions !== undefined) throw new ConfigurationError("Atomic-batch fallback cannot enforce interactive transaction options.")
    if (definition.audit?.auditGuarantee === "durable") throw new ConfigurationError("Atomic-batch fallback cannot enforce durable standard audit delivery.")
  }
  validateRuntimeCapabilities(definition)
  if (definition.dataAccess !== undefined) {
    const access = defineOperationDataAccess(definition.dataAccess)
    if (definition.kind === "mutation") {
      const mutableSources = new Set(access.resources.filter(resource => resource.access === "write").map(resource => resource.source ?? access.datasourceKey))
      if (mutableSources.size > 1) throw new ConfigurationError(`Mutation operation ${definition.key} cannot mutate more than one datasource in a local transaction; use a workflow or event boundary.`)
    }
  }

  const atomicity = definition.atomicity
  if (atomicity === undefined) {
    validateExecution(definition.execution, definition.key, "none")
    assertFunction("execute", (definition as Partial<StandardOperationDefinition<TInput, TResult>>).execute)
    validateAuditAndOutbox(definition, "none")
    return cloneAndFreezeDefinition(definition)
  }

  if (typeof atomicity !== "object" || atomicity === null) {
    throw new ValidationError(`Invalid atomicity configuration for operation ${definition.key}.`)
  }

  if (atomicity.kind === "standard") {
    assertExactKeys(atomicity, ["kind", "mode", "transactionOptions"], `standard atomicity for operation ${definition.key}`)
    assertFunction("execute", (definition as Partial<StandardOperationDefinition<TInput, TResult>>).execute)
    if (!["none", "preferred", "required"].includes(atomicity.mode)) {
      throw new ValidationError(`Invalid standard atomicity mode for operation ${definition.key}.`)
    }
    validateTransactionOptions(atomicity.transactionOptions, definition.key)
    validateExecution(definition.execution, definition.key, atomicity.mode)
    validateAuditAndOutbox(definition, atomicity.mode)
    return cloneAndFreezeDefinition(definition)
  }

  if (atomicity.kind !== "atomic-batch") {
    throw new ValidationError(`Invalid atomicity kind for operation ${definition.key}.`)
  }
  if (definition.execution !== undefined) {
    throw new ConfigurationError(`Execution modes cannot be combined with atomic-batch atomicity for operation ${definition.key}.`)
  }
  assertExactKeys(atomicity, ["kind"], `atomic-batch atomicity for operation ${definition.key}`)
  const batch = definition as AtomicBatchOperationDefinition<TInput, TResult, TCommand>
  if (batch.kind !== "mutation") {
    throw new ConfigurationError(`Atomic-batch operation ${definition.key} must be a mutation.`)
  }
  if (!batch.authorization || typeof batch.authorization.authorize !== "function") {
    throw new ConfigurationError(`Atomic-batch mutation ${definition.key} requires authorization.`)
  }
  assertFunction("prepare", batch.prepare)
  if ("execute" in batch) {
    throw new ConfigurationError(`Atomic-batch operation ${definition.key} cannot define execute.`)
  }
  if (batch.outbox?.required !== undefined && batch.outbox.required !== true) {
    throw new ValidationError(`Atomic-batch outbox configuration is invalid for operation ${definition.key}.`)
  }
  validateAuditAndOutbox(definition, "atomic-batch")
  return cloneAndFreezeDefinition(definition)
}

function validateExecution(execution: unknown, operationKey: string, mode: string): void {
  if (execution === undefined) return
  if (typeof execution !== "object" || execution === null) throw new ValidationError(`Invalid execution configuration for operation ${operationKey}.`)
  const candidate = execution as Record<string, unknown>
  if (candidate.kind === "transaction") {
    assertExactKeys(candidate, ["kind"], `execution for operation ${operationKey}`)
    if (mode === "none") throw new ConfigurationError(`Transaction execution requires transactional atomicity for operation ${operationKey}.`)
    return
  }
  if (candidate.kind !== "retryable-transaction") throw new ValidationError(`Invalid execution kind for operation ${operationKey}.`)
  assertExactKeys(candidate, ["kind", "maxAttempts", "delay", "backoff", "maxDelay"], `execution for operation ${operationKey}`)
  if (mode !== "required") throw new ConfigurationError(`Retryable transaction execution requires required atomicity for operation ${operationKey}.`)
  if (!Number.isInteger(candidate.maxAttempts) || (candidate.maxAttempts as number) < 1 || (candidate.maxAttempts as number) > 5) throw new ValidationError(`Execution maxAttempts must be an integer from 1 through 5 for operation ${operationKey}.`)
  if (!Number.isFinite(candidate.delay) || (candidate.delay as number) < 0) throw new ValidationError(`Execution delay must be finite and non-negative for operation ${operationKey}.`)
  if (!Number.isFinite(candidate.backoff) || (candidate.backoff as number) < 1) throw new ValidationError(`Execution backoff must be finite and at least 1 for operation ${operationKey}.`)
  if (!Number.isFinite(candidate.maxDelay) || (candidate.maxDelay as number) < (candidate.delay as number)) throw new ValidationError(`Execution maxDelay must be finite, non-negative, and at least delay for operation ${operationKey}.`)
}
function validateAuditAndOutbox<TInput, TResult, TCommand>(
  definition: OperationDefinition<TInput, TResult, TCommand>,
  atomicity: "none" | "preferred" | "required" | "atomic-batch",
): void {
  const audit = definition.audit
  if (audit) {
    if (!nonEmpty(audit.action) || !nonEmpty(audit.resourceType) || typeof audit.resolveResourceId !== "function") {
      throw new ValidationError(`Audit configuration is incomplete for operation ${definition.key}.`)
    }
    if (audit.auditGuarantee !== undefined && !AUDIT_GUARANTEES.has(audit.auditGuarantee)) {
      throw new ValidationError(`Invalid audit guarantee for operation ${definition.key}.`)
    }
    if (audit.fallbackAuditGuarantee !== undefined && audit.fallbackAuditGuarantee !== "best-effort") {
      throw new ValidationError(`Invalid fallback audit guarantee for operation ${definition.key}.`)
    }
    if (audit.required === true && (audit.auditGuarantee === undefined || audit.auditGuarantee === "best-effort" || audit.fallbackAuditGuarantee === "best-effort")) {
      throw new ConfigurationError(`Required audit cannot use best-effort delivery for operation ${definition.key}.`)
    }
    if (audit.auditGuarantee === "atomic" && atomicity !== "required" && atomicity !== "atomic-batch") {
      throw new ConfigurationError(`Atomic audit requires required atomicity for operation ${definition.key}.`)
    }
    if (audit.auditGuarantee === "durable" && atomicity !== "required" && audit.fallbackAuditGuarantee !== "best-effort") {
      throw new ConfigurationError(`Durable audit requires required standard atomicity for operation ${definition.key}.`)
    }
  }
  if (definition.outbox?.required && atomicity !== "required" && atomicity !== "atomic-batch") {
    throw new ConfigurationError(`Required outbox requires required atomicity for operation ${definition.key}.`)
  }
}

function hasRequiredAtomicity(atomicity: OperationDefinition<unknown, unknown, unknown>["atomicity"]): boolean {
  return atomicity?.kind === "atomic-batch" || (atomicity?.kind === "standard" && atomicity.mode === "required")
}

function validateTransactionOptions(options: unknown, operationKey: string): void {
  if (options === undefined) return
  if (typeof options !== "object" || options === null) {
    throw new ValidationError(`Invalid transaction options for operation ${operationKey}.`)
  }
  assertExactKeys(options, ["isolationLevel", "accessMode", "timeoutMs"], `transaction options for operation ${operationKey}`)
  const candidate = options as { isolationLevel?: unknown; accessMode?: unknown; timeoutMs?: unknown }
  if (candidate.timeoutMs !== undefined && (!Number.isSafeInteger(candidate.timeoutMs) || (candidate.timeoutMs as number) < 1 || (candidate.timeoutMs as number) > 3_600_000)) {
    throw new ValidationError(`Transaction timeoutMs must be an integer from 1 to 3600000 for operation ${operationKey}.`)
  }
  if (candidate.isolationLevel !== undefined && !["read committed", "repeatable read", "serializable"].includes(candidate.isolationLevel as string)) {
    throw new ValidationError(`Invalid transaction isolation level for operation ${operationKey}.`)
  }
  if (candidate.accessMode !== undefined && !["read only", "read write"].includes(candidate.accessMode as string)) {
    throw new ValidationError(`Invalid transaction access mode for operation ${operationKey}.`)
  }
}

function validateRuntimeCapabilities<TInput, TResult, TCommand>(
  definition: OperationDefinition<TInput, TResult, TCommand>,
): void {
  const capabilities = definition.requiredRuntimeCapabilities
  if (capabilities === undefined) return
  if (!Array.isArray(capabilities)) {
    throw new ValidationError(`Runtime capabilities must be an array for operation ${definition.key}.`)
  }
  const seen = new Set<string>()
  for (const capability of capabilities) {
    if (typeof capability !== "string" || !RUNTIME_CAPABILITIES.has(capability as RuntimeCapability)) {
      throw new ValidationError(`Invalid runtime capability for operation ${definition.key}.`)
    }
    if (seen.has(capability)) {
      throw new ValidationError(`Duplicate runtime capability for operation ${definition.key}.`)
    }
    seen.add(capability)
  }
}

function assertExactKeys(value: object, allowed: string[], description: string): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new ValidationError(`Unknown property "${key}" in ${description}.`)
  }
}

function assertFunction(name: string, value: unknown): asserts value is (...args: never[]) => unknown {
  if (typeof value !== "function") throw new ValidationError(`Operation ${name} must be a function.`)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}
