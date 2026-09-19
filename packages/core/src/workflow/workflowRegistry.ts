import type { WorkflowDefinition, WorkflowUpcaster } from "./types"
import { defineWorkflow } from "./workflowDefinition"
import { WorkflowDefinitionError, WorkflowVersionError } from "./workflowErrors"

export interface WorkflowRegistry {
  register(definition: WorkflowDefinition): void
  get(type: string, version: number): WorkflowDefinition | undefined
  decode(type: string, version: number, variables: unknown, targetVersion?: number): { definition: WorkflowDefinition; variables: Readonly<Record<string, unknown>> }
}

export function createWorkflowRegistry(upcasters: readonly WorkflowUpcaster[] = []): WorkflowRegistry {
  const definitions = new Map<string, WorkflowDefinition>()
  const key = (type: string, version: number) => `${type}@${version}`
  return {
    register(input) { const definition = defineWorkflow(input); const k = key(definition.type, definition.version); if (definitions.has(k)) throw new WorkflowDefinitionError(`Workflow already registered: ${k}`); definitions.set(k, definition) },
    get(type, version) { return definitions.get(key(type, version)) },
    decode(type, version, input, targetVersion) {
      const versions = [...definitions.values()].filter(value => value.type === type).map(value => value.version)
      const target = targetVersion ?? Math.max(...versions)
      if (!Number.isFinite(target)) throw new WorkflowVersionError(`Unknown workflow type: ${type}`)
      let current = version; let value = input
      while (current < target) { const upcaster = upcasters.find(item => item.type === type && item.from === current && item.to === current + 1); if (!upcaster) throw new WorkflowVersionError(`Missing workflow upcaster: ${type}@${current}->${current + 1}`); value = upcaster.upcast(value); current++ }
      if (current !== target) throw new WorkflowVersionError(`Workflow cannot be downcast: ${type}@${version}->${target}`)
      const definition = definitions.get(key(type, target)); if (!definition) throw new WorkflowVersionError(`Unknown workflow definition: ${type}@${target}`)
      return { definition, variables: definition.decodeVariables(value) }
    },
  }
}
