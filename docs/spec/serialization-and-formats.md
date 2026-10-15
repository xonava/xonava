# Serialization and durable formats

## Scope and canonicalization

Canonical serialization MUST be deterministic for all accepted values, MUST reject unsupported/cyclic/over-limit inputs, and MUST produce the same bytes for semantically identical accepted data. Fingerprints MUST bind a declared namespace and canonical payload.

The certified canonical JSON profile is `jcs-rfc8785-v1` with UTF-8 and `sha256-v1`. It follows RFC 8785 ordering/number serialization, rejects lone surrogates, non-finite numbers, unsafe integers, cycles, class instances, and unencoded timestamp/binary values, and enforces registered resource ceilings. Typed timestamps use RFC 3339 UTC milliseconds; binary uses canonical unpadded base64url. See [canonical JSON](serialization/canonical-json.md).

## Envelopes and versions

A durable envelope MUST identify its format and version. Writers MUST emit only the configured current version. Readers MUST accept explicitly registered supported versions, reject unknown future/unsupported versions, and perform deterministic validated upcasting where declared. Reader/writer deployment order MUST ensure every reader understands a version before writers emit it.

No obsolete pre-canonical reader is part of the current contract. Format version, specification version, package version, and adapter certification version are distinct.

## Errors and conformance

Unsupported values, malformed bytes/envelopes, unknown versions, limit excess, and failed validation MUST be explicit format/validation errors; partial decoding MUST NOT be returned as valid. Conformance uses exact cross-language vectors for bytes, digests, envelopes, versions, rejection cases, resource limits, upcasting, and fingerprints.

Traceability: `packages/core/src/serialization`, `packages/core/src/spec`; exact vectors and codec tests; F1 certification.
