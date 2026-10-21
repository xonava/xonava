-- Platform and system jobs/schedules carry a key (platformKey / systemKey) that used to be dropped on write and decoded
-- as "default" / "framework". It is now stored in scope_key (NULL = the framework default, so rows written before this
-- migration, or by older workers during a rolling deploy, keep decoding to the defaults). scope_key is NULL for tenant rows.
-- The active-partition unique index must tell keys apart: one running job per partition per scope and per tenant-or-key,
-- so the generated column now carries COALESCE(tenant_id, scope_key, '') (tenant rows: unchanged; default-key rows: unchanged).
-- MySQL cannot guard ADD COLUMN, so the fixture bootstrap applies this file only while jobs.scope_key is missing.
ALTER TABLE jobs ADD COLUMN scope_key VARCHAR(100) NULL AFTER scope;
ALTER TABLE schedules ADD COLUMN scope_key VARCHAR(100) NULL AFTER scope;
ALTER TABLE jobs MODIFY active_partition_tenant VARCHAR(100) GENERATED ALWAYS AS (CASE WHEN status='running' AND partition_key IS NOT NULL THEN COALESCE(tenant_id,scope_key,'') ELSE NULL END) STORED;
