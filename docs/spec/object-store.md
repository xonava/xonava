# Object store

## Data model

An object reference contains OPTIONAL bucket, REQUIRED key, and OPTIONAL provider version. A key MUST contain 1–1,024 non-NUL characters. Metadata contains reference plus non-negative content length and OPTIONAL content type, checksum (algorithm/value), entity tag, modification timestamp, and the custom string metadata stored with the object. Binary bodies are bounded byte sequences or readable byte streams.

## Operations

`put` stores the complete declared body and returns authoritative metadata. A provider MUST validate declared content length/checksum where it claims that support and MUST NOT report success for partial storage. A provider that cannot verify a declared checksum algorithm MUST reject it rather than store it unverified; a verified mismatch is a validation failure. `get` returns body plus metadata or explicit absence; a versioned reference whose version is not the current one is absence. `head` returns identical authoritative metadata without body or absence. `delete` returns whether an object was removed; a provider whose delete does not report removal (Cloudflare R2) answers from a preceding `head`, so a concurrent writer can make the answer stale. Absence MUST remain distinct from provider failure.

Signed upload/download are OPTIONAL; the Cloudflare R2 binding cannot sign URLs, so `R2ObjectStore` omits them. A signed reference contains URL, absolute expiry, and OPTIONAL required headers. Expiry duration MUST be positive and the URL MUST grant no broader bucket/key/method authority than requested. Implementations MUST NOT log signed URLs as safe metadata.

## Cancellation, deadlines, and security

An already-cancelled request MUST fail before provider I/O. An absolute epoch-millisecond deadline is expired when current time is greater than or equal to it. Cancellation/deadline stops new work and closes streams/resources but cannot undo a completed provider commit. Trusted scope-to-bucket/key policy is enforced before the port call. The port does not prefix, rewrite or normalize keys: a key is an opaque string, `/` and `..` carry no meaning, and the caller MUST derive every key from trusted scope and never from client-supplied names.

## Errors and conformance

Invalid keys, lengths, checksums, expiry, timestamps, or metadata are validation failures. Missing object is absence, missing optional signing is capability failure, and provider faults are dependency failures with retryability explicitly normalized. Conformance covers every operation, absence, versioned references, metadata fidelity, streaming/early termination, cancellation/deadline, signed expiry/authority, hostile keys, checksum/length mismatch, and failure redaction.

Traceability: `packages/core/src/object-store`; reference object-store tests; O1 certification. Attachment semantics are specified separately in [attachments](attachments.md).
