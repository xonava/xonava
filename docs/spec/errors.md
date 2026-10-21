# Errors

## Canonical shape

A canonical error has a stable machine-readable identity, category, safe human message, retryability indication, and safe metadata where defined. Implementations MAY preserve an internal cause but MUST NOT expose unsafe cause/details across an untrusted boundary.

Errors MUST remain transport-independent. HTTP, GraphQL, CLI, queue, or other adapters MAY map canonical errors to transport outcomes; such mappings do not redefine core error semantics. Authentication, authorization, validation, conflict/OCC, absence, rate-limit, configuration, dependency, and internal failures MUST remain distinguishable where callers require different handling.

## Normative identities

The following identities are canonical: `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT`, `RETRYABLE_PERSISTENCE_ERROR`, `NOT_FOUND`, `CAPABILITY_REQUIRED`, `RUNTIME_CAPABILITY_REQUIRED`, `VALIDATION_ERROR`, `BAD_REQUEST`, `AUDIT_SINK_MISSING`, `AUDIT_ACTOR_MISSING`, `OUTBOX_SINK_MISSING`, `RATE_LIMIT_EXCEEDED`, `CONFIGURATION_ERROR`, `INVALID_POLICY_CONFIGURATION`, `OPTIMISTIC_CONCURRENCY_FAILED`, `OPERATION_CONTEXT_INACTIVE`, `EFFECT_REGISTRATION_CLOSED`, `EFFECT_COLLECTOR_DISPOSED`, `EFFECTS_ALREADY_DRAINED`, `STALE_CLAIM`, `PERSISTENCE_ERROR`, `TIMEOUT`, `CANCELLED`, `UNAVAILABLE`, `REQUIRED_HEADER_MISSING`, and `PRECONDITION_REQUIRED`.

Categories are `authentication`, `authorization`, `validation`, `conflict`, `not-found`, `rate-limit`, `configuration`, `dependency`, and `internal`. Retryable persistence, rate-limit, `TIMEOUT`, and `UNAVAILABLE` failures are retryable; other identities are non-retryable unless a future specification version changes the catalog. Public/safe codes and messages MUST follow the registered profile and MUST NOT include provider/internal text. Rate-limit safe metadata MAY include non-negative retry duration. `TIMEOUT` means a deadline elapsed and the outcome of the timed-out work may be unknown; callers MUST NOT assume it had no effect. `CANCELLED` means the caller or shutdown stopped the work. Implementations MAY chain an internal cause (for example ES2022 `Error.cause`); a cause is internal detail and MUST NOT cross an untrusted boundary.

The normative safe public-code mapping is:

| Internal identity | Public code |
|---|---|
| `UNAUTHORIZED` | `UNAUTHORIZED` |
| `FORBIDDEN` | `FORBIDDEN` |
| `CAPABILITY_REQUIRED` | `CAPABILITY_REQUIRED` |
| `VALIDATION_ERROR` | `VALIDATION_ERROR` |
| `BAD_REQUEST` | `BAD_REQUEST` |
| `CONFLICT` | `CONFLICT` |
| `OPTIMISTIC_CONCURRENCY_FAILED` | `OPTIMISTIC_CONCURRENCY_FAILED` |
| `STALE_CLAIM` | `STALE_CLAIM` |
| `NOT_FOUND` | `NOT_FOUND` |
| `RATE_LIMIT_EXCEEDED` | `RATE_LIMIT_EXCEEDED` |
| `RETRYABLE_PERSISTENCE_ERROR` | `SERVICE_UNAVAILABLE` |
| `UNAVAILABLE` | `SERVICE_UNAVAILABLE` |
| `TIMEOUT` | `TIMEOUT` |
| `CANCELLED` | `CANCELLED` |
| `REQUIRED_HEADER_MISSING` | `REQUIRED_HEADER_MISSING` |
| `PRECONDITION_REQUIRED` | `PRECONDITION_REQUIRED` |
| `PERSISTENCE_ERROR`, all runtime/configuration/audit/outbox-context failures, and all operation/effect lifecycle failures | `INTERNAL_SERVER_ERROR` |

`REQUIRED_HEADER_MISSING` (safe message "A required request header is missing") reports a missing required request header, for example `Idempotency-Key`. `PRECONDITION_REQUIRED` (safe message "A precondition header is required") reports a missing precondition header, for example `If-Match` on an update or delete of a versioned entity. Both carry safe metadata `{ header: "<Header-Name>" }`, category `validation`, and are non-retryable. The HTTP profile maps them to 400 and 428, and exposes the header name as `details.header`.

## Application-authored public business errors

A `PublicBusinessError` is a `BAD_REQUEST` whose public code and message are authored by the application instead of taken from the registry. Its `publicCode` MUST match `^[A-Z][A-Z0-9_]{2,63}$` and MUST NOT equal any registry identity, registry public code, or transport code a transport answers with before an operation runs (`INVALID_JSON`, `REQUEST_BODY_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `BODY_NOT_ACCEPTED`). Its `publicMessage` MUST be 1 to 200 characters with no control characters. It MAY name up to 20 `fields`, each 1 to 200 characters. Invalid input MUST be rejected with `CONFIGURATION_ERROR`. The identity stays `BAD_REQUEST`, so transports keep the same status; the HTTP profile adds `details.fields` for this error only. All other errors keep the fixed registry message.

Public business errors MUST NOT be used for authentication or authorization failures. `UNAUTHORIZED`, `FORBIDDEN`, and `NOT_FOUND` responses stay fixed so they cannot reveal whether a resource exists.

## Transport separation, errors, and conformance

Core errors MUST NOT contain HTTP status, headers, GraphQL codes, CLI exit values, or queue disposition. Transport profiles own exhaustive mapping from canonical identity/category. Unknown/non-framework errors map to safe internal outcomes at the adapter boundary.

Conformance MUST instantiate every identity, verify stable code/category/retryability/safe message/metadata freezing, prove unsafe details remain internal, and verify each transport mapping independently. Adding/removing/repurposing an identity requires a specification and compatibility decision.

Traceability: `packages/core/src/domain/errors.ts`; error coverage tests; ER1 certification.
