# Operations

## Scope and definition

An operation definition declares identity, input/output validation, authorization requirements, budget, required services/capabilities, handler, hooks, and effects. Creation MUST reject invalid or contradictory definitions.

Inputs are validated before handler behavior. Authorization plans are created from trusted context and attenuated for nested operations. Required services are capability-checked before use. Hooks receive only their declared context and MUST NOT gain mutable privileged persistence accidentally.

## Execution and effects

Execution MUST use an active attenuated context. Deadlines, cancellation, nested budgets, and authorization MUST be checked at defined boundaries. Effects MUST be registered only while the collector is active and drained at most once. A committed primary mutation followed by a non-atomic effect failure MUST be distinguishable from an uncommitted operation failure.

Transport parsing and response formatting are outside the operation.

Nested operations MUST consume from the enclosing budget/deadline and MUST NOT amplify authority. Cancellation prevents new work but cannot retroactively undo a committed transaction. Atomic effects are submitted inside the provider transaction/batch; post-commit effects expose warning/failure semantics separately.

## Nested operations (normative)

An operation's `execute` context exposes `invoke(definition, input)`. The child inherits identity, scope, correlation, signal, and deadline, runs its own authorization against the unconstrained persistence of the parent's run, and counts against `maxNestingDepth`. When the parent runs in a transaction the child joins it: the child's writes and durable effects commit or roll back with the parent, and the child's post-commit work (its `afterCommit` hooks and best-effort effects) runs only after the parent commits, reporting failures on the parent's outcome. A child that manages its own transaction retries or uses an atomic batch cannot join a transaction. A parent whose child failed, or is still running when `execute` returns, MUST NOT commit. When the parent's `execute` fails, its running children are cancelled through their signal and awaited (bounded by the parent's deadline) before the transaction ends. Once the parent's `execute` has ended, a joined child's persistence fails closed with `OperationContextInactiveError` and new `invoke` calls are refused. A child's `afterCommit` runs after the parent commits under the same rules as a top-level `afterCommit`; re-queuing a child's post-commit work never throws after commit. Read operations may invoke only read operations. `createOperationInvoker(environment)` composes top-level operations that each own their transaction.

Savepoints are not provided: a joined child cannot roll back its own writes while the parent continues. A child that must be able to fail without failing the parent runs as a separate top-level operation through `createOperationInvoker`. Adding opt-in savepoints on PostgreSQL and MySQL later would not change this contract, because D1 cannot offer them.

The request's `signal` and `deadline` bound the operation together with the environment's: the run aborts when either signal aborts and expires at the earlier deadline.

## Errors and conformance

Invalid definitions/input are validation; denial authorization; missing service capability/configuration; deadline/cancellation execution failure; closed/disposed/drained effects stable lifecycle errors. Conformance covers ordering, hook trust boundaries, nested attenuation/budgets, cancellation/deadline, atomic and post-commit effects, committed-effect failure, and telemetry redaction.

Traceability: `packages/core/src/operation`; operation and adversarial suites; OP1/S1/T1 certification.

## Post-commit outcome contract (normative)

Once an operation's business transaction (or atomic batch) has committed, best-effort post-commit work — `onBusinessResult`, `afterCommit` hooks, and best-effort effects — MUST NOT turn the operation into an error, in either pipeline. A caller that saw an error would retry and duplicate a committed mutation. Each such failure MUST instead be reported through telemetry (`operation.effect.failure`), the optional `onCommittedEffectFailure` environment handler (whose own failures are ignored), and `runOperationDetailed().postCommitEffectFailures` (at most 100 retained records per operation). Work that must not be lost belongs in the transactional outbox (`addDurableEffect`).

When an atomic-batch `after` (representation) hook fails after the batch committed, there is no correct result to return: the pipeline throws `OperationCommittedEffectError` with `committed: true`, `operationId`, and the committed result. Callers and transports MUST treat it as committed and MUST NOT retry the mutation.

## Transaction retry (normative)

`execution: { kind: "retryable-transaction" }` re-runs the whole transaction callback, with a fresh effect scope, only when the failed attempt is known not to have committed: the callback threw a `RetryablePersistenceError` (the provider rolls the transaction back, including every outbox record, audit row, and commit marker it wrote), or the provider reports `TransactionRolledBackError` at commit. Any other failure after the callback returned has an unknown commit outcome and is never retried. Retries use jittered exponential backoff (`delay`, `backoff`, `maxDelay`), stop immediately when the operation signal aborts, and give up with the last error rather than wait past the execution deadline.

## Business actions (normative)

A business action is a domain verb on a module, such as `approve`, `reject` or `ship`, that is authorized by its own grant and is not an `update` of the row. `createFrameworkWriteHandler` accepts `action: "create" | "update" | "delete" | <business action name>`.

**Name.** A business action name matches `/^[a-z][a-zA-Z0-9_-]{0,63}$/` and MUST NOT be `read`, `manage`, `create`, `update` or `delete`. The handler checks this at construction and throws `ConfigurationError` otherwise.

**Route binding.** The handler normalizes its request against `requestNormalization.routeBindings[routeKey]`. The optional `routeKey` argument defaults to `action`. The binding map is the five CRUD bindings plus any number of additional bindings keyed by string. A `routeKey` with no binding is a `ConfigurationError` at handler construction, never at request time. The binding's `operationKey` MUST equal the handler definition's `key`, as for CRUD.

**Authorization.** The action string is the only thing that grants a business action:

- The ABAC catalog (`defineAbacModule`) lists the action, and policies grant it by naming it in `payload.actions` (`validatePayloadAgainstCatalog` rejects unknown actions). A policy that lists `approve` and not `update` admits `approve` and refuses `update`; a policy that lists `update` and not `approve` does the reverse. There is no implicit `update`, in either direction.
- Module admission (`authorizeFrameworkModule`, `assertFrameworkAuthorization`) passes the action string to `enabledModuleActions` and to the ABAC collection-action check. An `enabledModuleActions` list that contains `manage` allows every action, business actions included; this existing behaviour is unchanged. Module admission is applied in tenant scope only, as for CRUD.
- A deny policy on the action wins by the usual tier rules, and field write restrictions (`fieldAccess.write`) are resolved for the business action's own policies.
- The business operation enforces the write by calling `operation.enforceAbac.enforce(action, record, changedFields)`, which reaches `AbacAuthorizer.assertWrite` and `enforceAbacWrite` with the action as a plain string. `evaluateWriteConditionTruth` special-cases only `create`, so a business action is evaluated like `update`: an UNKNOWN condition fails closed (an allow grants nothing, a deny applies), and the field-write tier and the record decision are checked against both the pre-image (`existing`) and the post-image.
- The bundle is resolved on every request and its `securityDigest` is part of the idempotency fingerprint. Revoking a grant by issuing a new bundle refuses the next call, and a receipt created under the old bundle is not replayed under the new one.

**Idempotency and rate limits.** The idempotency scope (`<scope>:<moduleKey>:<action>:principal:<identity>`), the idempotency fingerprint and the rate-limit key (`<scopeId>:<moduleKey>:<action>:<principal and ip>`) all include the action. A key used for `approve` is therefore independent of the same key used for `update`: it cannot replay the other action's response. Reusing a key for a different `approve` request is a 409 conflict.

**Atomicity.** A business action is an ordinary standard or atomic-batch mutation. Its audit record, outbox records and idempotency receipt commit with the business change and roll back with it.

**Reserving fields (`protectedFields`).** `CRUD(definition, { update: { protectedFields } })` lists entity fields that only a business action may change. A generic update whose patch contains any of them, including a patch produced by `transformInput`, is refused with `ForbiddenError` (403). The names MUST be entity fields; `CRUD()` throws `ConfigurationError` otherwise. They are added to the always-protected set (primary key, tenant field, version field, `immutableFields`).

Traceability: `packages/adapters/src/http/createFrameworkWriteHandler.ts`, `packages/adapters/src/http/crud.ts`, `packages/adapters/src/http/__tests__/businessActionWrites.test.ts`.
