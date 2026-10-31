-- Supporting index for the partition-head check of the job store's claim (DrizzleMySqlJobStore.claimDueOnce).
-- The claim only offers the head of each partition: NOT EXISTS (SELECT 1 FROM jobs ahead WHERE ahead.partition_key = j.partition_key
-- AND ahead.scope = j.scope AND ahead.tenant_id <=> j.tenant_id AND ahead.id <> j.id AND <ahead is due> AND <ahead sorts first>);
-- the running-sibling check uses the same equality. jobs_due_idx(status, next_attempt_at, priority) cannot serve it (EXPLAIN scanned the table
-- by status for every candidate); this index gives the subquery a ref lookup on (partition_key, scope, tenant_id).
-- MySQL cannot guard ADD KEY, so the fixture bootstrap applies this file only while the index is missing.
ALTER TABLE jobs ADD KEY jobs_partition_head_idx (partition_key, scope, tenant_id, status);
