import pg from "pg"
import { afterAll, beforeAll, describe, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { boolean, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import { createDrizzleJobStore, createDrizzlePersistenceProvider, createDrizzleScheduleStore, createPgSession, DrizzleEntityRegistry, DrizzlePgWorkflowStore } from "@xonava/adapters/drizzle-pg"
import { announcements } from "../../tests/standaloneGuideExample.js"
import { readPostgresMigration } from "../../fixtures/postgres/bootstrap.js"
import { pgCertificationUrl } from "./database.js"
import { assertJobScopeKeysSurviveRoundTrip, assertJobsUnderScope, assertPlatformEntityPersistence, assertPlatformHttp, assertSchedulesUnderScope, assertWorkflowsUnderScope, type PlatformPhysicalProbe } from "../shared/platformScope.js"

// Own schema: other suites use the same server concurrently.
const SCHEMA = "platform_scope_it"
const s = pgSchema(SCHEMA)
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })
const announcementTable = s.table("announcements", {
  id: text("id").primaryKey(), title: text("title").notNull(), region: text("region").notNull(), priority: integer("priority").notNull(), version: integer("version").notNull(),
})
const jobs = s.table("jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"),
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
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: boolean("enabled"), paused: boolean("paused"), overlapPolicy: text("overlap_policy"),
  misfirePolicy: text("misfire_policy"), nextRunAt: ts("next_run_at"), lastRunAt: ts("last_run_at"), lastStatus: text("last_status"), lastError: text("last_error"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: ts("lease_expires_at"), claimToken: text("claim_token"), remainingOccurrences: integer("remaining_occurrences"),
})

const DDL = `
CREATE TABLE ${SCHEMA}.announcements(id text primary key, title text NOT NULL, region text NOT NULL, priority integer NOT NULL, version integer NOT NULL);
CREATE TABLE ${SCHEMA}.jobs(id text primary key, job_type text, job_version int, tenant_id text, scope text, scope_key text, payload text, status text, priority int, attempts int NOT NULL, max_attempts int NOT NULL, run_at timestamptz, next_attempt_at timestamptz, lease_owner text, lease_expires_at timestamptz, claim_token text, idempotency_key text, idempotency_scope text, fingerprint text, correlation_id text, last_error text, result_payload text, metadata text, created_at timestamptz, started_at timestamptz, completed_at timestamptz, partition_key text, UNIQUE(idempotency_scope, idempotency_key));
CREATE TABLE ${SCHEMA}.job_executions(id text primary key, job_id text not null, attempt int not null, worker_id text not null, status text not null, error_message text, started_at timestamptz not null, finished_at timestamptz not null);
CREATE TABLE ${SCHEMA}.schedules(id text primary key, job_type text, job_version int, tenant_id text, scope text, scope_key text, payload text, cron_expression text, timezone text, enabled boolean, paused boolean NOT NULL DEFAULT false, overlap_policy text, misfire_policy text, next_run_at timestamptz, last_run_at timestamptz, last_status text, last_error text, lease_owner text, lease_expires_at timestamptz, claim_token text, remaining_occurrences int);`

describe("PostgreSQL platform scope", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 6 })
  const orm = drizzle(pool)
  const registry = new DrizzleEntityRegistry().register(announcements, announcementTable, {
    id: announcementTable.id, title: announcementTable.title, region: announcementTable.region, priority: announcementTable.priority, version: announcementTable.version,
  })
  const provider = createDrizzlePersistenceProvider({ db: orm, registry })
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows
  const probe: PlatformPhysicalProbe = {
    columns: async () => (await q("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='announcements'", [SCHEMA])).map((row) => String(row.column_name)),
    exists: async (rowId) => (await q(`SELECT 1 FROM ${SCHEMA}.announcements WHERE id=$1`, [rowId])).length === 1,
  }
  const session = createPgSession(orm as never)
  const jobStore = createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } })
  const scheduleStore = createDrizzleScheduleStore(session, { schedulesTable: schedules, columnMap: { schedules: getTableColumns(schedules) as never } })
  const workflowStore = new DrizzlePgWorkflowStore(pool, { schema: SCHEMA })

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    // Fixture migrations 0001-0002 re-targeted at this suite's schema create the workflow tables.
    await pool.query(await readPostgresMigration("0001_framework.sql", SCHEMA))
    await pool.query(await readPostgresMigration("0002_workflow_signal_buffering.sql", SCHEMA))
    await pool.query(DDL)
  })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  it("persists a platform entity without a partition column: CRUD, list, query and OCC", async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.announcements`)
    await assertPlatformEntityPersistence(provider, probe)
  })

  it("serves the platform entity through createCrudHandlers with a fixed platform scope plan", async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.announcements`)
    await assertPlatformHttp(provider, probe)
  })

  it("runs platform and system jobs under their own scope", async () => {
    await assertJobsUnderScope(jobStore, "ps-pg")
  })

  it("materializes platform and system schedules into jobs of the same scope", async () => {
    await assertSchedulesUnderScope({
      scheduleStore, jobStore, prefix: "ps-pg",
      insertSchedule: async (row) => { await q(`INSERT INTO ${SCHEMA}.schedules(id,job_type,job_version,tenant_id,scope,scope_key,payload,cron_expression,timezone,enabled,overlap_policy,misfire_policy,next_run_at) VALUES($1,$2,1,NULL,$3,$4,'{}','0 * * * *','UTC',true,'allow','fire_now',$5)`, [row.id, row.jobType, row.scope, row.scopeKey, row.nextRunAt]) },
      readSchedule: async (scheduleId) => { const row = (await q(`SELECT next_run_at,last_status FROM ${SCHEMA}.schedules WHERE id=$1`, [scheduleId]))[0]!; return { nextRunAt: new Date(row.next_run_at as string), lastStatus: row.last_status as string | null } },
    })
  })

  it("runs a workflow under platform and system scope and keeps the scope keys", async () => {
    await assertWorkflowsUnderScope(workflowStore, `ps-wf-pg-${Date.now()}`)
  })

  it("keeps a job's platformKey and systemKey through the job store", async () => {
    await assertJobScopeKeysSurviveRoundTrip(jobStore, "ps-pg")
  })
})
