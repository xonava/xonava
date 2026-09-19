CREATE TABLE IF NOT EXISTS records (
  id VARCHAR(100) PRIMARY KEY,
  tenant_id VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  value JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS temporal_heads (scope_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, entity_type VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, entity_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, revision BIGINT UNSIGNED NOT NULL, occurred_at DATETIME(3) NOT NULL, kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, PRIMARY KEY (scope_id, entity_type, entity_id), CHECK (revision > 0), CHECK (kind IN ('created','updated','deleted','restored')), CHECK (revision > 1 OR kind = 'created')) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS temporal_revisions (scope_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, entity_type VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, entity_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, revision BIGINT UNSIGNED NOT NULL, occurred_at DATETIME(3) NOT NULL, kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, state JSON, entity_version BIGINT UNSIGNED, event_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin, audit_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin, PRIMARY KEY (scope_id, entity_type, entity_id, revision), KEY temporal_revisions_time_idx (scope_id, entity_type, entity_id, occurred_at, revision), CHECK (kind IN ('created','updated','deleted','restored')), CHECK ((kind = 'deleted' AND state IS NULL) OR (kind <> 'deleted' AND state IS NOT NULL))) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS temporal_snapshots (scope_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, entity_type VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, entity_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, revision BIGINT UNSIGNED NOT NULL, occurred_at DATETIME(3) NOT NULL, state JSON, PRIMARY KEY (scope_id, entity_type, entity_id, revision)) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS sequences (scope_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, period VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, value BIGINT UNSIGNED NOT NULL, PRIMARY KEY (scope_id, name, period), CHECK (value > 0)) ENGINE=InnoDB;
DROP TABLE IF EXISTS audit;
CREATE TABLE audit (id VARCHAR(100) PRIMARY KEY, created_at DATETIME(3) NOT NULL, tenant_id VARCHAR(100) NULL, action VARCHAR(100) NOT NULL, resource_type VARCHAR(100) NOT NULL, resource_id VARCHAR(100) NOT NULL, actor_id VARCHAR(100) NOT NULL, actor_type VARCHAR(50) NOT NULL, old_value JSON NULL, new_value JSON NULL, metadata JSON NULL) ENGINE=InnoDB;
DROP TABLE IF EXISTS outbox;
CREATE TABLE outbox (id VARCHAR(100) PRIMARY KEY, tenant_id VARCHAR(100) NULL, idempotency_scope VARCHAR(255) NOT NULL, idempotency_key VARCHAR(255) NOT NULL, event_fingerprint VARCHAR(128) NOT NULL, event_type VARCHAR(100) NOT NULL, event_version INT NOT NULL, aggregate_type VARCHAR(100) NOT NULL, aggregate_id VARCHAR(100) NOT NULL, payload JSON NOT NULL, occurred_at DATETIME(3) NOT NULL, UNIQUE KEY outbox_scope_key_uq(idempotency_scope,idempotency_key)) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS cache_generations (scope VARCHAR(100) PRIMARY KEY, generation BIGINT NOT NULL) ENGINE=InnoDB;
DROP TABLE IF EXISTS idempotency;
CREATE TABLE idempotency (
  id VARCHAR(100) NOT NULL, `scope` VARCHAR(255) NOT NULL, `key` VARCHAR(255) NOT NULL,
  fingerprint VARCHAR(128) NOT NULL, token VARCHAR(100) NOT NULL, status VARCHAR(30) NOT NULL,
  result JSON NULL, resource_entity VARCHAR(255) NULL, resource_id VARCHAR(255) NULL,
  resource_version VARCHAR(100) NULL, pending_invalidations JSON NULL,
  finalizer_claim_owner VARCHAR(100) NULL, finalizer_claim_token VARCHAR(100) NULL,
  finalizer_claim_expires_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL, PRIMARY KEY (`scope`,`key`), UNIQUE KEY idempotency_id_uq(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS atomic_records (record_key VARCHAR(512) PRIMARY KEY, record JSON NULL, revision BIGINT NOT NULL DEFAULT 0) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS leases (resource_key VARCHAR(512) PRIMARY KEY, lease JSON NULL, revision BIGINT NOT NULL DEFAULT 0) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS workflows (
  id VARCHAR(100) PRIMARY KEY, workflow_type VARCHAR(100) NOT NULL, workflow_version INT NOT NULL,
  execution_scope JSON NOT NULL, status VARCHAR(30) NOT NULL, current_step VARCHAR(100) NOT NULL,
  variables JSON NOT NULL, step_attempt INT NOT NULL DEFAULT 0, compensation_stack JSON NOT NULL,
  waiting_signal VARCHAR(100) NULL, wake_at DATETIME(3) NULL, outcome VARCHAR(30) NULL,
  revision BIGINT NOT NULL DEFAULT 0, lease_owner VARCHAR(100) NULL, claim_token VARCHAR(100) NULL,
  lease_expires_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS workflow_signals (id VARCHAR(100) PRIMARY KEY, instance_id VARCHAR(100) NOT NULL, name VARCHAR(100) NOT NULL, payload JSON NOT NULL, delivered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB;
DROP TABLE IF EXISTS job_progress;
DROP TABLE IF EXISTS job_executions;
DROP TABLE IF EXISTS jobs;
CREATE TABLE jobs (
 id VARCHAR(100) PRIMARY KEY, job_type VARCHAR(100) NOT NULL, job_version INT NOT NULL, tenant_id VARCHAR(100) NULL,
 scope VARCHAR(10) NOT NULL, payload JSON NOT NULL, status VARCHAR(30) NOT NULL, priority INT NOT NULL DEFAULT 0,
 attempt INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL DEFAULT 3, run_at DATETIME(3) NOT NULL,
 next_attempt_at DATETIME(3) NULL, worker_id VARCHAR(100) NULL, lease_expires_at DATETIME(3) NULL,
 claim_token VARCHAR(100) NULL, idempotency_key VARCHAR(255) NULL, idempotency_scope VARCHAR(255) NOT NULL,
 fingerprint VARCHAR(128) NOT NULL, correlation_id VARCHAR(100) NULL, last_error TEXT NULL, result_payload JSON NULL,
 metadata JSON NULL, partition_key VARCHAR(255) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 started_at DATETIME(3) NULL, completed_at DATETIME(3) NULL,
 active_partition VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN status='running' THEN partition_key ELSE NULL END) STORED,
 UNIQUE KEY jobs_idempotency_uq(idempotency_scope,idempotency_key), UNIQUE KEY jobs_active_partition_uq(active_partition), KEY jobs_due_idx(status,next_attempt_at,priority), KEY jobs_correlation_idx(correlation_id,run_at)
) ENGINE=InnoDB;
CREATE TABLE job_executions (id VARCHAR(100) PRIMARY KEY,job_id VARCHAR(100) NOT NULL,attempt INT NOT NULL,worker_id VARCHAR(100) NOT NULL,status VARCHAR(30) NOT NULL,error_message TEXT NULL,started_at DATETIME(3) NOT NULL,finished_at DATETIME(3) NOT NULL) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS job_progress (job_id VARCHAR(100) PRIMARY KEY, attempt INT NOT NULL, sequence BIGINT NOT NULL, percent DOUBLE NULL, checkpoint JSON NULL, updated_at DATETIME(3) NOT NULL) ENGINE=InnoDB;
DROP TABLE IF EXISTS schedules;
CREATE TABLE schedules (
 id VARCHAR(100) PRIMARY KEY,scope VARCHAR(10) NOT NULL,job_type VARCHAR(100) NOT NULL,job_version INT NOT NULL,tenant_id VARCHAR(100) NULL,payload JSON NOT NULL,
 cron_expression VARCHAR(100) NOT NULL,timezone VARCHAR(100) NOT NULL,enabled BOOLEAN NOT NULL DEFAULT TRUE,overlap_policy VARCHAR(20) NOT NULL,misfire_policy VARCHAR(20) NOT NULL,
 next_run_at DATETIME(3) NOT NULL,last_run_at DATETIME(3) NULL,last_status VARCHAR(30) NULL,last_error TEXT NULL,worker_id VARCHAR(100) NULL,lease_expires_at DATETIME(3) NULL,claim_token VARCHAR(100) NULL,
 paused BOOLEAN NOT NULL DEFAULT FALSE,effective_from DATETIME(3) NULL,effective_until DATETIME(3) NULL,remaining_occurrences INT NULL,calendar_exclusion_key VARCHAR(100) NULL,owner VARCHAR(100) NULL,description VARCHAR(255) NULL,
 KEY schedules_due_idx(enabled,next_run_at)
) ENGINE=InnoDB;
