import { afterEach, describe, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1Adapter, createDrizzleJobStore, createDrizzleScheduleStore } from "adapters/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { assertDefinitionMaxAttempts, assertScheduleOccurrencesAndBackoff } from "../shared/jobScheduleSemantics.js"

const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const jobs = sqliteTable("js_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"),
  resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const execs = sqliteTable("js_execs", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at") })
const schedules = sqliteTable("js_schedules", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: integer("enabled", { mode: "boolean" }), overlapPolicy: text("overlap_policy"),
  misfirePolicy: text("misfire_policy"), nextRunAt: ts("next_run_at"), lastRunAt: ts("last_run_at"), lastStatus: text("last_status"), lastError: text("last_error"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), remainingOccurrences: integer("remaining_occurrences"),
})
const SCHEMA = [
  "CREATE TABLE js_jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)",
  "CREATE UNIQUE INDEX js_jobs_idem ON js_jobs (idempotency_scope, idempotency_key)",
  "CREATE TABLE js_execs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)",
  "CREATE TABLE js_schedules (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, payload TEXT, cron_expression TEXT, timezone TEXT, enabled INTEGER, overlap_policy TEXT, misfire_policy TEXT, next_run_at INTEGER, last_run_at INTEGER, last_status TEXT, last_error TEXT, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, remaining_occurrences INTEGER)",
]

let fixture: D1Fixture | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })

async function setup() {
  fixture = await openD1Fixture()
  const d1 = fixture.db
  for (const statement of SCHEMA) await d1.exec(statement)
  const session = createDrizzleD1Adapter(drizzle(d1 as never) as never).repository
  const jobStore = createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } })
  const scheduleStore = createDrizzleScheduleStore(session, { schedulesTable: schedules, columnMap: { schedules: getTableColumns(schedules) as never } })
  return { d1, jobStore, scheduleStore }
}

describe("D1 job and schedule semantics", () => {
  it("applies the job definition's maxAttempts when a job has no explicit budget", async () => {
    const { d1, jobStore } = await setup()
    await assertDefinitionMaxAttempts(jobStore, async (id) => Number((await d1.prepare("SELECT max_attempts FROM js_jobs WHERE id=?").bind(id).first<{ max_attempts: number }>())!.max_attempts))
  })

  it("caps catch-up by remainingOccurrences and backs off failing schedules", async () => {
    const { d1, jobStore, scheduleStore } = await setup()
    await assertScheduleOccurrencesAndBackoff({
      scheduleStore, jobStore, prefix: "d1",
      insertSchedule: async (row) => { await d1.prepare("INSERT INTO js_schedules(id,job_type,job_version,tenant_id,scope,payload,cron_expression,timezone,enabled,overlap_policy,misfire_policy,next_run_at,remaining_occurrences) VALUES(?,'sched.job',1,NULL,'system',?,?,'UTC',1,'allow',?,?,?)").bind(row.id, JSON.stringify(row.payload), row.cronExpression, row.misfirePolicy, row.nextRunAt.getTime(), row.remainingOccurrences).run() },
      readSchedule: async (id) => {
        const row = (await d1.prepare("SELECT next_run_at,last_status,last_error,remaining_occurrences FROM js_schedules WHERE id=?").bind(id).first<Record<string, unknown>>())!
        return { nextRunAt: new Date(Number(row.next_run_at)), lastStatus: row.last_status as string | null, lastError: row.last_error as string | null, remainingOccurrences: row.remaining_occurrences as number | null }
      },
    })
  })
})
