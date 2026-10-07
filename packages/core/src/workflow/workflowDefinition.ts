import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"
import { canonicalJsonString } from "../serialization/canonicalJson"
import type { WorkflowDefinition } from "./types"
import { WorkflowDefinitionError } from "./workflowErrors"
import { validateBackoffPolicy } from "../resilience/backoff"

export const MAX_WORKFLOW_DURABLE_BYTES = 65_536
export function assertWorkflowDurableValue(value: Readonly<Record<string, unknown>>, label = "Workflow variables"): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowDefinitionError(`${label} must be an object`)
  const bytes = new TextEncoder().encode(canonicalJsonString(value)).byteLength
  if (bytes > MAX_WORKFLOW_DURABLE_BYTES) throw new WorkflowDefinitionError(`${label} exceeds ${MAX_WORKFLOW_DURABLE_BYTES} durable bytes`)
}

export function defineWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  if (!definition.type.trim()) throw new WorkflowDefinitionError("Workflow type must be non-empty")
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new WorkflowDefinitionError("Workflow version must be a positive integer")
  if (!definition.steps[definition.initialStep]) throw new WorkflowDefinitionError("Workflow initial step is not defined")
  for (const [key, step] of Object.entries(definition.steps)) {
    if (key !== step.name || !step.datasource.trim()) throw new WorkflowDefinitionError(`Invalid workflow step: ${key}`)
    if (typeof step.execute !== "function" || (step.compensate !== undefined && typeof step.compensate !== "function")) throw new WorkflowDefinitionError(`Workflow step ${key} handlers must be functions`)
    if (step.idempotent !== undefined && typeof step.idempotent !== "boolean") throw new WorkflowDefinitionError(`Workflow step ${key} idempotent must be a boolean`)
    try {
      if (step.retry !== undefined) validateBackoffPolicy(step.retry, `Workflow step ${key} retry`)
      if (step.compensationRetry !== undefined) validateBackoffPolicy(step.compensationRetry, `Workflow step ${key} compensationRetry`)
    } catch (error) {
      throw new WorkflowDefinitionError(error instanceof Error ? error.message : `Workflow step ${key} retry policy is invalid`, error)
    }
  }
  return cloneAndFreezeDefinition(definition)
}
