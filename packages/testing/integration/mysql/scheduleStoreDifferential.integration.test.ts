import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe, it } from "vitest"
import { DrizzleMySqlJobStore, DrizzleMySqlScheduleStore } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"
import { applyMySqlByteExactIdentifiersMigration, applyMySqlScheduleNextRunNullableMigration } from "../../fixtures/mysql/bootstrap.js"
import { assertConcurrentClaimInvariants, assertScheduleStoreMatchesReference, scaledTimeoutMs, type ScheduleDriver } from "../shared/scheduleStoreDifferential.js"
import {
  assertClaimWithoutNowUsesTheClock, assertDispatcherEnqueuesEachOccurrenceOnce, assertElapsedLeaseExpiryFencesOldOwner, assertLiveClaimsDoNotConsumeClaimLimit,
  assertNullNextRunAtRetiresSchedule, assertRenewalNeverShortensLease,
} from "../shared/scheduleStoreDifferentialScenarios.js"

// Own database: other suites share this server.
const DATABASE = "framework_df_schedules"
const TABLES = new Set(["jobs", "job_executions", "schedules"])

describe("MySQL schedule store differential", () => {
  let pool: Pool
  let driver: ScheduleDriver
  let jobStore: DrizzleMySqlJobStore

  beforeAll(async () => {
    const url = new URL(mysqlCertificationUrl())
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    await admin.end()
    url.pathname = `/${DATABASE}`
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 12 })
    // The schedule, job and execution tables exactly as the fixture migration declares them.
    const migration = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/mysql/migrations/0001_framework.sql"), "utf8")
    for (const statement of migration.split(";").map((value) => value.trim()).filter(Boolean)) {
      const match = /^CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/.exec(statement)
      if (match && TABLES.has(match[1]!)) await pool.query(statement)
    }
    // Later fixture migrations alter these tables (0003 makes schedules.next_run_at nullable).
    await applyMySqlScheduleNextRunNullableMigration(pool)
    await applyMySqlByteExactIdentifiersMigration(pool, ["schedules", "jobs", "job_executions"])
    jobStore = new DrizzleMySqlJobStore(pool)
    driver = {
      label: "mysql", store: new DrizzleMySqlScheduleStore(pool), nullableNextRunAt: true,
      dialect: {
        table: "schedules", leaseOwnerColumn: "worker_id", param: () => "?", time: (ms) => (ms === null ? null : new Date(ms)), bool: (value) => value,
        fromTime: (value) => (value === null ? null : value instanceof Date ? value.getTime() : new Date(String(value)).getTime()), fromBool: (value) => Boolean(value),
      },
      run: async (sql, params) => { await pool.query(sql, params) },
      all: async (sql, params) => (await pool.query<RowDataPacket[]>(sql, params))[0] as Array<Record<string, unknown>>,
    }
  })
  afterAll(async () => { await pool.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``); await pool.end() })

  it("matches the reference store over random lifecycle sequences", async () => { await assertScheduleStoreMatchesReference(driver) }, scaledTimeoutMs(120_000))
  it("holds the claim invariants under concurrent workers", async () => { await assertConcurrentClaimInvariants(driver) }, scaledTimeoutMs(120_000))
  it("does not let live claims use up another worker's claim limit", async () => { await assertLiveClaimsDoNotConsumeClaimLimit(driver) })
  it("never shortens a lease on renewal", async () => { await assertRenewalNeverShortensLease(driver) })
  it("claims by the real clock when no time is given", async () => { await assertClaimWithoutNowUsesTheClock(driver) })
  it("fences the old owner after a lease really runs out", async () => { await assertElapsedLeaseExpiryFencesOldOwner(driver) })
  it("retires a schedule advanced with no next occurrence", async () => { await assertNullNextRunAtRetiresSchedule(driver) })
  it("enqueues each materialized occurrence exactly once across workers and crashes", async () => {
    await assertDispatcherEnqueuesEachOccurrenceOnce({
      driver, jobStore,
      jobKeys: async () => (await pool.query<RowDataPacket[]>("SELECT idempotency_key FROM jobs"))[0].map((row) => row.idempotency_key as string),
      clearJobs: async () => { await pool.query("DELETE FROM job_executions"); await pool.query("DELETE FROM jobs") },
    })
  }, 60_000)
})
