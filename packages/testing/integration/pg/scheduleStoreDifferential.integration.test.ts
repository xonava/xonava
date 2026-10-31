import pg from "pg"
import { afterAll, beforeAll, describe, it } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { boolean, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import { createDrizzleJobStore, createDrizzleScheduleStore, createPgSession } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import { assertConcurrentClaimInvariants, assertScheduleStoreMatchesReference, scaledTimeoutMs, type ScheduleDriver } from "../shared/scheduleStoreDifferential.js"
import {
  assertClaimWithoutNowUsesTheClock, assertDispatcherEnqueuesEachOccurrenceOnce, assertElapsedLeaseExpiryFencesOldOwner, assertLiveClaimsDoNotConsumeClaimLimit,
  assertNullNextRunAtRetiresSchedule, assertRenewalNeverShortensLease, assertScheduleScopeKeysRoundTrip, assertTenantTimezoneResolution,
} from "../shared/scheduleStoreDifferentialScenarios.js"

// Own schema: other suites share this server.
const SCHEMA = "df_schedules"
const s = pgSchema(SCHEMA)
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })
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
  effectiveFrom: ts("effective_from"), effectiveUntil: ts("effective_until"), calendarExclusionKey: text("calendar_exclusion_key"), owner: text("owner"), description: text("description"),
})

const DDL = `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.jobs(id text primary key, job_type text, job_version int, tenant_id text, scope text, scope_key text, payload text, status text, priority int, attempts int NOT NULL, max_attempts int NOT NULL, run_at timestamptz, next_attempt_at timestamptz, lease_owner text, lease_expires_at timestamptz, claim_token text, idempotency_key text, idempotency_scope text, fingerprint text, correlation_id text, last_error text, result_payload text, metadata text, created_at timestamptz, started_at timestamptz, completed_at timestamptz, partition_key text, UNIQUE(idempotency_scope, idempotency_key));
CREATE TABLE ${SCHEMA}.job_executions(id text primary key, job_id text not null, attempt int not null, worker_id text not null, status text not null, error_message text, started_at timestamptz not null, finished_at timestamptz not null);
CREATE TABLE ${SCHEMA}.schedules(id text primary key, job_type text NOT NULL, job_version int NOT NULL, tenant_id text, scope text NOT NULL, scope_key text, payload text NOT NULL, cron_expression text NOT NULL, timezone text NOT NULL, enabled boolean NOT NULL, paused boolean NOT NULL DEFAULT false, overlap_policy text NOT NULL, misfire_policy text NOT NULL, next_run_at timestamptz, last_run_at timestamptz, last_status text, last_error text, lease_owner text, lease_expires_at timestamptz, claim_token text, remaining_occurrences int, effective_from timestamptz, effective_until timestamptz, calendar_exclusion_key text, owner text, description text);`

describe("PostgreSQL schedule store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 8 })
  const session = createPgSession(drizzle(pool) as never)
  const config = { schedulesTable: schedules, columnMap: { schedules: getTableColumns(schedules) as never } }
  const jobStore = createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } })
  const driver: ScheduleDriver = {
    label: "pg", store: createDrizzleScheduleStore(session, config), nullableNextRunAt: true,
    dialect: {
      table: `${SCHEMA}.schedules`, leaseOwnerColumn: "lease_owner", param: (index) => `$${index}`, time: (ms) => (ms === null ? null : new Date(ms)), bool: (value) => value,
      fromTime: (value) => (value === null ? null : value instanceof Date ? value.getTime() : new Date(String(value)).getTime()), fromBool: (value) => Boolean(value),
    },
    run: async (sql, params) => { await pool.query(sql, params) },
    all: async (sql, params) => (await pool.query(sql, params)).rows as Array<Record<string, unknown>>,
  }

  beforeAll(async () => { await pool.query(DDL) })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  it("matches the reference store over random lifecycle sequences", async () => { await assertScheduleStoreMatchesReference(driver) }, scaledTimeoutMs(120_000))
  it("holds the claim invariants under concurrent workers", async () => { await assertConcurrentClaimInvariants(driver) }, scaledTimeoutMs(120_000))
  it("does not let live claims use up another worker's claim limit", async () => { await assertLiveClaimsDoNotConsumeClaimLimit(driver) })
  it("round-trips platform and system keys on claim and decodes key-less rows to the defaults", async () => { await assertScheduleScopeKeysRoundTrip(driver) })
  it("never shortens a lease on renewal", async () => { await assertRenewalNeverShortensLease(driver) })
  it("claims by the real clock when no time is given", async () => { await assertClaimWithoutNowUsesTheClock(driver) })
  it("fences the old owner after a lease really runs out", async () => { await assertElapsedLeaseExpiryFencesOldOwner(driver) })
  it("retires a schedule advanced with no next occurrence", async () => { await assertNullNextRunAtRetiresSchedule(driver) })
  it("resolves tenant time zones through the configured resolver", async () => {
    const resolving = createDrizzleScheduleStore(session, { ...config, resolveTenantTimezones: async (_db, tenantIds) => new Map(tenantIds.filter((id) => id === "tenant-1").map((id) => [id, "America/Chicago"])) })
    await assertTenantTimezoneResolution(driver, resolving)
  })
  it("enqueues each materialized occurrence exactly once across workers and crashes", async () => {
    await assertDispatcherEnqueuesEachOccurrenceOnce({
      driver, jobStore,
      jobKeys: async () => (await pool.query(`SELECT idempotency_key FROM ${SCHEMA}.jobs`)).rows.map((row) => row.idempotency_key as string),
      clearJobs: async () => { await pool.query(`DELETE FROM ${SCHEMA}.job_executions; DELETE FROM ${SCHEMA}.jobs`) },
    })
  }, 60_000)
})
