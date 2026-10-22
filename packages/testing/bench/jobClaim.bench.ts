import { afterAll, bench, describe } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1Adapter, createDrizzleJobStore } from "@xonava/adapters/drizzle-d1"
import { applyD1Migration } from "../fixtures/d1/bootstrap.js"
import { temporaryD1Fixture, type D1Fixture } from "../integration/d1/database.js"

/**
 * D1-backed (Miniflare) job claim: the real `claimDue` statements (dead-letter sweep, partition-head candidate select, per-job
 * claim UPDATE, token read-back) against a populated jobs table with the partition-head index applied. The numbers include
 * Miniflare's in-process D1 round trips, so they track the claim's statement count and plans, not production latency.
 * Fixed iteration counts (no time budget) and a reseed before each benchmark keep the queue from draining.
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

const SEEDED_JOBS = 6000
const requester = { scope: "tenant", tenantId: "t1", actorId: "actor" } as const
const BENCH_OPTIONS = { time: 0, warmupTime: 0, warmupIterations: 5, iterations: 60 } as const

let fixture: D1Fixture & { cleanup(): Promise<void> }
let store: ReturnType<typeof createDrizzleJobStore>

/**
 * Restores the seeded queue: 6 000 jobs for tenant t1 across 2 000 partitions, 70 % due, 30 % finished, and 1 % running in
 * partitions that therefore have to be skipped (their lease is live far in the future).
 */
async function reseed(): Promise<void> {
  await fixture.db.exec("DELETE FROM jobs")
  // D1 exec() runs one statement per line, so the seed statement stays on a single line.
  await fixture.db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${SEEDED_JOBS - 1}) INSERT INTO jobs (id, job_type, job_version, payload, fingerprint, created_at, tenant_id, scope, status, priority, attempts, max_attempts, run_at, next_attempt_at, partition_key, lease_owner, lease_expires_at) SELECT 'j' || i, 'bench.job', 1, '{}', 'fp' || i, 1000, 't1', 'tenant', CASE WHEN i % 100 = 0 THEN 'running' WHEN i % 10 < 3 THEN 'succeeded' ELSE 'pending' END, i % 5, CASE WHEN i % 100 = 0 THEN 1 ELSE 0 END, 3, 1000, 1000, 'p' || (i % 2000), CASE WHEN i % 100 = 0 THEN 'other-worker' ELSE NULL END, CASE WHEN i % 100 = 0 THEN 99999999999999 ELSE NULL END FROM n`)
  await fixture.db.exec("ANALYZE")
}

describe("D1 job claim", async () => {
  fixture = await temporaryD1Fixture()
  await fixture.db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)")
  await fixture.db.exec("CREATE TABLE job_executions (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)")
  if (!(await applyD1Migration(fixture.db, "0003_job_partition_head_index.sql"))) throw new Error("partition-head index migration was not applied")
  await reseed()
  store = createDrizzleJobStore(createDrizzleD1Adapter(drizzle(fixture.db as never) as never).repository, {
    jobsTable: jobs, executionsTable: execs, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never },
  })
  const probe = await store.claimDue({ workerId: "bench-probe", limit: 5, leaseDurationMs: 60_000, requester })
  if (probe.length !== 5) throw new Error(`job claim benchmark expected to claim 5 jobs, claimed ${probe.length}`)

  afterAll(async () => { await fixture.close(); await fixture.cleanup() })

  bench("claim 1 due job", async () => {
    await store.claimDue({ workerId: "bench-worker", limit: 1, leaseDurationMs: 60_000, requester })
  }, { ...BENCH_OPTIONS, setup: reseed })
  bench("claim 5 due jobs", async () => {
    await store.claimDue({ workerId: "bench-worker", limit: 5, leaseDurationMs: 60_000, requester })
  }, { ...BENCH_OPTIONS, iterations: 40, setup: reseed })
  bench("claim 25 due jobs", async () => {
    await store.claimDue({ workerId: "bench-worker", limit: 25, leaseDurationMs: 60_000, requester })
  }, { ...BENCH_OPTIONS, iterations: 20, setup: reseed })
})
