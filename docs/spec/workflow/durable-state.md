# Workflow

A workflow definition has a stable type and positive version, a named initial step, versioned durable variables, and explicit step transitions. Outcomes are next, wait, retry, complete, fail, or compensate.

Workers claim instances using leases and commit with instance revision plus claim fencing. Signals are durably idempotent. Compensation executes recorded actions in reverse order. Version migration is explicit and deterministic; a worker never silently interprets unknown durable versions.
