# Idempotency

An idempotency namespace binds canonical execution scope, operation key, principal semantics and retention policy. The request fingerprint includes the versioned canonicalization and digest identifiers.

Acquire produces one of acquired, in-progress, replay, or conflict. Matching completed requests replay the durable response; the same key with a different fingerprint conflicts. Receipt, mutation, audit, outbox and required cache-generation effects commit atomically where that guarantee is claimed. Finalization is claim-fenced and restart-safe.

## Lost ownership

Every operation that is fenced by the reservation token or by the finalizer claim token (`renew`, the commit fence `markCommittedInTransaction`, `complete`, `ackClaimedInvalidation`, `completeClaimedInvalidation`) MUST fail with `ConflictError` (`CONFLICT`) when the caller no longer owns the reservation or claim: the token is stale, the lease was taken over, or the claim expired. The error class is identical on every provider; a plain `Error` MUST NOT be used. `STALE_CLAIM` is reserved for outbox/inbox delivery claims and is not used by the idempotency store.
