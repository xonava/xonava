import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe } from "vitest"
import { DrizzleMySqlJobStore } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"
import { defineConcurrentLinearizability, defineConcurrentStorm, defineDispatcherAgainstStore } from "../shared/jobStoreDifferentialConcurrency.js"
import { defineLifecycleDifferential, defineLifecycleRegressions, printCoverage, type JobStoreDifferentialDriver, type RawJobRow } from "../shared/jobStoreDifferential.js"

const DATABASE = "framework_df_jobs"
const ms = (value: unknown): number | null => (value === null || value === undefined ? null : new Date(value as string).getTime())

function databaseUrl(): string {
  const url = new URL(mysqlCertificationUrl())
  url.pathname = `/${DATABASE}`
  return url.toString()
}

describe("MySQL job store differential", () => {
  // The pool connects lazily; the database is created in beforeAll before the first query.
  const pool: Pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 12 })
  const q = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0] as Record<string, unknown>[]
  const driverFor = (history: "best_effort" | "required"): JobStoreDifferentialDriver => ({
    label: `mysql/${history}`,
    store: new DrizzleMySqlJobStore(pool, { executionHistory: history }),
    historyRequired: false,
    zombieFirst: true,
    expiredFinalAttemptError: "LEASE_EXPIRED_ATTEMPTS_EXHAUSTED",
    reset: async () => { await pool.query("DELETE FROM job_executions"); await pool.query("DELETE FROM jobs") },
    expireLease: async (id) => { await pool.query("UPDATE jobs SET lease_expires_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR WHERE id = ? AND status = 'running'", [id]) },
    dump: async (): Promise<RawJobRow[]> => (await q("SELECT * FROM jobs")).map((r) => ({
      id: r.id as string, status: r.status as string, attempts: r.attempt as number, maxAttempts: r.max_attempts as number, priority: r.priority as number,
      runAt: ms(r.run_at)!, nextAttemptAt: ms(r.next_attempt_at), leaseOwner: r.worker_id as string | null, claimToken: r.claim_token as string | null,
      leaseExpiresAt: ms(r.lease_expires_at), lastError: r.last_error as string | null, resultPayload: r.result_payload, startedAt: ms(r.started_at),
      completedAt: ms(r.completed_at), partitionKey: r.partition_key as string | null, correlationId: r.correlation_id as string | null,
      idempotencyKey: r.idempotency_key as string | null, tenantId: r.tenant_id as string | null, scope: r.scope as string, jobType: r.job_type as string,
      jobVersion: r.job_version as number, payload: r.payload, metadata: r.metadata,
    })),
    executionsFor: async (jobIds) => (await q("SELECT id, job_id, attempt, worker_id, status FROM job_executions WHERE job_id IN (?)", [jobIds])).map((r) => ({ id: r.id as string, jobId: r.job_id as string, attempt: r.attempt as number, workerId: r.worker_id as string, status: r.status as string })),
    executions: async (ids) => (await q("SELECT id, job_id, attempt, worker_id, status FROM job_executions WHERE id IN (?)", [ids])).map((r) => ({ id: r.id as string, jobId: r.job_id as string, attempt: r.attempt as number, workerId: r.worker_id as string, status: r.status as string })),
  })

  beforeAll(async () => {
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    await admin.end()
    const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/mysql/migrations/0001_framework.sql"), "utf8")
    for (const statement of source.split(";").map((value) => value.trim()).filter(Boolean)) {
      const match = /^CREATE TABLE (?:IF NOT EXISTS )?(jobs|job_executions)\b/.exec(statement)
      if (match) await pool.query(statement)
    }
  })
  afterAll(async () => {
    printCoverage("mysql")
    await pool.end()
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.end()
  })

  defineLifecycleRegressions(driverFor("required"))
  defineLifecycleDifferential(driverFor("required"))
  defineLifecycleDifferential(driverFor("best_effort"))
  defineConcurrentLinearizability(driverFor("required"))
  defineConcurrentLinearizability(driverFor("best_effort"))
  defineConcurrentStorm(driverFor("required"))
  defineDispatcherAgainstStore(driverFor("required"))
})
