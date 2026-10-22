-- Fenced lease records for D1AtomicLeaseBackend / createD1LeaseStore. One row per resource; `lease` is the FencedLease JSON
-- (NULL while unheld) and `revision` is the compare-and-swap guard for each transition.
CREATE TABLE IF NOT EXISTS framework_lease_records (resource_key TEXT PRIMARY KEY, lease TEXT NULL, revision INTEGER NOT NULL DEFAULT 0);
