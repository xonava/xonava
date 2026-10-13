# Rate limiting

## Scope and data model

A request contains a non-empty opaque key, positive safe-integer limit, positive window in milliseconds, algorithm, positive safe-integer cost, consistency, and failure mode. The result contains allowed/blocked, non-negative remaining, and `resetAt`: an absolute epoch-millisecond instant at which current restriction ceases.

Defaults are fixed-window, cost 1, atomic consistency, and fail-closed. Limit, cost, and window milliseconds MUST each be a positive safe integer; fractional, non-finite, zero, negative, and above-`Number.MAX_SAFE_INTEGER` values are rejected for numeric and text windows alike. Text durations (case-insensitive, surrounding whitespace trimmed, optional space before the unit) are 1–9 ASCII digits followed by one of these units; other text MUST be rejected, as MUST a result that is not a positive safe integer of milliseconds:

| Unit | Accepted spellings | Milliseconds |
| --- | --- | --- |
| milliseconds | `ms`, `millisecond`, `milliseconds` | 1 |
| seconds | `s`, `second`, `seconds` | 1 000 |
| minutes | `m`, `minute`, `minutes` | 60 000 |
| hours | `h`, `hour`, `hours` | 3 600 000 |
| days | `d`, `day`, `days` | 86 400 000 |

## Requirements

Fixed-window consumption increments the bucket containing the request. Sliding-window and token-bucket stores MUST implement their declared weighted/refill semantics; the framework MUST NOT silently emulate them as fixed windows. Weighted cost consumes the requested amount.

The post-consumption request is allowed when count is less than or equal to limit and blocked when count exceeds it. Remaining is `max(limit - count, 0)`. Reset is exclusive: consumption at or after that instant uses next/refilled capacity.

Atomic mode MUST consume as one backend operation per key. Concurrent consumers MUST observe a serialization consistent with returned counts; lost updates are forbidden. Best-effort mode MAY use weaker increments only when explicit.

## Capability negotiation

A store MAY declare algorithms and weighted-cost support. An undeclared algorithm, non-unit cost without support, or missing generalized consume operation MUST produce capability failure. Algorithm, cost, and atomicity MUST NOT be downgraded.

## Errors and failure behavior

Empty keys, invalid limits/windows/algorithms/costs, and malformed store results are validation failures: a blank key is a request-input `ValidationError`; an invalid limit, window, algorithm, cost, consistency, or failure mode is a `ConfigurationError` (never subject to fail-open); a malformed store bucket is a store fault (`UnavailableError`) handled by the failure mode. Fail-closed propagates provider/capability failure. Fail-open MAY allow only when best-effort consistency is explicit; its synthetic remaining equals limit and reset equals current time plus window. Blocked enforcement raises canonical rate-limit failure with non-negative retry duration.

## Security and conformance

Provider timestamps and enforcement clocks MUST share epoch-millisecond basis. Keys SHOULD derive from trusted normalized scope. Conformance MUST cover defaults, equality/exceedance, weighted cost, every declared algorithm, concurrent atomic consumption, invalid store results, capability rejection, fail-closed, and restricted fail-open.

Traceability: `packages/core/src/rate-limit`; rate-limit tests; G1 certification.
