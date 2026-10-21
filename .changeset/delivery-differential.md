---
"@xonava/adapters": patch
---

D1 `acknowledgeBatch` now applies the core acknowledgement transition, reports an unobserved record as a conflict, and re-evaluates the fence when the record changes concurrently (a lost race is a stale claim, a concurrent lease renewal no longer fails the acknowledgement); the MySQL atomic record backend retries deadlocked transitions up to 12 times instead of 3, so concurrent claimers no longer fail with a raw deadlock error.
