# Feature flags

## Scope and requirements

A feature fact evaluates a named feature from trusted subject/scope/context. Values are exactly boolean, string, or finite number. Context contains trusted execution scope, OPTIONAL principal identity/kind, and OPTIONAL scalar string/number/boolean attributes.

A returned fact has a non-empty key equal to the requested key, typed value, OPTIONAL variant, non-empty reason, valid evaluation timestamp, and OPTIONAL valid expiry strictly later than evaluation. Core structural validation proves timestamp validity and ordering (`expiresAt > evaluatedAt`); it does not decide freshness against wall-clock time. A provider or evaluator MUST compare `expiresAt` with its trusted current clock and MUST reevaluate a stale fact rather than return it as current. Validation MUST return an immutable defensive fact. Evaluation MUST declare absence/default behavior and MUST be deterministic for the same provider state/context. Feature facts MAY influence behavior but MUST NOT substitute for permission checks.

## Errors and conformance

Invalid keys, value types/numbers, reasons, key mismatch, timestamps, or expiry ordering are validation failures; provider failure follows explicit fail behavior. H1 certifies the core structural contract. Provider conformance must separately prove trusted-clock expiry enforcement, reevaluation, absence/default behavior, provider failure behavior, and authorization separation. Traceability: `core/feature-flags`; H1.
