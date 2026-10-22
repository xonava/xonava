-- Supporting index for the partition-head check of the job store's claim (DrizzlePgJobStore.claimDue).
-- The claim only offers the head of each partition: NOT EXISTS (SELECT 1 FROM jobs ahead WHERE ahead.partition_key = j.partition_key
-- AND ahead.scope = j.scope AND ahead.tenant_id IS NOT DISTINCT FROM j.tenant_id AND ahead.id <> j.id AND <ahead is due> AND <ahead sorts first>).
-- The running-sibling check uses the same partition equality. Without an index each candidate rescans the whole jobs table
-- (a Seq Scan on "ahead" in the Anti Join); this index turns it into an index lookup per candidate. It is partial because
-- unpartitioned jobs (partition_key IS NULL) never take part, and the equality on partition_key implies NOT NULL, so the planner
-- can use it. IS NOT DISTINCT FROM is not indexable, so tenant_id and status are carried as index filter columns, not search keys.
-- The jobs table belongs to the deployment (the fixture schema has none), hence the existence guard; a deployment that
-- already runs jobs creates the index with CREATE INDEX CONCURRENTLY IF NOT EXISTS (not allowed inside a transaction or DO block).
DO $migration$
BEGIN
  IF to_regclass('framework_test.jobs') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS jobs_partition_head_idx ON framework_test.jobs (partition_key, scope, tenant_id, status) WHERE partition_key IS NOT NULL;
  END IF;
END
$migration$;
