export const D1_FIXTURE_MIGRATIONS = ["0001_framework.sql", "0002_workflow_signal_buffering.sql", "0003_job_partition_head_index.sql", "0004_lease_records.sql", "0005_job_scope_key.sql"] as const
export interface D1FixtureDatabase { exec(sql: string): Promise<unknown> }
