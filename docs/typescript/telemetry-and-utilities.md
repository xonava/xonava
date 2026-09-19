# Telemetry and standalone capability APIs

`core/telemetry` exposes safe attribute builders, emission, a port, and a no-op implementation. Classify attributes before `buildSafeTelemetryAttributes`; `emitTelemetry` is best-effort. Other standalone entry points expose quota, resilience, object storage, attachments, health, secrets, feature flags, and business calendars. Each accepts its capability contract directly and requires no bootstrap container. Consult the matching normative page before implementing an adapter.
