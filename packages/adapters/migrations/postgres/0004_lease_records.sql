-- Fenced lease records for PgAtomicLeaseBackend / createPgLeaseStore. One row per resource; `lease` is the FencedLease JSON
-- (NULL while unheld) and `revision` counts transitions. The backend reads time from clock_timestamp() under a row lock.
CREATE TABLE IF NOT EXISTS framework_test.lease_records (resource_key text PRIMARY KEY, lease jsonb NULL, revision bigint NOT NULL DEFAULT 0);
