# Error reference

Canonical machine identities are normatively enumerated in [`../spec/errors.md`](../spec/errors.md), covering authentication/authorization, validation/business-rule, conflict/OCC/stale claim, not-found, rate-limit, missing capability, configuration, persistence/dependency, required audit/outbox context, and operation/effect lifecycle failures.

Every error exposes safe classification through the public domain surface. Internal details/causes are not automatically safe. Core errors contain no HTTP status; exhaustive mappings in `@xonava/adapters/http` are transport policy. `FrameworkCoreErrorCode` realizes the normative catalog and ER1 tests prevent coverage drift.
