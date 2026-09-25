# Jobs, schedules, and workflow execution

## Scope and data model

Jobs and schedules MUST have stable definitions, canonical execution scope, bounded retry, and versioned payload/progress where durable. Claims MUST carry fencing identity; a stale or expired owner MUST NOT update progress, complete, or reschedule work.

Job identity/fingerprint binds definition, version, scoped payload, and idempotency namespace where applicable. Durable status transitions are explicit (pending/claimable, running, retryable, succeeded, terminal failure/cancelled as supported). Progress is monotonic according to the job contract and written only by current claim.

## Dispatch, retry, and scheduling

Dispatch MUST honor cancellation, deadline, retry policy, and idempotency. Schedule lifecycle transitions and next-run calculation MUST be deterministic for the declared time basis. Payload migration MUST be explicit and reject unknown unsupported versions.

Retry policy bounds attempts and delay and MUST NOT exceed enclosing expiry/deadline. Schedules define timezone/time basis, cadence, missed-run behavior, overlap policy, and enabled lifecycle. Concurrent dispatchers MUST not both commit ownership for one occurrence. Job, schedule, and workflow lease renewals for one claim MUST be serialized, atomically verify the fencing token, move expiry monotonically forward, and settle before the dispatcher releases its renewal lifecycle. A pending renewal MUST settle before successful job/workflow completion can commit.

## Errors and conformance

Unknown definitions/payload versions are validation/configuration failures; stale tokens conflict; handler failures follow retry policy; store failures preserve claim/fencing. Conformance covers fingerprint stability, claim races, lease expiry/reclaim, stale progress/completion, retry exhaustion, payload migration, schedule boundaries/overlap, cancellation, and process termination/restart.

Traceability: `packages/core/src/execution`; PG/D1/MySQL job and schedule suites; L1/J1 certification.
