import { afterEach, describe, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1Adapter, createDrizzleJobStore, createDrizzlePersistenceProvider, createDrizzleScheduleStore, DrizzleD1WorkflowStore, DrizzleEntityRegistry } from "@xonava/adapters/drizzle-d1"
import { announcements } from "../../tests/standaloneGuideExample.js"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { assertJobScopeKeysSurviveRoundTrip, assertJobsUnderScope, assertPlatformEntityPersistence, assertPlatformHttp, assertSchedulesUnderScope, assertWorkflowsUnderScope, type PlatformPhysicalProbe } from "../shared/platformScope.js"

// Table names are private to this suite; every test opens its own Miniflare database.
const announcementTable = sqliteTable("ps_announcements", {
  id: text("id").primaryKey(), title: text("title").notNull(), region: text("region").notNull(), priority: integer("priority").notNull(), version: integer("version").notNull(),
})
// D1 applies conditional writes in one atomic batch and proves the affected-row count through this table.
const assertions = sqliteTable("ps_assertions", {
  scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"),
  expectedAffectedRows: integer("expected_affected_rows"), actualAffectedRows: integer("actual_affected_rows"),
})
const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const jobs = sqliteTable("ps_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"),
  resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const execs = sqliteTable("ps_execs", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at") })
const schedules = sqliteTable("ps_schedules", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: integer("enabled", { mode: "boolean" }), overlapPolicy: text("overlap_policy"),
  misfirePolicy: text("misfire_policy"), nextRunAt: ts("next_run_at"), lastRunAt: ts("last_run_at"), lastStatus: text("last_status"), lastError: text("last_error"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), remainingOccurrences: integer("remaining_occurrences"),
})
const SCHEMA = [
  "CREATE TABLE ps_assertions (scope TEXT, key TEXT, fingerprint TEXT, token TEXT, expected_affected_rows INTEGER, actual_affected_rows INTEGER, CHECK (expected_affected_rows IS NULL OR expected_affected_rows = actual_affected_rows))",
  "CREATE TABLE ps_announcements (id TEXT PRIMARY KEY, title TEXT NOT NULL, region TEXT NOT NULL, priority INTEGER NOT NULL, version INTEGER NOT NULL)",
  "CREATE TABLE ps_jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)",
  "CREATE UNIQUE INDEX ps_jobs_idem ON ps_jobs (idempotency_scope, idempotency_key)",
  "CREATE TABLE ps_execs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)",
  "CREATE TABLE ps_schedules (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, payload TEXT, cron_expression TEXT, timezone TEXT, enabled INTEGER, overlap_policy TEXT, misfire_policy TEXT, next_run_at INTEGER, last_run_at INTEGER, last_status TEXT, last_error TEXT, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, remaining_occurrences INTEGER)",
]

let fixture: D1Fixture | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })

async function setup() {
  fixture = await openD1Fixture()
  const d1 = fixture.db
  for (const statement of SCHEMA) await d1.exec(statement)
  const orm = drizzle(d1 as never)
  const registry = new DrizzleEntityRegistry().register(announcements, announcementTable, {
    id: announcementTable.id, title: announcementTable.title, region: announcementTable.region, priority: announcementTable.priority, version: announcementTable.version,
  })
  const provider = createDrizzlePersistenceProvider({ db: orm as never, registry, mutationAssertionTable: assertions })
  const probe: PlatformPhysicalProbe = {
    columns: async () => (await d1.prepare("PRAGMA table_info(ps_announcements)").all<{ name: string }>()).results.map((row: { name: string }) => row.name),
    exists: async (rowId) => (await d1.prepare("SELECT count(*) AS c FROM ps_announcements WHERE id=?").bind(rowId).first<{ c: number }>())!.c === 1,
  }
  const session = createDrizzleD1Adapter(orm as never).repository
  const jobStore = createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } })
  const scheduleStore = createDrizzleScheduleStore(session, { schedulesTable: schedules, columnMap: { schedules: getTableColumns(schedules) as never } })
  return { d1, provider, probe, jobStore, scheduleStore, workflowStore: new DrizzleD1WorkflowStore(d1 as never) }
}

describe("D1 platform scope", () => {
  it("persists a platform entity without a partition column: CRUD, list, query and OCC", async () => {
    const { provider, probe } = await setup()
    await assertPlatformEntityPersistence(provider, probe)
  })

  it("serves the platform entity through createCrudHandlers with a fixed platform scope plan", async () => {
    const { provider, probe } = await setup()
    await assertPlatformHttp(provider, probe)
  }, 60_000)

  it("runs platform and system jobs under their own scope", async () => {
    const { jobStore } = await setup()
    await assertJobsUnderScope(jobStore, "ps-d1")
  })

  it("materializes platform and system schedules into jobs of the same scope", async () => {
    const { d1, jobStore, scheduleStore } = await setup()
    await assertSchedulesUnderScope({
      scheduleStore, jobStore, prefix: "ps-d1",
      insertSchedule: async (row) => { await d1.prepare("INSERT INTO ps_schedules(id,job_type,job_version,tenant_id,scope,payload,cron_expression,timezone,enabled,overlap_policy,misfire_policy,next_run_at) VALUES(?,?,1,NULL,?,'{}','0 * * * *','UTC',1,'allow','fire_now',?)").bind(row.id, row.jobType, row.scope, row.nextRunAt.getTime()).run() },
      readSchedule: async (scheduleId) => {
        const row = (await d1.prepare("SELECT next_run_at,last_status FROM ps_schedules WHERE id=?").bind(scheduleId).first<Record<string, unknown>>())!
        return { nextRunAt: new Date(Number(row.next_run_at)), lastStatus: row.last_status as string | null }
      },
    })
  })

  it("runs a workflow under platform and system scope and keeps the scope keys", async () => {
    const { workflowStore } = await setup()
    await assertWorkflowsUnderScope(workflowStore, "ps-wf-d1")
  })

  // Known bug, fixed by another work package: the job store reads every platform job back with platformKey "default".
  it.fails("keeps a job's platformKey through the job store", async () => {
    const { jobStore } = await setup()
    await assertJobScopeKeysSurviveRoundTrip(jobStore, "ps-d1")
  })
})
