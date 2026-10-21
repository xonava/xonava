-- Byte-exact identifier columns (docs/spec/sequence.md, idempotency and temporal specs: scope ids, keys and names compare byte-for-byte).
-- 0001 created identifier columns with the schema default collation (utf8mb4_0900_ai_ci: case- and accent-insensitive, so `K` replays `k`)
-- or ascii_bin (a PAD SPACE collation that also rejects non-ASCII: 'a' and 'a ' collide, 'é' fails with "Incorrect string value").
-- Every identifier column becomes VARCHAR(n) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin, a NO PAD binary collation (utf8mb4_bin is
-- PAD SPACE in MySQL 8). Not converted: records.name, schedules.cron_expression, schedules.description (domain data, not identifiers),
-- and sequences.name/period and temporal entity_type/entity_id/kind/event_id/audit_id (KEY_PATTERN limits them to [A-Za-z0-9._:-], so ascii_bin is already exact).
-- sequences.scope_id and temporal_*.scope_id may be 1024 characters (up to 4096 bytes), more than InnoDB's 3072-byte index key limit allows
-- next to the other key parts. They stay in a utf8mb4_0900_bin column and the keys use scope_hash = SHA-256 of the scope's UTF-8 bytes
-- (a STORED generated column; lookups use scope_hash=UNHEX(SHA2(?,256))). Two scopes are the same key only if their SHA-256 digests match.
-- MODIFY and the primary-key change rebuild the tables: run in a maintenance window. The sequence/temporal statements are not re-runnable
-- (ADD COLUMN); the fixture bootstrap applies them only while scope_hash is missing.
ALTER TABLE sequences MODIFY scope_id VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL, ADD COLUMN scope_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(scope_id,256))) STORED NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (scope_hash, name, period);
ALTER TABLE temporal_heads MODIFY scope_id VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL, ADD COLUMN scope_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(scope_id,256))) STORED NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (scope_hash, entity_type, entity_id);
ALTER TABLE temporal_revisions DROP INDEX temporal_revisions_time_idx, MODIFY scope_id VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL, ADD COLUMN scope_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(scope_id,256))) STORED NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (scope_hash, entity_type, entity_id, revision), ADD KEY temporal_revisions_time_idx (scope_hash, entity_type, entity_id, occurred_at, revision);
ALTER TABLE temporal_snapshots MODIFY scope_id VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL, ADD COLUMN scope_hash BINARY(32) GENERATED ALWAYS AS (UNHEX(SHA2(scope_id,256))) STORED NOT NULL, DROP PRIMARY KEY, ADD PRIMARY KEY (scope_hash, entity_type, entity_id, revision);
ALTER TABLE records
  MODIFY id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY tenant_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE audit
  MODIFY id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY tenant_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY action VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY resource_type VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY resource_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY actor_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY actor_type VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE outbox
  MODIFY id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY tenant_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY idempotency_scope VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY idempotency_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY event_fingerprint VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY event_type VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY aggregate_type VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY aggregate_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE cache_generations
  MODIFY `scope` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE idempotency
  MODIFY id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY `scope` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY `key` VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY fingerprint VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY token VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY status VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY resource_entity VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY resource_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY resource_version VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY finalizer_claim_owner VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY finalizer_claim_token VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL;
ALTER TABLE atomic_records
  MODIFY record_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE leases
  MODIFY resource_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE workflows
  MODIFY id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY workflow_type VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY status VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY current_step VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY waiting_signal VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY outcome VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY lease_owner VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY claim_token VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY resume_signal_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL;
ALTER TABLE workflow_signals
  MODIFY id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY instance_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE jobs
  MODIFY id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY job_type VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY tenant_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY `scope` VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY status VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY worker_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY claim_token VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY idempotency_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY idempotency_scope VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY fingerprint VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY correlation_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY partition_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY active_partition VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin GENERATED ALWAYS AS (CASE WHEN status='running' THEN partition_key ELSE NULL END) STORED,
  MODIFY active_partition_tenant VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin GENERATED ALWAYS AS (CASE WHEN status='running' AND partition_key IS NOT NULL THEN COALESCE(tenant_id,'') ELSE NULL END) STORED;
ALTER TABLE job_executions
  MODIFY id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY job_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY worker_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY status VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE job_progress
  MODIFY job_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
ALTER TABLE schedules
  MODIFY id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY `scope` VARCHAR(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY job_type VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY tenant_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY timezone VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY overlap_policy VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY misfire_policy VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
  MODIFY last_status VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY worker_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY claim_token VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY calendar_exclusion_key VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  MODIFY owner VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL;

