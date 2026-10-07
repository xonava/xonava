import type { WorkflowSignal, WorkflowStepContext } from "./types"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"

function freezeSignal(signal: WorkflowSignal): WorkflowSignal {
  return Object.freeze({
    id: signal.id,
    instanceId: signal.instanceId,
    name: signal.name,
    payload: cloneAndFreezeDefinition(signal.payload, true),
    deliveredAt: new Date(signal.deliveredAt.getTime()),
  })
}

export function createWorkflowContext(context: WorkflowStepContext): WorkflowStepContext {
  return Object.freeze({
    ...context,
    executionScope: cloneAndFreezeDefinition(context.executionScope, true),
    variables: cloneAndFreezeDefinition(context.variables, true),
    ...(context.signal !== undefined ? { signal: freezeSignal(context.signal) } : {}),
  })
}
