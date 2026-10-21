---
"@xonava/adapters": patch
---

MySQL idempotency store: responses that are JSON `null` or a JSON string now replay correctly (they previously never replayed), and a concurrent first acquire that hits an InnoDB deadlock is retried instead of failing.
