# Health

## Scope and requirements

Health exposes bounded structured component status. Liveness answers whether the process can continue; readiness answers whether it can safely accept its declared work. Implementations MUST NOT conflate them when both are exposed. Overall status MUST be deterministically derived from required component results; optional component degradation MUST be identifiable.

Each component has a unique non-empty key, status (`healthy`, `degraded`, or `unhealthy`), critical flag, valid check timestamp, and OPTIONAL safe message. Keys MUST be unique across liveness and readiness results. The report timestamp MUST be valid and implementations MUST defensively preserve returned component/timestamp values.

`live` is false exactly when any critical liveness component is unhealthy. `ready` is true exactly when `live` is true and no critical readiness component is unhealthy. Overall status is `unhealthy` when either boolean is false; otherwise it is `degraded` when any component is not healthy; otherwise `healthy`. A degraded critical component does not make live/ready false but does make overall status degraded.

## Security, errors, and conformance

Results MUST be safe for their intended trust level and MUST NOT disclose credentials, raw provider errors, or topology beyond policy. Checks MUST obey timeout/cancellation and MUST not mutate business state. Invalid/duplicate components or times are validation failures. Conformance covers every aggregation branch, liveness/readiness separation, duplicate/empty keys, invalid times, immutability, timeout, and redaction. Traceability: `@xonava/core/health`; H1.
