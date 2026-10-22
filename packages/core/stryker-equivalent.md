# Stryker equivalent and unreachable mutants

Mutants listed here are not killable by any test because the branch is unreachable after
`validateOperationDefinition`. One line per location: file:line, mutators, reason.

- src/operation/atomicBatchOperationPipeline.ts:54-56, ConditionalExpression/LogicalOperator/StringLiteral: `atomicBatchScope === "tenant-scoped"` with no tenant-scoped contract is rejected earlier by `supportsAtomicBatch`, so the throw is dead.
- src/operation/standardOperationPipeline.ts:222, ConditionalExpression/LogicalOperator/StringLiteral: `required: true` with best-effort delivery is rejected by `validateOperationDefinition` before preflight.
- src/operation/standardOperationPipeline.ts:224, ConditionalExpression/LogicalOperator/StringLiteral: a transactional (atomic) audit with non-required atomicity is rejected by `validateOperationDefinition`.
- src/operation/standardOperationPipeline.ts:95-97, ConditionalExpression/LogicalOperator/StringLiteral: mutations require required atomicity, so a run outside a transaction cannot register durable outbox records.
