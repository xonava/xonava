-- Supporting index for the partition-head check of the job store's claim (DrizzleD1JobStore.claimDue).
-- The claim only offers the head of each partition: NOT EXISTS (SELECT 1 FROM jobs ahead WHERE ahead.partition_key = j.partition_key
-- AND ahead.scope = j.scope AND ahead.tenant_id IS j.tenant_id AND ahead.id <> j.id AND <ahead is due> AND <ahead sorts first>).
-- The running-sibling check uses the same partition equality. Without an index every candidate scans the whole jobs table;
-- with it SQLite searches by (partition_key, scope, tenant_id). Partial: unpartitioned jobs never take part.
-- The jobs table belongs to the deployment (the fixture database has none; bootstrap skips this file's statement while the table is missing).
CREATE INDEX IF NOT EXISTS jobs_partition_head_idx ON jobs (partition_key, scope, tenant_id, status) WHERE partition_key IS NOT NULL;
