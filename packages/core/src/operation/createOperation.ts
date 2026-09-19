import type { OperationEnvironment } from "./operationContext"
import { runOperation, runOperationDetailed } from "./operationPipeline"
import type { OperationDefinition } from "./operationDefinition"
import { validateOperationDefinition } from "./validateOperationDefinition"
import type { OperationOutcome } from "./operationPipeline"

export interface OperationRunner<TInput, TResult> {
  readonly key: string
  readonly definition: Readonly<OperationDefinition<TInput, TResult>>
  run(args: {
    operation: OperationEnvironment
    input: TInput
  }): Promise<TResult>
  runDetailed(args: {
    operation: OperationEnvironment
    input: TInput
  }): Promise<OperationOutcome<TResult>>
}

export function createOperation<TInput, TResult>(
  definition: OperationDefinition<TInput, TResult>,
): OperationRunner<TInput, TResult> {
  const validatedDefinition = validateOperationDefinition(definition)
  return {
    key: validatedDefinition.key,
    definition: validatedDefinition,
    async run(args) {
      return runOperation({
        operation: args.operation,
        definition: validatedDefinition,
        input: args.input,
      })
    },
    async runDetailed(args) {
      return runOperationDetailed({
        operation: args.operation,
        definition: validatedDefinition,
        input: args.input,
      })
    },
  }
}
