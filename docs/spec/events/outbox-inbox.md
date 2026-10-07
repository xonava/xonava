# Outbox and inbox

An outbox record is written atomically with its originating state change. Claim ownership uses a lease and fencing token; only the current unexpired claimant can acknowledge delivery or reschedule. Redelivery is at-least-once and consumers must tolerate duplicates.

An inbox key binds consumer, message and execution scope. Claim, completion, retry and dead-letter transitions are conditional on current claim identity. Replaying an identical message is harmless; conflicting identity or fingerprint data is rejected.

## Delivery state machines (normative)

The transitions are defined once as pure functions in `core/events` (`claimOutboxDelivery`, `markOutboxDeliveryPublished`, `recordOutboxDeliveryFailure`, `observeInboxRecord`, `claimInboxRecord`, `renewInboxClaim`, `acknowledgeInboxRecord`, `scheduleInboxRetry`, `deadLetterInboxRecord`, `replayInboxRecord`). Stores MUST apply them atomically against the current record and MUST NOT define their own transition rules.

- **Claimable:** `pending`, `retry_scheduled` once `nextAttemptAt` has passed, or `claimed` with an expired lease. Claiming increments `attempt` and issues a fresh token.
- **Fencing:** every transition after a claim requires the live, unexpired token; otherwise it fails with `STALE_CLAIM`.
- **Failure:** a failure schedules a retry after the given delay, or dead-letters once `attempt ≥ maxAttempts`. Failure codes are stable identifiers (`[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}`); anything else is recorded as `DELIVERY_FAILED`, so no free text reaches durable state.
- **Append:** idempotent; reusing a message id with a different idempotency key is a conflict.
- **Replay:** only `dead_lettered` inbox records replay, under a new generation, with a non-empty reason; history is preserved.

## Reference runners (normative behaviour)

`deliverOutboxMessage` and `consumeInboxMessage` run one message. Work is bounded to 80% of the lease. Errors a framework marks non-retryable dead-letter immediately; other errors back off under the serializable backoff policy (`ConsumerDefinition.backoff` when declared). Shutdown leaves a claim to lapse rather than recording a failure. A payload version the consumer does not accept backs off (bounded by the attempt limit) so a newer worker can take it. Delivery is at-least-once; the inbox makes the consumer's local effect exactly-once.

## Provenance

Outbox records carry the producing authority's provenance. `createEnvelopeFromOutboxRecord` rebuilds the publishable envelope and fails closed when provenance or producer identity is missing; it never invents authority.
