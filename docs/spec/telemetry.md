# Telemetry

## Scope and requirements

Telemetry records events, safe attributes, durations, and failures without changing functional results. Implementations MUST classify/redact attributes before emission and MUST NOT expose secrets, raw policy facts, or unsafe internal error details. Telemetry failure SHOULD NOT alter committed business state unless the operation explicitly declares telemetry as a required effect.

Each event has stable name, severity, timestamp, and bounded scalar attributes. Non-finite numbers and unsupported attribute values MUST be removed/rejected according to profile; strings MUST respect configured byte limits. Emitters SHOULD freeze/copy events so providers cannot mutate caller state.

## Errors and conformance

Best-effort provider throws/rejections are contained. Validation failure for unsafe/oversized data occurs before emission when required. Conformance covers classification filtering, secret removal, scalar validation, size limits, immutable emission, absent/no-op provider, and synchronous/asynchronous provider failure.

Provider APIs and logging libraries are not normative. Traceability: `packages/core/src/telemetry`; telemetry/redaction tests; T1 certification.
