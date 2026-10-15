import { afterAll, beforeAll, describe, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1Adapter, createDrizzleJobStore, createDrizzleScheduleStore } from "@xonava/adapters/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { assertConcurrentClaimInvariants, assertScheduleStoreMatchesReference, scaledTimeoutMs, type ScheduleDriver } from "../shared/scheduleStoreDifferential.js"
import {
  assertClaimWithoutNowUsesTheClock, assertDispatcherEnqueuesEachOccurrenceOnce, assertElapsedLeaseExpiryFencesOldOwner, assertLiveClaimsDoNotConsumeClaimLimit,
  assertNullNextRunAtRetiresSchedule, assertRenewalNeverShortensLease, assertTenantTimezoneResolution,
} from "../shared/scheduleStoreDifferentialScenarios.js"

// Own Miniflare instance (openD1Fixture creates a private in-memory database) with its own tables.
const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const jobs = sqliteTable("df_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"),
  resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const execs = sqliteTable("df_execs", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at") })
const schedules = sqliteTable("df_schedules", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: integer("enabled", { mode: "boolean" }), paused: integer("paused", { mode: "boolean" }),
  overlapPolicy: text("overlap_policy"), misfirePolicy: text("misfire_policy"), nextRunAt: ts("next_run_at"), lastRunAt: ts("last_run_at"), lastStatus: text("last_status"),
  lastError: text("last_error"), leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), remainingOccurrences: integer("remaining_occurrences"),
  effectiveFrom: ts("effective_from"), effectiveUntil: ts("effective_until"), calendarExclusionKey: text("calendar_exclusion_key"), owner: text("owner"), description: text("description"),
})
const SCHEMA = [
  "CREATE TABLE df_jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)",
  "CREATE UNIQUE INDEX df_jobs_idem ON df_jobs (idempotency_scope, idempotency_key)",
  "CREATE TABLE df_execs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)",
  "CREATE TABLE df_schedules (id TEXT PRIMARY KEY, job_type TEXT NOT NULL, job_version INTEGER NOT NULL, tenant_id TEXT, scope TEXT NOT NULL, payload TEXT NOT NULL, cron_expression TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0, overlap_policy TEXT NOT NULL, misfire_policy TEXT NOT NULL, next_run_at INTEGER, last_run_at INTEGER, last_status TEXT, last_error TEXT, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, remaining_occurrences INTEGER, effective_from INTEGER, effective_until INTEGER, calendar_exclusion_key TEXT, owner TEXT, description TEXT)",
]

describe("D1 schedule store differential", () => {
  let fixture: D1Fixture
  let driver: ScheduleDriver
  let resolving: ReturnType<typeof createDrizzleScheduleStore>
  let jobStore: ReturnType<typeof createDrizzleJobStore>
  let jobKeys: () => Promise<string[]>
  let clearJobs: () => Promise<void>

  beforeAll(async () => {
    fixture = await openD1Fixture()
    const d1 = fixture.db
    for (const statement of SCHEMA) await d1.exec(statement)
    const session = createDrizzleD1Adapter(drizzle(d1 as never) as never).repository
    const config = { schedulesTable: schedules, columnMap: { schedules: getTableColumns(schedules) as never } }
    jobStore = createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } })
    resolving = createDrizzleScheduleStore(session, { ...config, resolveTenantTimezones: async (_db, tenantIds) => new Map(tenantIds.filter((id) => id === "tenant-1").map((id) => [id, "America/Chicago"])) })
    driver = {
      label: "d1", store: createDrizzleScheduleStore(session, config), nullableNextRunAt: true, slowRoundTrips: true,
      dialect: {
        table: "df_schedules", leaseOwnerColumn: "lease_owner", param: () => "?", time: (ms) => ms, bool: (value) => (value ? 1 : 0),
        fromTime: (value) => (value === null ? null : Number(value)), fromBool: (value) => Number(value) === 1,
      },
      run: async (sql, params) => { await d1.prepare(sql).bind(...params).run() },
      runMany: async (statements) => { await d1.batch(statements.map((statement) => d1.prepare(statement.sql).bind(...statement.params))) },
      all: async (sql, params) => (await d1.prepare(sql).bind(...params).all<Record<string, unknown>>()).results,
    }
    jobKeys = async () => (await d1.prepare("SELECT idempotency_key FROM df_jobs").all<{ idempotency_key: string }>()).results.map((row: { idempotency_key: string }) => row.idempotency_key)
    clearJobs = async () => { await d1.exec("DELETE FROM df_execs"); await d1.exec("DELETE FROM df_jobs") }
  })
  afterAll(async () => { await fixture?.close() })

  it("matches the reference store over random lifecycle sequences", async () => { await assertScheduleStoreMatchesReference(driver) }, scaledTimeoutMs(240_000))
  it("holds the claim invariants under concurrent workers", async () => { await assertConcurrentClaimInvariants(driver) }, scaledTimeoutMs(240_000))
  it("does not let live claims use up another worker's claim limit", async () => { await assertLiveClaimsDoNotConsumeClaimLimit(driver) })
  it("never shortens a lease on renewal", async () => { await assertRenewalNeverShortensLease(driver) })
  it("claims by the real clock when no time is given", async () => { await assertClaimWithoutNowUsesTheClock(driver) })
  it("fences the old owner after a lease really runs out", async () => { await assertElapsedLeaseExpiryFencesOldOwner(driver) })
  it("retires a schedule advanced with no next occurrence", async () => { await assertNullNextRunAtRetiresSchedule(driver) })
  it("resolves tenant time zones through the configured resolver", async () => { await assertTenantTimezoneResolution(driver, resolving) })
  it("enqueues each materialized occurrence exactly once across workers and crashes", async () => {
    await assertDispatcherEnqueuesEachOccurrenceOnce({ driver, jobStore, jobKeys, clearJobs })
  }, 120_000)
})
