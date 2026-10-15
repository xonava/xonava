import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { boolean, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import { createDrizzleJobStore, createDrizzleScheduleStore, createPgSession, DrizzlePgJobProgressStore, type DrizzleSessionLike } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"

const SCHEMA = "adapter_jobstore_it"
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
const schedules = s.table("schedules", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: boolean("enabled"), paused: boolean("paused"), overlapPolicy: text("overlap_policy"),
  misfirePolicy: text("misfire_policy"), nextRunAt: ts("next_run_at"), lastRunAt: ts("last_run_at"), lastStatus: text("last_status"), lastError: text("last_error"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: ts("lease_expires_at"), claimToken: text("claim_token"),
})

const DDL = `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.jobs(id text primary key, job_type text, job_version int, tenant_id text, scope text, payload text, status text, priority int, attempts int, max_attempts int, run_at timestamptz, next_attempt_at timestamptz, lease_owner text, lease_expires_at timestamptz, claim_token text, idempotency_key text, idempotency_scope text, fingerprint text, correlation_id text, last_error text, result_payload text, metadata text, created_at timestamptz, started_at timestamptz, completed_at timestamptz, partition_key text, UNIQUE(idempotency_scope, idempotency_key));
CREATE TABLE ${SCHEMA}.job_executions(id text primary key, job_id text not null, attempt int not null, worker_id text not null, status text not null, error_message text, started_at timestamptz not null, finished_at timestamptz not null);
CREATE TABLE ${SCHEMA}.job_progress(job_id text primary key references ${SCHEMA}.jobs(id) on delete cascade, attempt int not null, sequence bigint not null, percent double precision, checkpoint jsonb, updated_at timestamptz not null);
CREATE TABLE ${SCHEMA}.schedules(id text primary key, job_type text, job_version int, tenant_id text, scope text, payload text, cron_expression text, timezone text, enabled boolean, paused boolean, overlap_policy text, misfire_policy text, next_run_at timestamptz, last_run_at timestamptz, last_status text, last_error text, lease_owner text, lease_expires_at timestamptz, claim_token text);`

const jobColumns = getTableColumns(jobs) as never
const execColumns = { id: execs.id, jobId: execs.jobId, attempt: execs.attempt, workerId: execs.workerId, status: execs.status, errorMessage: execs.errorMessage, startedAt: execs.startedAt, finishedAt: execs.finishedAt }
const sys = { scope: "system", actorId: "it" } as const
const tenant = (tenantId: string) => ({ scope: "tenant", tenantId, actorId: "it" }) as const
const job = (overrides: Record<string, unknown> = {}) => ({ jobType: "probe", jobVersion: 1, payload: {}, executionScope: { kind: "system", systemKey: "framework" }, ...overrides }) as never
const fixedRunAt = new Date("2026-01-01T00:00:00.000Z")

describe("PostgreSQL DrizzleJobStore against a real database", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 6 })
  const db = drizzle(pool)
  const session = createPgSession(db as never)
  const store = (history: "best_effort" | "required" = "best_effort", on: DrizzleSessionLike = session) =>
    createDrizzleJobStore(on, { jobsTable: jobs, executionsTable: execs, executionHistory: history, columnMap: { jobs: jobColumns, executions: execColumns } })
  const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows

  beforeAll(async () => { await pool.query(DDL) })
  beforeEach(async () => { await pool.query(`TRUNCATE ${SCHEMA}.jobs, ${SCHEMA}.job_executions, ${SCHEMA}.job_progress, ${SCHEMA}.schedules`) })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  it("D1: a required-history transition with a stale claim token is not applied and writes no history", async () => {
    const jobStore = store("required")
    const enqueued = await jobStore.enqueue({ job: job(), requester: sys })
    const [claimed] = await jobStore.claimDue({ limit: 1, workerId: "w1", leaseDurationMs: 60_000, requester: sys })
    expect(claimed?.id).toBe(enqueued.id)
    await expect(jobStore.markSucceeded({ jobId: enqueued.id, workerId: "w1", claimToken: "stale-token", attempt: 1 })).resolves.toEqual({ applied: false, reason: "LEASE_LOST" })
    expect((await q(`SELECT status FROM ${SCHEMA}.jobs WHERE id=$1`, [enqueued.id]))[0]).toEqual({ status: "running" })
    expect(await q(`SELECT id FROM ${SCHEMA}.job_executions`)).toHaveLength(0)
  })

  it("D2: execution history persists job, worker, error and timestamps (best-effort and required)", async () => {
    for (const mode of ["best_effort", "required"] as const) {
      await pool.query(`TRUNCATE ${SCHEMA}.jobs, ${SCHEMA}.job_executions CASCADE`)
      const jobStore = store(mode)
      const enqueued = await jobStore.enqueue({ job: job(), requester: sys })
      const [claimed] = await jobStore.claimDue({ limit: 1, workerId: "w1", leaseDurationMs: 60_000, requester: sys })
      const result = await jobStore.markRetrying({ jobId: enqueued.id, workerId: "w1", claimToken: claimed!.claimToken!, attempt: 1, error: "boom", nextAttemptAt: new Date() })
      expect(result).toMatchObject({ applied: true })
      const rows = await q(`SELECT job_id, attempt, worker_id, status, error_message, started_at, finished_at FROM ${SCHEMA}.job_executions`)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ job_id: enqueued.id, attempt: 1, worker_id: "w1", status: "retrying", error_message: "boom" })
      expect(rows[0].started_at).toBeInstanceOf(Date)
      expect(rows[0].finished_at).toBeInstanceOf(Date)
    }
  })

  it("D3: cancel with required history records the job's attempt atomically", async () => {
    const jobStore = store("required")
    const enqueued = await jobStore.enqueue({ job: job(), requester: sys })
    const result = await jobStore.cancel({ jobId: enqueued.id, requester: sys, reason: "operator" })
    expect(result).toMatchObject({ applied: true })
    expect((await q(`SELECT status, claim_token FROM ${SCHEMA}.jobs WHERE id=$1`, [enqueued.id]))[0]).toEqual({ status: "cancelled", claim_token: null })
    expect(await q(`SELECT job_id, attempt, worker_id, status, error_message FROM ${SCHEMA}.job_executions`)).toEqual([{ job_id: enqueued.id, attempt: 0, worker_id: "cancellation", status: "cancelled", error_message: "operator" }])
  })

  it("D4: an idempotent replay returns the existing job, also inside a transaction", async () => {
    const first = await store().enqueue({ job: job({ idempotencyKey: "k1", runAt: fixedRunAt }), requester: sys })
    await expect(store().enqueue({ job: job({ idempotencyKey: "k1", runAt: fixedRunAt }), requester: sys })).resolves.toMatchObject({ id: first.id })
    const inTx = await db.transaction(async (tx) => {
      const replay = await store("best_effort", createPgSession(tx as never)).enqueue({ job: job({ idempotencyKey: "k1", runAt: fixedRunAt }), requester: sys })
      // The transaction must still be usable after the replay.
      await tx.execute("SELECT 1")
      return replay
    })
    expect(inTx.id).toBe(first.id)
    await expect(store().enqueue({ job: job({ idempotencyKey: "k1", runAt: fixedRunAt, payload: { different: true } }), requester: sys })).rejects.toMatchObject({ name: "JobIdempotencyConflictError" })
    expect(await q(`SELECT id FROM ${SCHEMA}.jobs`)).toHaveLength(1)
  })

  it("D5: a running job whose lease expired on its final attempt is dead-lettered", async () => {
    const jobStore = store()
    const enqueued = await jobStore.enqueue({ job: job({ maxAttempts: 1 }), requester: sys })
    expect(await jobStore.claimDue({ limit: 1, workerId: "w1", leaseDurationMs: 60_000, requester: sys })).toHaveLength(1)
    await pool.query(`UPDATE ${SCHEMA}.jobs SET lease_expires_at = now() - interval '1 second'`)
    expect(await jobStore.claimDue({ limit: 10, workerId: "w2", leaseDurationMs: 60_000, requester: sys })).toHaveLength(0)
    const [row] = await q(`SELECT status, lease_owner, claim_token, lease_expires_at, last_error, attempts FROM ${SCHEMA}.jobs WHERE id=$1`, [enqueued.id])
    expect(row).toMatchObject({ status: "dead_letter", lease_owner: null, claim_token: null, lease_expires_at: null, attempts: 1 })
    expect(row.last_error).toMatch(/lease expired/i)
  })

  it("D6: a busy partition does not starve other due jobs under a limit", async () => {
    const jobStore = store()
    for (let index = 0; index < 4; index++) await jobStore.enqueue({ job: job({ partitionKey: "P", priority: 0 }), requester: sys })
    const other = await jobStore.enqueue({ job: job({ priority: 5 }), requester: sys })
    const first = await jobStore.claimDue({ limit: 1, workerId: "w1", leaseDurationMs: 60_000, requester: sys })
    expect(first.map((claimed) => claimed.partitionKey)).toEqual(["P"])
    const second = await jobStore.claimDue({ limit: 2, workerId: "w2", leaseDurationMs: 60_000, requester: sys })
    expect(second.map((claimed) => claimed.id)).toEqual([other.id])
  })

  it("D6: a fresh batch claims at most one job per partition and concurrent claimers never double-claim", async () => {
    const jobStore = store()
    for (let index = 0; index < 3; index++) await jobStore.enqueue({ job: job({ partitionKey: "P" }), requester: sys })
    for (let index = 0; index < 6; index++) await jobStore.enqueue({ job: job(), requester: sys })
    const batches = await Promise.all(["a", "b", "c", "d"].map((worker) => jobStore.claimDue({ limit: 3, workerId: worker, leaseDurationMs: 60_000, requester: sys })))
    const ids = batches.flat().map((claimed) => claimed.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(batches.flat().filter((claimed) => claimed.partitionKey === "P")).toHaveLength(1)
    expect((await q(`SELECT count(*)::int AS n FROM ${SCHEMA}.jobs WHERE status='running'`))[0].n).toBe(ids.length)
  })

  it("D7: partition serialization is scoped per tenant", async () => {
    const jobStore = store()
    await jobStore.enqueue({ job: job({ partitionKey: "invoices", executionScope: { kind: "tenant", tenantId: "t1" } }), requester: tenant("t1") })
    await jobStore.enqueue({ job: job({ partitionKey: "invoices", executionScope: { kind: "tenant", tenantId: "t2" } }), requester: tenant("t2") })
    expect(await jobStore.claimDue({ limit: 5, workerId: "w1", leaseDurationMs: 60_000, requester: tenant("t1") })).toHaveLength(1)
    expect(await jobStore.claimDue({ limit: 5, workerId: "w2", leaseDurationMs: 60_000, requester: tenant("t2") })).toHaveLength(1)
  })

  it("D10: a history failure reports a sanitized category, not the provider message", async () => {
    await pool.query(`ALTER TABLE ${SCHEMA}.job_executions ADD CONSTRAINT secret_history_guard CHECK (worker_id <> 'w-secret')`)
    try {
      const jobStore = store("required")
      const enqueued = await jobStore.enqueue({ job: job(), requester: sys })
      const [claimed] = await jobStore.claimDue({ limit: 1, workerId: "w-secret", leaseDurationMs: 60_000, requester: sys })
      const result = await jobStore.markSucceeded({ jobId: enqueued.id, workerId: "w-secret", claimToken: claimed!.claimToken!, attempt: 1 })
      expect(result).toMatchObject({ applied: false, reason: "HISTORY_FAILED" })
      expect(result.historyError).not.toMatch(/secret|job_executions|insert|constraint/i)
      expect((await q(`SELECT status FROM ${SCHEMA}.jobs WHERE id=$1`, [enqueued.id]))[0]).toEqual({ status: "running" })
    } finally {
      await pool.query(`ALTER TABLE ${SCHEMA}.job_executions DROP CONSTRAINT secret_history_guard`)
    }
  })

  it("progress store fences on the job store's own column names", async () => {
    const jobStore = store()
    const enqueued = await jobStore.enqueue({ job: job(), requester: sys })
    const [claimed] = await jobStore.claimDue({ limit: 1, workerId: "w1", leaseDurationMs: 60_000, requester: sys })
    const progress = new DrizzlePgJobProgressStore(pool, { schema: SCHEMA, jobsTable: "jobs", jobColumns })
    await expect(progress.write({ jobId: enqueued.id, workerId: "w1", claimToken: claimed!.claimToken!, attempt: 1 }, 0, { percent: 10 })).resolves.toMatchObject({ sequence: 1, percent: 10 })
    await expect(progress.write({ jobId: enqueued.id, workerId: "w1", claimToken: "stale", attempt: 1 }, 1, { percent: 20 })).rejects.toMatchObject({ code: "STALE_CLAIM" })
  })

  it("schedule claim re-checks pause state inside the claiming UPDATE", async () => {
    await pool.query(`INSERT INTO ${SCHEMA}.schedules VALUES ('s1','probe',1,null,'system','{}','* * * * *','UTC',true,false,'allow','fire_now',now() - interval '1 minute',null,null,null,null,null,null)`)
    let paused = false
    const racing: DrizzleSessionLike = {
      ...session,
      update: (table) => {
        const builder = session.update(table)
        return { set: (data) => { const set = builder.set(data); return { where: (where) => {
          const run = (async () => { if (!paused) { paused = true; await pool.query(`UPDATE ${SCHEMA}.schedules SET paused = true`) } return set.where(where) })()
          return Object.assign(run, { returning: () => { throw new Error("unused") } }) as never
        } } } }
      },
    }
    const scheduleColumns = getTableColumns(schedules) as never
    const scheduleStore = createDrizzleScheduleStore(racing, { schedulesTable: schedules, columnMap: { schedules: scheduleColumns } })
    expect(await scheduleStore.claimDueSchedules({ limit: 5, workerId: "w1", leaseDurationMs: 60_000 } as never)).toHaveLength(0)
    expect((await q(`SELECT last_status, lease_owner FROM ${SCHEMA}.schedules`))[0]).toEqual({ last_status: null, lease_owner: null })
  })
})
