# Operations

## Scope and definition

An operation definition declares identity, input/output validation, authorization requirements, budget, required services/capabilities, handler, hooks, and effects. Creation MUST reject invalid or contradictory definitions.

Inputs are validated before handler behavior. Authorization plans are created from trusted context and attenuated for nested operations. Required services are capability-checked before use. Hooks receive only their declared context and MUST NOT gain mutable privileged persistence accidentally.

## Execution and effects

Execution MUST use an active attenuated context. Deadlines, cancellation, nested budgets, and authorization MUST be checked at defined boundaries. Effects MUST be registered only while the collector is active and drained at most once. A committed primary mutation followed by a non-atomic effect failure MUST be distinguishable from an uncommitted operation failure.

Transport parsing and response formatting are outside the operation.

Nested operations MUST consume from the enclosing budget/deadline and MUST NOT amplify authority. Cancellation prevents new work but cannot retroactively undo a committed transaction. Atomic effects are submitted inside the provider transaction/batch; post-commit effects expose warning/failure semantics separately.

## Errors and conformance

Invalid definitions/input are validation; denial authorization; missing service capability/configuration; deadline/cancellation execution failure; closed/disposed/drained effects stable lifecycle errors. Conformance covers ordering, hook trust boundaries, nested attenuation/budgets, cancellation/deadline, atomic and post-commit effects, committed-effect failure, and telemetry redaction.

Traceability: `packages/core/src/operation`; operation and adversarial suites; OP1/S1/T1 certification.
