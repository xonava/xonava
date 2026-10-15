import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import { getTableColumns } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core"
import { createDrizzleJobStore, createPgSession } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import { defineConcurrentLinearizability, defineConcurrentStorm, defineDispatcherAgainstStore } from "../shared/jobStoreDifferentialConcurrency.js"
import { defineLifecycleDifferential, defineLifecycleRegressions, printCoverage, type JobStoreDifferentialDriver, type RawJobRow } from "../shared/jobStoreDifferential.js"

const SCHEMA = "df_jobs"
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

const DDL = `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.jobs(id text primary key, job_type text, job_version int, tenant_id text, scope text, payload text, status text, priority int, attempts int NOT NULL, max_attempts int NOT NULL, run_at timestamptz, next_attempt_at timestamptz, lease_owner text, lease_expires_at timestamptz, claim_token text, idempotency_key text, idempotency_scope text, fingerprint text, correlation_id text, last_error text, result_payload text, metadata text, created_at timestamptz, started_at timestamptz, completed_at timestamptz, partition_key text, UNIQUE(idempotency_scope, idempotency_key));
CREATE TABLE ${SCHEMA}.job_executions(id text primary key, job_id text not null, attempt int not null, worker_id text not null, status text not null, error_message text, started_at timestamptz not null, finished_at timestamptz not null);`

const ms = (value: unknown): number | null => (value === null || value === undefined ? null : new Date(value as string).getTime())

describe("PostgreSQL job store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 8 })
  const session = createPgSession(drizzle(pool) as never)
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as Record<string, unknown>[]
  const driverFor = (history: "best_effort" | "required"): JobStoreDifferentialDriver => ({
    label: `postgres/${history}`,
    store: createDrizzleJobStore(session, { jobsTable: jobs, executionsTable: execs, executionHistory: history, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } }),
    historyRequired: history === "required",
    expiredFinalAttemptError: "Lease expired on final attempt",
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.jobs, ${SCHEMA}.job_executions`) },
    expireLease: async (id) => { await pool.query(`UPDATE ${SCHEMA}.jobs SET lease_expires_at = now() - interval '1 hour' WHERE id = $1 AND status = 'running'`, [id]) },
    dump: async (): Promise<RawJobRow[]> => (await q(`SELECT * FROM ${SCHEMA}.jobs`)).map((r) => ({
      id: r.id as string, status: r.status as string, attempts: r.attempts as number, maxAttempts: r.max_attempts as number, priority: r.priority as number,
      runAt: ms(r.run_at)!, nextAttemptAt: ms(r.next_attempt_at), leaseOwner: r.lease_owner as string | null, claimToken: r.claim_token as string | null,
      leaseExpiresAt: ms(r.lease_expires_at), lastError: r.last_error as string | null, resultPayload: r.result_payload, startedAt: ms(r.started_at),
      completedAt: ms(r.completed_at), partitionKey: r.partition_key as string | null, correlationId: r.correlation_id as string | null,
      idempotencyKey: r.idempotency_key as string | null, tenantId: r.tenant_id as string | null, scope: r.scope as string, jobType: r.job_type as string,
      jobVersion: r.job_version as number, payload: r.payload, metadata: r.metadata,
    })),
    executionsFor: async (jobIds) => (await q(`SELECT id, job_id, attempt, worker_id, status FROM ${SCHEMA}.job_executions WHERE job_id = ANY($1)`, [jobIds])).map((r) => ({ id: r.id as string, jobId: r.job_id as string, attempt: r.attempt as number, workerId: r.worker_id as string, status: r.status as string })),
    executions: async (ids) => (await q(`SELECT id, job_id, attempt, worker_id, status FROM ${SCHEMA}.job_executions WHERE id = ANY($1)`, [ids])).map((r) => ({ id: r.id as string, jobId: r.job_id as string, attempt: r.attempt as number, workerId: r.worker_id as string, status: r.status as string })),
  })

  beforeAll(async () => { await pool.query(DDL) })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineLifecycleRegressions(driverFor("best_effort"))
  defineLifecycleDifferential(driverFor("best_effort"))
  defineLifecycleDifferential(driverFor("required"))
  defineConcurrentLinearizability(driverFor("best_effort"))
  defineConcurrentLinearizability(driverFor("required"))
  defineConcurrentStorm(driverFor("best_effort"))
  defineDispatcherAgainstStore(driverFor("best_effort"))
  afterAll(() => { printCoverage("pg") })
})
