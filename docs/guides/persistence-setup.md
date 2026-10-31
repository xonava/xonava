# Persistence setup

Choose `@xonava/adapters/drizzle-pg`, `@xonava/adapters/drizzle-mysql`, or `@xonava/adapters/drizzle-d1`, create provider-specific schema/fixtures, and configure a trusted datasource route. Use dedicated databases for certification.

Do not claim capabilities from driver presence alone. Verify interactive transaction or atomic-batch behavior, conditional OCC, authorized predicates, atomic idempotency/audit/outbox/cache generation, race behavior, and process-crash recovery as applicable. Provider operational tuning, migrations, credentials, pooling, and availability remain adapter/operator responsibilities.

## Identifier columns compare byte-for-byte

Scope ids, tenant ids, keys, names, tokens, record keys, resource keys and tags are compared byte-for-byte (see `spec/sequence.md`). Define every such column so the database does the same.

- **MySQL:** use a NO PAD binary collation: `VARCHAR(n) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin` (or `VARBINARY(n)`). Do not use the default collation (case- and accent-insensitive: key `K` replays `k`), `ascii_bin` or `utf8mb4_bin` (PAD SPACE: `'a'` equals `'a '`; `ascii` also rejects non-ASCII scopes). `sequences` and `temporal_*` key on `scope_hash`, a stored `SHA2(scope_id, 256)` column, because a 1024-character scope does not fit InnoDB's 3072-byte index limit next to the other key parts; the stores query by `scope_hash=UNHEX(SHA2(?,256))`. See migration `0006_byte_exact_identifiers.sql` in [known limitations](../KNOWN-LIMITATIONS.md#apply-the-migrations-first).
- **PostgreSQL:** the default collation compares bytes for equality; keep identifier columns `text`/`varchar` without a nondeterministic or case-insensitive collation (`citext` is not allowed). The idempotency columns `result` and `pending_invalidations` must be `text`, not `jsonb`: the store writes JSON text, and drizzle decodes a `jsonb` value a second time on read, so a claim over such a row fails to parse and poisons it.
- **D1/SQLite:** the default `BINARY` collation is byte-exact; do not add `COLLATE NOCASE` to identifier columns.
