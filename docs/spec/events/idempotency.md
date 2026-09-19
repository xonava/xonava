# Idempotency

An idempotency namespace binds canonical execution scope, operation key, principal semantics and retention policy. The request fingerprint includes the versioned canonicalization and digest identifiers.

Acquire produces one of acquired, in-progress, replay, or conflict. Matching completed requests replay the durable response; the same key with a different fingerprint conflicts. Receipt, mutation, audit, outbox and required cache-generation effects commit atomically where that guarantee is claimed. Finalization is claim-fenced and restart-safe.
