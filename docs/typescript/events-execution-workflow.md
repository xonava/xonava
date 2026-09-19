# Events, execution, and workflow APIs

`core/events` exposes event/envelope/version/consumer registries plus audit, idempotency, inbox/outbox, and lease contracts. `core/execution` exposes job/schedule registries, retry, progress, dispatch, and fingerprints. `core/workflow` exposes definitions, registry, state machine, context, dispatcher, errors, version, and store.

Register versioned definitions before dispatch. Store implementations come from certified adapters. Handle stale claim/version errors as concurrency outcomes, not generic retries. Workflow durable values are bounded; use `defineWorkflow` and `createWorkflowRegistry`, then dispatch only with a fenced `WorkflowStore`. Do not perform non-idempotent external work under an assumption of exactly-once delivery.
