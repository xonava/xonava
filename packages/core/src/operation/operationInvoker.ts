import { ConfigurationError } from "../domain"
import type { OperationDefinition } from "./operationDefinition"
import type { OperationEnvironment } from "./operationRunContext"
import { runComposedOperation } from "./operationPipeline"
import { assertExecutionActive } from "./deadline"
import { DEFAULT_EXECUTION_BUDGET, validateExecutionBudget } from "./executionBudget"

export interface OperationInvoker {
  invoke<TInput, TResult, TCommand = unknown>(definition: OperationDefinition<TInput, TResult, TCommand>, input: TInput): Promise<TResult>
}

/**
 * Creates a child-operation boundary. Identity, scope, correlation, signal and
 * deadline are inherited. Works for request-bound environments: the request's
 * route binding is not applied to the composed operation. The child still executes its own authorization and
 * receives a fresh effect collector; it cannot finalize or mutate its parent's
 * collected obligations.
 */
export function createOperationInvoker(parent: OperationEnvironment): OperationInvoker {
  const budget = validateExecutionBudget(parent.executionBudget ?? DEFAULT_EXECUTION_BUDGET)
  const depth = parent.nestingDepth ?? 0
  if (!Number.isSafeInteger(depth) || depth < 0) throw new ConfigurationError("Operation nesting depth must be a non-negative safe integer")
  return Object.freeze({
    async invoke<TInput, TResult, TCommand = unknown>(definition: OperationDefinition<TInput, TResult, TCommand>, input: TInput): Promise<TResult> {
      if (depth + 1 > budget.maxNestingDepth) throw new ConfigurationError(`Operation nesting depth exceeds ${budget.maxNestingDepth}`)
      const signal = parent.signal ?? new AbortController().signal
      // Computed per invocation: each composed operation gets its own budget
      // unless the environment carries an explicit deadline.
      const deadline = parent.deadline ?? { expiresAt: new Date(parent.services.clock.now().getTime() + budget.maxDurationMs) }
      assertExecutionActive(signal, deadline, parent.services.clock)
      const child = { ...parent, signal, deadline, executionBudget: budget, nestingDepth: depth + 1 }
      // Parent commit obligations belong to the parent business result only.
      Reflect.deleteProperty(child, "commitMarkers")
      // Explicit composition: a request's route stays bound to the operation
      // it dispatches, but an operation composed through this invoker is not
      // that operation. It still runs its own authorization.
      return runComposedOperation({
        operation: child,
        definition,
        input,
      })
    },
  })
}
