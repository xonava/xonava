import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1Adapter, createDrizzleJobStore } from "adapters/drizzle-d1"
import { applyD1Migration } from "../../fixtures/d1/bootstrap.js"
import { temporaryD1Fixture, type D1Fixture } from "./database.js"

/**
 * The partition-head subquery of the claim (`NOT EXISTS (SELECT 1 FROM jobs ahead WHERE ahead.partition_key = j.partition_key ...)`)
 * needs an index on the partition columns, otherwise SQLite scans the whole jobs table for every candidate. The statement under test is the
 * one the store really issues (captured through the drizzle logger), explained with EXPLAIN QUERY PLAN on a populated table.
 */
const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"),
  resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const execs = sqliteTable("job_executions", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at") })

describe("D1 job partition-head index", () => {
  let fixture: D1Fixture & { cleanup(): Promise<void> }
  const captured: Array<{ sql: string; params: unknown[] }> = []
  beforeAll(async () => {
    fixture = await temporaryD1Fixture() // bootstraps every fixture migration; 0003 skips its index while the fixture has no jobs table
    await fixture.db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)")
    await fixture.db.exec("CREATE TABLE job_executions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)")
    // 30 000 rows, almost all finished; 0.2 % are due or running, spread over many partitions.
    await fixture.db.exec("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 29999) INSERT INTO jobs (id, tenant_id, scope, status, priority, attempts, max_attempts, run_at, partition_key, lease_expires_at) SELECT 'j' || i, CASE WHEN i % 2 = 0 THEN NULL ELSE 't1' END, 'tenant', CASE WHEN i % 1000 = 1 THEN 'running' WHEN i % 1000 = 2 THEN 'pending' ELSE 'succeeded' END, i % 5, 0, 3, 1000, CASE WHEN i % 1000 = 1 THEN 'r' || i ELSE 'p' || (i % 1200) END, 99999999999999 FROM n")
    await fixture.db.exec("ANALYZE")
  }, 60_000)
  afterAll(async () => { await fixture?.close(); await fixture?.cleanup() })

  const explainClaim = async (): Promise<string[]> => {
    captured.length = 0
    const db = drizzle(fixture.db as never, { logger: { logQuery: (sql, params) => { if (sql.includes(" ahead ")) captured.push({ sql, params }) } } })
    const store = createDrizzleJobStore(createDrizzleD1Adapter(db as never).repository, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } })
    await store.claimDue({ workerId: "w", limit: 10, leaseDurationMs: 60_000, requester: { scope: "tenant", tenantId: "t1", actorId: "actor" } })
    expect(captured.length, "the candidate select was captured").toBeGreaterThan(0)
    const plan = (await fixture.db.prepare(`EXPLAIN QUERY PLAN ${captured[0]!.sql}`).bind(...captured[0]!.params).all()).results as Array<{ detail: string }>
    return plan.map((row) => row.detail)
  }

  it("migration 0003 adds the partial partition index, is idempotent, and the claim's ahead subquery searches by it", async () => {
    const before = await explainClaim()
    expect(before.join("\n")).not.toContain("jobs_partition_head_idx")
    // Without the index the partition lookup scans every job for each candidate.
    expect(before.some((detail) => /^SCAN ahead/.test(detail)), before.join("\n")).toBe(true)

    expect(await applyD1Migration(fixture.db, "0003_job_partition_head_index.sql")).toBe(true)
    expect(await applyD1Migration(fixture.db, "0003_job_partition_head_index.sql")).toBe(true)
    await fixture.db.exec("ANALYZE")
    const index = (await fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'jobs_partition_head_idx'").all()).results as Array<{ sql: string }>
    expect(index).toHaveLength(1)
    expect(index[0]!.sql).toContain("(partition_key, scope, tenant_id, status) WHERE partition_key IS NOT NULL")

    const after = await explainClaim()
    expect(after.some((detail) => /^SEARCH ahead USING (COVERING )?INDEX jobs_partition_head_idx \(partition_key=\? AND scope=\? AND tenant_id=\?/.test(detail)), after.join("\n")).toBe(true)
    expect(after.some((detail) => /^SCAN ahead/.test(detail)), after.join("\n")).toBe(false)
  }, 60_000)

  it("bootstrapping a fixture without a jobs table skips the index instead of failing", async () => {
    const empty = await temporaryD1Fixture()
    try {
      expect((await empty.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'jobs_partition_head_idx'").all()).results).toHaveLength(0)
      expect(await applyD1Migration(empty.db, "0003_job_partition_head_index.sql")).toBe(false)
    } finally { await empty.close(); await empty.cleanup() }
  }, 60_000)
})
