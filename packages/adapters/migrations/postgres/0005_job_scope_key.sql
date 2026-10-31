-- Platform and system jobs/schedules carry a key (platformKey / systemKey) that used to be dropped on write and decoded
-- as "default" / "framework". It is now stored in scope_key (NULL = the framework default, so rows written before this
-- migration, or by older workers during a rolling deploy, keep decoding to the defaults). scope_key is NULL for tenant rows.
-- The partition-head and running-sibling checks compare it with IS NOT DISTINCT FROM; jobs_partition_head_idx is unchanged
-- (scope_key, like tenant_id, is evaluated as a filter on the rows the index returns).
-- The jobs and schedules tables belong to the deployment (the fixture schema has none), hence the existence guards.
-- Without this column the store still works for default-key jobs; enqueueing a non-default key then fails with a ConfigurationError.
DO $migration$
BEGIN
  IF to_regclass('framework_test.jobs') IS NOT NULL THEN
    ALTER TABLE framework_test.jobs ADD COLUMN IF NOT EXISTS scope_key text;
  END IF;
  IF to_regclass('framework_test.schedules') IS NOT NULL THEN
    ALTER TABLE framework_test.schedules ADD COLUMN IF NOT EXISTS scope_key text;
  END IF;
END
$migration$;
