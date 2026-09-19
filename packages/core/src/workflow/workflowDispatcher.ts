import type { WorkflowStore } from "../workflow/store"
import { applyWorkflowStep, completeCompensation } from "./workflowStateMachine"
import { createWorkflowContext } from "./workflowContext"
import type { WorkflowRegistry } from "./workflowRegistry"

export interface WorkflowDispatchResult { claimed: number; advanced: number; compensated: number; leaseLost: number; failed: number }

async function assertCurrentLease(store:WorkflowStore,fence:Parameters<WorkflowStore["commit"]>[0]):Promise<boolean>{
  return store.assertLease(fence)
}

export async function dispatchWorkflows(args: { store: WorkflowStore; registry: WorkflowRegistry; workerId: string; claimLimit: number; leaseDurationMs: number; now?: () => Date }): Promise<WorkflowDispatchResult> {
  const now = args.now ?? (() => new Date())
  const claims = await args.store.claimDue({ workerId: args.workerId, limit: args.claimLimit, leaseDurationMs: args.leaseDurationMs, now: now() })
  const result: WorkflowDispatchResult = { claimed: claims.length, advanced: 0, compensated: 0, leaseLost: 0, failed: 0 }
  for (const claim of claims) {
    const instance = claim.instance
    const fence = { instanceId: instance.id, workerId: claim.workerId, claimToken: claim.claimToken, revision: instance.revision }
    try {
      if(!await assertCurrentLease(args.store,fence)){result.leaseLost++;continue}
    } catch {
      result.failed++
      continue
    }
    let next
    let successfulTransition:"advanced"|"compensated"|undefined
    try {
      const decoded = args.registry.decode(instance.workflowType, instance.workflowVersion, instance.variables)
      if (instance.status === "compensating") {
        const compensation = instance.compensationStack.at(-1)
        const step = compensation ? decoded.definition.steps[compensation] : undefined
        if (!step?.compensate) throw new Error(`Missing compensation step: ${String(compensation)}`)
        await step.compensate(createWorkflowContext({ instanceId: instance.id, executionScope: instance.executionScope, attempt: instance.stepAttempt, variables: decoded.variables, datasource: step.datasource }))
        next = completeCompensation(instance, now())
        successfulTransition="compensated"
      } else {
        const step = decoded.definition.steps[instance.currentStep]
        if (!step) throw new Error(`Unknown workflow step: ${instance.currentStep}`)
        const stepResult = await step.execute(createWorkflowContext({ instanceId: instance.id, executionScope: instance.executionScope, attempt: instance.stepAttempt, variables: decoded.variables, datasource: step.datasource }))
        next = applyWorkflowStep(instance, stepResult, now())
        successfulTransition="advanced"
      }
    } catch {
      result.failed++
      next = applyWorkflowStep(instance, { kind: "fail", error: "workflow step failed" }, now())
      successfulTransition=undefined
    }
    try {
      if (!await args.store.commit(fence, next)) result.leaseLost++
      else if(successfulTransition==="compensated")result.compensated++
      else if(successfulTransition==="advanced")result.advanced++
    } catch { result.failed++ }
  }
  return result
}
