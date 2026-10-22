-- Platform and system jobs/schedules carry a key (platformKey / systemKey) that used to be dropped on write and decoded
-- as "default" / "framework". It is now stored in scope_key (NULL = the framework default, so rows written before this
-- migration, or by older workers during a rolling deploy, keep decoding to the defaults). scope_key is NULL for tenant rows.
-- The partition-head and running-sibling checks compare it with IS; jobs_partition_head_idx is unchanged.
-- The jobs and schedules tables belong to the deployment (the fixture database has none; bootstrap skips a statement while its table is missing).
-- Without this column the store still works for default-key jobs; enqueueing a non-default key then fails with a ConfigurationError.
ALTER TABLE jobs ADD COLUMN scope_key TEXT;
ALTER TABLE schedules ADD COLUMN scope_key TEXT;
