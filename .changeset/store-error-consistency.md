---
"@xonava/adapters": minor
---

**Breaking:** the PostgreSQL and D1 idempotency stores now throw `ConflictError` (as MySQL and the commit fence already did) instead of a plain `Error` when `renew`, `complete`, `ackClaimedInvalidation` or `completeClaimedInvalidation` lose ownership. A versioned `delete`/`deleteWhere` on an existing row with a stale version is now `OPTIMISTIC_CONCURRENCY_FAILED` and on a missing row `NOT_FOUND` on all three databases (previously PostgreSQL and D1 `delete` answered `NOT_FOUND` for a stale version, and MySQL/PostgreSQL/D1 `deleteWhere` answered `OPTIMISTIC_CONCURRENCY_FAILED` for a missing row).
