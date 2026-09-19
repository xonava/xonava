# Bulk and streaming persistence

## Bulk operations

A bulk request MUST declare/enforce maximum item count, per-item validation, scope, and atomicity mode. Atomic bulk either commits every item/effect or none. Non-atomic bulk MUST return an ordered per-item outcome and MUST NOT describe partial success as atomic. Duplicate identities and conflicts require deterministic outcome rules.

## Streams

A stream MUST be bounded by query budget and provider capabilities, preserve declared ordering, and propagate cancellation/deadline. It MUST release provider resources on normal completion, early consumer termination, cancellation, and failure. A stream MUST NOT outlive the transaction/context whose correctness it requires.

## Errors and conformance

Limit violations are validation failures; unsupported atomic bulk/stream behavior is capability failure. Conformance MUST cover bounds, order, mixed outcomes, rollback, early termination, cancellation, backpressure/resource cleanup, and provider failure.
