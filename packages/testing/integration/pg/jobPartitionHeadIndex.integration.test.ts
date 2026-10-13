import pg from "pg"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createDrizzleJobStore, createPgSession } from "adapters/drizzle-pg"
import { readPostgresMigration } from "../../fixtures/postgres/bootstrap.js"
import { pgCertificationUrl } from "./database.js"

/**
 * The partition-head subquery of the claim (`NOT EXISTS (SELECT 1 FROM jobs ahead WHERE ahead.partition_key = j.partition_key ...)`)
 * needs an index on the partition columns, otherwise every claim reads the whole table for `ahead`. The statement under test is the one
 * the store really issues (captured through the drizzle logger), explained on a populated table in an own schema.
 */
const SCHEMA = `df_headidx_${process.pid}`
const s = pgSchema(SCHEMA)
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })
const jobs = s.table("jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"),
  payload: text("payload"), status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"),
  runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"), leaseOwner: text("lease_owner"), leaseExpiresAt: ts("lease_expires_at"), claimToken: text("claim_token"),
  idempotencyKey: text("idempotency_key"), idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"),
  lastError: text("last_error"), resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"),
  completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const execs = s.table("job_executions", {
  id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"),
  errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at"),
})

describe("PostgreSQL job partition-head index", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 4 })
  const captured: Array<{ sql: string; params: unknown[] }> = []
  const session = createPgSession(drizzle(pool, { logger: { logQuery: (sql, params) => { if (sql.includes(" ahead ")) captured.push({ sql, params }) } } }) as never)
  const store = createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } })
  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.jobs(id text primary key, job_type text, job_version int, tenant_id text, scope text, payload text, status text, priority int, attempts int NOT NULL, max_attempts int NOT NULL, run_at timestamptz, next_attempt_at timestamptz, lease_owner text, lease_expires_at timestamptz, claim_token text, idempotency_key text, idempotency_scope text, fingerprint text, correlation_id text, last_error text, result_payload text, metadata text, created_at timestamptz, started_at timestamptz, completed_at timestamptz, partition_key text, UNIQUE(idempotency_scope, idempotency_key));
CREATE TABLE ${SCHEMA}.job_executions(id text primary key, job_id text not null, attempt int not null, worker_id text not null, status text not null, error_message text, started_at timestamptz not null, finished_at timestamptz not null);
-- 300 000 rows, almost all finished; 0.2 % are due or running, spread over many partitions.
INSERT INTO ${SCHEMA}.jobs(id,tenant_id,scope,status,priority,attempts,max_attempts,run_at,partition_key,lease_expires_at)
SELECT 'j'||i, CASE WHEN i%2=0 THEN NULL ELSE 't1' END, 'tenant', CASE WHEN i%1000=1 THEN 'running' WHEN i%1000=2 THEN 'pending' ELSE 'succeeded' END, i%5, 0, 3, now(),
  CASE WHEN i%1000=1 THEN 'r'||i ELSE 'p'||(i%12000) END, now()+interval '1 hour' FROM generate_series(0,299999) i;
ANALYZE ${SCHEMA}.jobs;`)
  }, 60_000)
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined); await pool.end() })

  const explainClaim = async (): Promise<string> => {
    captured.length = 0
    await store.claimDue({ workerId: "w", limit: 10, leaseDurationMs: 60_000, requester: { scope: "tenant", tenantId: "t1", actorId: "actor" } })
    const statement = captured.find((entry) => /^update /i.test(entry.sql))
    expect(statement, "the claim UPDATE was captured").toBeDefined()
    return (await pool.query(`EXPLAIN ${statement!.sql}`, statement!.params)).rows.map((row) => String(row["QUERY PLAN"])).join("\n")
  }

  it("migration 0003 adds the partial partition index, is idempotent, and the claim's ahead subquery uses it", async () => {
    const before = await explainClaim()
    expect(before).not.toContain("jobs_partition_head_idx")
    // Without the index the partition lookup reads all of the jobs table (Seq Scan on "ahead").
    expect(before).toMatch(/Seq Scan on jobs ahead/)

    const migration = await readPostgresMigration("0003_job_partition_head_index.sql", SCHEMA)
    await pool.query(migration)
    await pool.query(migration)
    await pool.query(`ANALYZE ${SCHEMA}.jobs`)
    const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'jobs_partition_head_idx'", [SCHEMA])
    expect(index.rows).toHaveLength(1)
    expect(String(index.rows[0].indexdef)).toContain("(partition_key, scope, tenant_id, status) WHERE (partition_key IS NOT NULL)")

    const after = await explainClaim()
    expect(after).toMatch(/Index Scan using jobs_partition_head_idx on jobs ahead/)
    expect(after).not.toMatch(/Seq Scan on jobs ahead/)
  }, 60_000)

  it("migration 0003 leaves a schema without a jobs table alone (the fixture schema has none)", async () => {
    const exists = await pool.query("SELECT to_regclass('framework_test.jobs') AS jobs")
    if (exists.rows[0].jobs !== null) return
    await pool.query(await readPostgresMigration("0003_job_partition_head_index.sql"))
    expect((await pool.query("SELECT 1 FROM pg_indexes WHERE schemaname = 'framework_test' AND indexname = 'jobs_partition_head_idx'")).rows).toHaveLength(0)
  })
})
