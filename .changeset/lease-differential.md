---
"@xonava/adapters": patch
---

Fenced leases keep their fencing token across `release`: the next grant after a release now continues the sequence instead of restarting at 1, so the token is strictly increasing for a resource whether the previous lease was released or expired. The MySQL lease backend now retries a transition that InnoDB aborts with a deadlock or lock-wait timeout, as the MySQL record backend already did, instead of surfacing the error to a caller racing for the same lease.
