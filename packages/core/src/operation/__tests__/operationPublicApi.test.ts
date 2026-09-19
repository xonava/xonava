import { describe, expect, expectTypeOf, it } from "vitest"
import * as operationApi from ".."
import type {
  AtomicBatchAtomicity,
  AtomicBatchPreparationContext,
  OperationAtomicity,
  OperationDefinition,
  PreparedAtomicBatch,
  StandardAtomicityMode,
  StandardOperationDefinition,
} from ".."
import type { CrudMutationHookContext, CrudReadHookContext } from "../../entity"
import type { MutationOperationContext, PostCommitContext, ReadOperationContext, RepresentationContext } from "../operationContext"

// OperationRunContext is an implementation detail and must not be part of the public barrel.
// @ts-expect-error OperationRunContext is intentionally not publicly exported.
import type { OperationRunContext as _OperationRunContext } from ".."

// Effect collectors are implementation details and must not be part of the public barrel.
// @ts-expect-error OperationEffectCollector is intentionally not publicly exported.
import type { OperationEffectCollector as _OperationEffectCollector } from ".."

describe("operation public API", () => {
  it("preserves the public operation environment contracts", () => {
    expectTypeOf<ReadOperationContext>().toHaveProperty("persistence")
    expectTypeOf<RepresentationContext>().not.toHaveProperty("persistence")
    expectTypeOf<PostCommitContext>().toHaveProperty("addBestEffortEffect")
    expectTypeOf<PostCommitContext>().not.toHaveProperty("persistence")
    expectTypeOf<MutationOperationContext>().toHaveProperty("addDurableEffect")
    expectTypeOf<CrudReadHookContext["operation"]>().not.toHaveProperty("persistence")
    expectTypeOf<CrudMutationHookContext["operation"]>().not.toHaveProperty("addOutboxRecord")
  })

  it("exposes the operation definition contracts", () => {
    expectTypeOf<OperationAtomicity>().toEqualTypeOf<
       | { kind: "standard"; mode: StandardAtomicityMode; transactionOptions?: import("../../persistence").TransactionOptions }
      | AtomicBatchAtomicity
    >()
    expectTypeOf<StandardOperationDefinition<{ input: string }, string>>().toMatchTypeOf<OperationDefinition<{ input: string }, string>>()
    expectTypeOf<PreparedAtomicBatch<string, number>>().toHaveProperty("commands")
    expectTypeOf<AtomicBatchPreparationContext>().toHaveProperty("addCommand")
  })

  it("exports only the operation entry points at runtime", () => {
    expect(Object.keys(operationApi).sort()).toEqual([
      "DEFAULT_EXECUTION_BUDGET",
      "OperationCommittedEffectError",
      "assertExecutionActive",
      "createExecutionDeadline",
      "createOperation",
      "createOperationContext",
      "createOperationInvoker",
      "createOperationServices",
      "defineInfrastructureRawDataAccess",
      "defineOperationDataAccess",
      "runOperation",
      "runOperationDetailed",
      "validateExecutionBudget",
    ])
  })
})
