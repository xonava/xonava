# Events, audit, idempotency, inbox, and outbox

## Scope and envelope

Events MUST have stable identity, type, version, occurrence time, and scoped payload. Unknown event versions MUST NOT be silently interpreted as a known format.

Envelope and payload limits/classification MUST be validated before durable append or delivery. Event identity is stable across retries. Upcasting is deterministic, registered, and does not mutate stored historical bytes.

## Idempotency and delivery

An idempotency receipt MUST bind the operation namespace, trusted scope, key, and request fingerprint. Conflicting reuse MUST be rejected. Outbox append declared atomic with a mutation MUST share its commit boundary. Consumers MUST use inbox/delivery identity to prevent duplicate effects and MUST fence stale claims. Acknowledgement, retry, lease expiry, and dead-letter outcomes MUST remain explicit.

Claims contain owner/token/expiry; only the current unexpired token may acknowledge, retry, or transition delivery. At-least-once transport delivery MUST NOT become duplicate committed consumer effect. Retry scheduling is bounded and deterministic from policy.

## Audit, errors, and conformance

Audit records MUST be append-only at the framework boundary and contain safe actor/action/resource/outcome context.

Invalid envelopes are validation failures; idempotency fingerprint mismatch conflict; stale claims conflict; transient store faults retryable only when safe. Conformance covers atomic append, duplicate receipt/delivery, conflicting reuse, concurrent claims, stale fencing, expiry/reclaim, ack/retry/dead-letter, crash before/after commit, and replay.

Traceability: `packages/core/src/events`; shared fenced state machines; backend integration/race/crash; EV1, C1, V1.
