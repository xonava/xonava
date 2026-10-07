# Operations

## Scope and definition

An operation definition declares identity, input/output validation, authorization requirements, budget, required services/capabilities, handler, hooks, and effects. Creation MUST reject invalid or contradictory definitions.

Inputs are validated before handler behavior. Authorization plans are created from trusted context and attenuated for nested operations. Required services are capability-checked before use. Hooks receive only their declared context and MUST NOT gain mutable privileged persistence accidentally.

## Execution and effects

Execution MUST use an active attenuated context. Deadlines, cancellation, nested budgets, and authorization MUST be checked at defined boundaries. Effects MUST be registered only while the collector is active and drained at most once. A committed primary mutation followed by a non-atomic effect failure MUST be distinguishable from an uncommitted operation failure.

Transport parsing and response formatting are outside the operation.

Nested operations MUST consume from the enclosing budget/deadline and MUST NOT amplify authority. Cancellation prevents new work but cannot retroactively undo a committed transaction. Atomic effects are submitted inside the provider transaction/batch; post-commit effects expose warning/failure semantics separately.

## Nested operations (normative)

An operation's `execute` context exposes `invoke(definition, input)`. The child inherits identity, scope, correlation, signal, and deadline, runs its own authorization against the unconstrained persistence of the parent's run, and counts against `maxNestingDepth`. When the parent runs in a transaction the child joins it: the child's writes and durable effects commit or roll back with the parent, and the child's post-commit work (its `afterCommit` hooks and best-effort effects) runs only after the parent commits, reporting failures on the parent's outcome. A child that manages its own transaction retries or uses an atomic batch cannot join a transaction. A parent whose child failed, or is still running when `execute` returns, MUST NOT commit. Read operations may invoke only read operations. `createOperationInvoker(environment)` composes top-level operations that each own their transaction.

The request's `signal` and `deadline` bound the operation together with the environment's: the run aborts when either signal aborts and expires at the earlier deadline.

## Errors and conformance

Invalid definitions/input are validation; denial authorization; missing service capability/configuration; deadline/cancellation execution failure; closed/disposed/drained effects stable lifecycle errors. Conformance covers ordering, hook trust boundaries, nested attenuation/budgets, cancellation/deadline, atomic and post-commit effects, committed-effect failure, and telemetry redaction.

Traceability: `packages/core/src/operation`; operation and adversarial suites; OP1/S1/T1 certification.

## Post-commit outcome contract (normative)

Once an operation's business transaction (or atomic batch) has committed, best-effort post-commit work — `onBusinessResult`, `afterCommit` hooks, and best-effort effects — MUST NOT turn the operation into an error, in either pipeline. A caller that saw an error would retry and duplicate a committed mutation. Each such failure MUST instead be reported through telemetry (`operation.effect.failure`), the optional `onCommittedEffectFailure` environment handler (whose own failures are ignored), and `runOperationDetailed().postCommitEffectFailures` (at most 100 retained records per operation). Work that must not be lost belongs in the transactional outbox (`addDurableEffect`).

When an atomic-batch `after` (representation) hook fails after the batch committed, there is no correct result to return: the pipeline throws `OperationCommittedEffectError` with `committed: true`, `operationId`, and the committed result. Callers and transports MUST treat it as committed and MUST NOT retry the mutation.

## Transaction retry (normative)

`execution: { kind: "retryable-transaction" }` re-runs the whole transaction callback, with a fresh effect scope, only when the failed attempt is known not to have committed: the callback threw a `RetryablePersistenceError` (the provider rolls the transaction back, including every outbox record, audit row, and commit marker it wrote), or the provider reports `TransactionRolledBackError` at commit. Any other failure after the callback returned has an unknown commit outcome and is never retried. Retries use jittered exponential backoff (`delay`, `backoff`, `maxDelay`), stop immediately when the operation signal aborts, and give up with the last error rather than wait past the execution deadline.
