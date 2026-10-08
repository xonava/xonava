# Sequence numbering

`core/sequence` defines tenant-scoped, named counters. A counter is further scoped by a UTC reset bucket (`never`, year, month, or day). Formatting adds an optional prefix and zero padding after allocation; it never changes the stored numeric value.

A resetting counter restarts its numbers every period, so its formatted value must embed the period or identifiers would repeat. `periodFormat` therefore defaults to `compact` (for example `INV-2026-1`) when `reset` is not `never`, and an explicit `periodFormat: "none"` on a resetting counter is a `ConfigurationError`. A counter that never resets has no period to embed and rejects any format other than `none`.

`SequenceStore.next` must run on the same database transaction as the business record that consumes the number. Providers serialize allocation for one `(scope, name, period)` key. A committed allocation is strictly increasing and unique. A rolled-back transaction restores the counter, so it does not create a gap. Applications that allocate and commit separately explicitly forfeit the gapless guarantee.

PostgreSQL and MySQL callers pass a transaction-bound client to their store. D1 callers use `nextWithStatements`; its consumer statements and allocation execute in one atomic D1 batch. Consumer SQL reads the new value from `framework_sequences` using the same scope, name, and period.

Scope, name, and period are compared byte-for-byte. Provider schemas therefore use binary/ordinal collations where a database's default collation is case-insensitive. Reset buckets use UTC so allocation is deterministic across regions.

The service does not interpret the number, select document-specific prefixes, or promise that deleting an already committed business record will recycle its number.
