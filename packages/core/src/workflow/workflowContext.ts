import type { WorkflowStepContext } from "./types"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"

export function createWorkflowContext(context: WorkflowStepContext): WorkflowStepContext {
  return Object.freeze({ ...context, executionScope: cloneAndFreezeDefinition(context.executionScope, true), variables: cloneAndFreezeDefinition(context.variables, true) })
}
