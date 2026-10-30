# Cache

## Scope

This specification defines cache keys, value operations, expiry, tags, generation fencing, consistency declaration, and failures without prescribing a provider.

## Data model and resource limits

A key is a bounded encoded sequence of prefix, trusted scope, and suffix. Key-part canonicalization MUST be deterministic. The canonical profile accepts primitives, arrays, maps, sets, timestamps, and arbitrary-precision integers through explicit tagged encodings. It gives tagged representations to absence, non-finite numbers, timestamps, arbitrary-precision integers, maps, and sets. Map entries and set elements MUST be deterministically ordered. Objects using reserved `$type`, cycles, invalid timestamps, and unsupported instances MUST be rejected.

The canonical profile limits nesting to 100, object members to 10,000, collection items to 10,000, visited nodes to 10,000, and each encoded key/key-part to 2,048 UTF-8 bytes. Language profiles MUST apply equivalent limits and bytes.

## Requirements

Lookup MUST return stored value, explicit absence, or failure. Store associates a value and OPTIONAL positive expiry. Delete reports whether removal occurred. Membership reports presence without conflating failure. Clear removes entries in the cache namespace. Expired entries MUST NOT be returned as present. A language profile MUST document its configured/default expiry behavior; the neutral specification does not impose a default.

Tag addition associates key and tag; tag lookup returns associations; tag deletion removes the tag namespace. Correctness-critical tagged caching MUST require declared linearizable generation consistency, fleet-shared coherence, generation lookup, and atomic generation advancement. A resolver MUST avoid publishing a value when invalidation advanced the observed generation. Process-local fallback generation state MUST be bounded independently of caller-controlled tag cardinality and MUST NOT permit an evicted or forgotten generation to make stale data readable again.

A provider that stores values, tag lists, revisions, or generation counters in one key namespace MUST reject (validation failure, before any storage access) a caller key that collides with an internal key prefix, on every operation that takes a key. The Cloudflare KV adapter reserves `__tag__:`, `__revision__:`, and `__generation__:` (except the service-built tagged form `__generation__:"<generation>":<key>`).

A provider whose tag generation is derived from more than one counter (the Cloudflare KV adapter during a rolling upgrade, when instances on the previous release advance only the legacy counter) MUST report a generation that changes whenever ANY counter changes. The generation token embedded in storage keys MUST be bounded in size in every state: a converged state MAY report the single counter, and any other state MUST report a fixed-length collision-resistant digest (at least 128 bits) of the counters, never the counters themselves, so a tag count that fits the provider's key limit when converged still fits when not. A read that finds the current counter missing while the legacy counter exists SHOULD copy the legacy value into the current counter (best effort, never failing the read, never overwriting a counter written meanwhile) so the state converges; counters that diverge through concurrent advances stay fenced and bounded and converge on the next advance.

In-flight coalescing MAY combine misses in one service instance. It MUST be bounded and MUST NOT imply cross-process single-flight behavior or provide correctness.

## Errors

Invalid keys produce canonicalization/validation failure. Missing correctness-critical capabilities produce capability/configuration failure. Provider failure MUST remain distinct from absence. Telemetry MUST NOT disclose unsafe key/value data.

## Evolution and conformance

Tags/generations are OPTIONAL unless required by a plan. Implementations MUST declare consistency/coherence accurately. New tagged key types require a format-version decision. Conformance MUST cover deterministic bytes, every accepted tagged value, all limits, cycles/reserved tags, TTL, absence/failure, tags, generation races, and multi-instance invalidation.

Traceability: `packages/core/src/cache`; adapter cache tests.
