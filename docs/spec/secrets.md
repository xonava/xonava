# Secrets

## Scope and requirements

A secret reference is opaque. Resolution MUST occur only through an authorized provider and MUST return secret value or explicit absence/failure according to contract. Secret values MUST NOT be serialized into definitions, logs, telemetry, errors, cache keys, fingerprints, or certification evidence.

A reference contains non-empty provider and key plus OPTIONAL non-empty version; it MUST NOT contain an embedded `value`. A resolved value is text or binary with OPTIONAL valid expiry and OPTIONAL disposal operation. Callers MUST treat the value as sensitive until disposal and MUST NOT assume text encoding for binary data. Resolution options MAY carry cancellation and an absolute epoch-millisecond deadline; expired/cancelled requests fail before new provider work.

## Lifecycle and conformance

Implementations SHOULD support rotation without changing logical references and MUST define value lifetime/caching. Expired values MUST NOT be returned as current. Disposal MUST be safe to invoke according to the language profile and SHOULD clear mutable secret buffers where feasible. Invalid references/expiry are validation failures; missing provider capability/configuration failure; provider error dependency failure. Conformance covers construction/type guard, hostile embedded value, text/binary, expiry, cancellation/deadline, disposal, rotation/version, provider failure, and non-disclosure. Traceability: `core/secrets`; H1.
