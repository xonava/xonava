import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { boolean, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import { createDrizzleJobStore, createDrizzleScheduleStore, createPgSession } from "adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import { assertDefinitionMaxAttempts, assertScheduleOccurrencesAndBackoff } from "../shared/jobScheduleSemantics.js"

const SCHEMA = "job_schedule_semantics_it"
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
  leaseOwner: text("lease_owner"), leaseExpiresAt: ts("lease_expires_at"), claimToken: text("claim_token"), remainingOccurrences: integer("remaining_occurrences"),
})

const DDL = `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.jobs(id text primary key, job_type text, job_version int, tenant_id text, scope text, payload text, status text, priority int, attempts int NOT NULL, max_attempts int NOT NULL, run_at timestamptz, next_attempt_at timestamptz, lease_owner text, lease_expires_at timestamptz, claim_token text, idempotency_key text, idempotency_scope text, fingerprint text, correlation_id text, last_error text, result_payload text, metadata text, created_at timestamptz, started_at timestamptz, completed_at timestamptz, partition_key text, UNIQUE(idempotency_scope, idempotency_key));
CREATE TABLE ${SCHEMA}.job_executions(id text primary key, job_id text not null, attempt int not null, worker_id text not null, status text not null, error_message text, started_at timestamptz not null, finished_at timestamptz not null);
CREATE TABLE ${SCHEMA}.schedules(id text primary key, job_type text, job_version int, tenant_id text, scope text, payload text, cron_expression text, timezone text, enabled boolean, paused boolean NOT NULL DEFAULT false, overlap_policy text, misfire_policy text, next_run_at timestamptz, last_run_at timestamptz, last_status text, last_error text, lease_owner text, lease_expires_at timestamptz, claim_token text, remaining_occurrences int);`

describe("PostgreSQL job and schedule semantics", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 6 })
  const session = createPgSession(drizzle(pool) as never)
  const jobStore = createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } })
  const scheduleStore = createDrizzleScheduleStore(session, { schedulesTable: schedules, columnMap: { schedules: getTableColumns(schedules) as never } })
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows

  beforeAll(async () => { await pool.query(DDL) })
  beforeEach(async () => { await pool.query(`TRUNCATE ${SCHEMA}.jobs, ${SCHEMA}.job_executions, ${SCHEMA}.schedules`) })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  it("applies the job definition's maxAttempts when a job has no explicit budget", async () => {
    await assertDefinitionMaxAttempts(jobStore, async (id) => Number((await q(`SELECT max_attempts FROM ${SCHEMA}.jobs WHERE id=$1`, [id]))[0]!.max_attempts))
  })

  it("caps catch-up by remainingOccurrences and backs off failing schedules", async () => {
    await assertScheduleOccurrencesAndBackoff({
      scheduleStore, jobStore, prefix: "pg",
      insertSchedule: async (row) => { await q(`INSERT INTO ${SCHEMA}.schedules(id,job_type,job_version,tenant_id,scope,payload,cron_expression,timezone,enabled,overlap_policy,misfire_policy,next_run_at,remaining_occurrences) VALUES($1,'sched.job',1,NULL,'system',$2,$3,'UTC',true,'allow',$4,$5,$6)`, [row.id, JSON.stringify(row.payload), row.cronExpression, row.misfirePolicy, row.nextRunAt, row.remainingOccurrences]) },
      readSchedule: async (id) => { const row = (await q(`SELECT next_run_at,last_status,last_error,remaining_occurrences FROM ${SCHEMA}.schedules WHERE id=$1`, [id]))[0]!; return { nextRunAt: new Date(row.next_run_at as string), lastStatus: row.last_status as string | null, lastError: row.last_error as string | null, remainingOccurrences: row.remaining_occurrences as number | null } },
    })
  })
})
