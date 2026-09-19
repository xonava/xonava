# Cursor

A cursor is a versioned, authenticated envelope bound to query shape, normalized sort order, scope, projection, policy/security digest, consistency mode and expiry. Its position contains every sort component plus a deterministic unique tie-breaker.

Decode verifies size, format version, key identifier, signature, expiry and every binding before using position values. Forward and backward traversal use direction-aware comparison and return stable ordering. Mixed-version readers are enabled before new-version writers.
