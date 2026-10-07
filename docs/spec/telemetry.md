# Telemetry

## Scope and requirements

Telemetry records events, safe attributes, durations, and failures without changing functional results. Implementations MUST classify/redact attributes before emission and MUST NOT expose secrets, raw policy facts, or unsafe internal error details. Telemetry failure SHOULD NOT alter committed business state unless the operation explicitly declares telemetry as a required effect.

Each event has stable name, severity, timestamp, and bounded scalar attributes. Non-finite numbers and unsupported attribute values MUST be removed/rejected according to profile; strings MUST respect configured byte limits. Emitters SHOULD freeze/copy events so providers cannot mutate caller state.

## Errors and conformance

Best-effort provider throws/rejections are contained. Validation failure for unsafe/oversized data occurs before emission when required. Conformance covers classification filtering, secret removal, scalar validation, size limits, immutable emission, absent/no-op provider, and synchronous/asynchronous provider failure.

Provider APIs and logging libraries are not normative. Traceability: `packages/core/src/telemetry`; telemetry/redaction tests; T1 certification.

## Core event catalogue

Events carry only primitive attributes. Attribute values never include payloads, secrets, or personal data.

| Event | Emitted by | Attributes |
|---|---|---|
| `operation.completed` | every operation run | `operationKey`, `operationKind`, `operationId`, `outcome` (`success`, `committed_with_effect_failures`, `error`), `durationMs`, `errorCode`?, `correlationId`? |
| `operation.effect.failure` | each best-effort post-commit failure | `operationId`, `phase`, `effectName`, `errorType`, `correlationId`? |
| `operation.transaction.unavailable` | `preferred` atomicity without transactions | `operationKey` |
| `execution.dispatch` | job dispatcher | `message` plus structured fields (`jobId`, `jobType`, `attempt`, `error`, ...) |
| `execution.schedule` | schedule materializer | `message` plus structured fields |
| `cache.operation.failure` | cache service | `operation`, `hasKey`, `errorType` |

Structured log fields are bounded: at most 32 attributes, strings truncated to 1024 UTF-8 bytes on a code-point boundary, non-primitive values dropped. Emission never throws and never changes framework behaviour.
