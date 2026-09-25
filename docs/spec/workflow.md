# Workflows

## Scope and data model

A workflow declares a versioned state machine, inputs, transitions, activities, timers, signals, compensation, and store requirements. Only valid transitions MAY commit. Durable transitions MUST be atomic with their declared state/effects.

Instance identity, definition/version, current state, revision, scoped data, pending timers/activities, signal receipts, and claim/fencing state are durable. Each transition conditions on current revision/claim so concurrent stale workers cannot overwrite state.

## Runtime requirements

Claims MUST be fenced. A worker MUST renew its claim immediately before invoking activity or compensation code, renew it periodically while work is active, and re-fence before commit. Renewals for one claim MUST be serialized and monotonically extend expiry. Every durable transition MUST condition on the same worker/token/revision fence and an unexpired lease. The dispatcher MUST bound step execution, propagate cooperative cancellation and an absolute deadline, stop and await its renewal lifecycle, and reject oversized claim batches. Signals MUST be idempotent where retry is possible. Timers MUST survive process restart. Compensation order/outcomes MUST be explicit. Version migration MUST be deterministic and reject unsupported state versions.

Activities may be retried only under declared idempotency/retry semantics. A workflow cannot assume exactly-once external side effects: activity implementations remain responsible for idempotency or a transactionally coupled effect mechanism. Steps MUST observe cancellation and revalidate the current lease immediately before external activity. Lease fencing does not turn an external side effect into an exactly-once operation, and a runtime cannot forcibly stop a step that ignores cooperative cancellation. Compensation is a durable transition sequence, not rollback of already committed external work. Migration runs before new-version transition logic and preserves auditability.

## Errors and conformance

Invalid transition/input/signal is validation or conflict as defined; stale claim/revision conflict; unsupported version configuration; activity failure follows retry/compensation policy. Conformance covers transition tables, concurrent signals, duplicate signal receipts, timer recovery, stale fencing, activity retry, compensation ordering/failure, migration, and crash at every durable boundary.

Traceability: `packages/core/src/workflow`; workflow unit and provider integration suites; W1 certification.
