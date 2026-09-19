import type { PgFixtureClient } from "./bootstrap.js"
export async function resetPostgresFixture(client: PgFixtureClient): Promise<void> {
  await client.query("TRUNCATE framework_test.sequences, framework_test.temporal_snapshots, framework_test.temporal_revisions, framework_test.temporal_heads, framework_test.workflow_signals, framework_test.workflows, framework_test.job_progress, framework_test.j1_jobs, framework_test.ev1_business_effects, framework_test.outbox_delivery_records, framework_test.inbox_records, framework_test.finalizers, framework_test.leases, framework_test.cache_generations, framework_test.audit, framework_test.outbox, framework_test.idempotency, framework_test.records")
}
