import { afterAll, beforeAll, describe } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { getTableColumns } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1Adapter, createDrizzleJobStore } from "@xonava/adapters/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { defineConcurrentLinearizability, defineConcurrentStorm, defineDispatcherAgainstStore } from "../shared/jobStoreDifferentialConcurrency.js"
import { defineLifecycleDifferential, defineLifecycleRegressions, printCoverage, type JobStoreDifferentialDriver, type RawJobRow } from "../shared/jobStoreDifferential.js"

const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const jobs = sqliteTable("df_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"),
  resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const execs = sqliteTable("df_execs", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at") })
const SCHEMA = [
  "CREATE TABLE df_jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)",
  "CREATE UNIQUE INDEX df_jobs_idem ON df_jobs (idempotency_scope, idempotency_key)",
  "CREATE TABLE df_execs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)",
]

describe("D1 job store differential", () => {
  let fixture: D1Fixture
  const d1 = () => fixture.db
  // The store is created lazily so the Miniflare database exists by the time a property runs.
  const lazyStore = (history: "best_effort" | "required") => {
    let store: ReturnType<typeof createDrizzleJobStore> | undefined
    const get = () => (store ??= createDrizzleJobStore(createDrizzleD1Adapter(drizzle(d1() as never) as never).repository, { jobsTable: jobs, executionsTable: execs, executionHistory: history, columnMap: { jobs: getTableColumns(jobs) as never, executions: getTableColumns(execs) as never } }))
    return new Proxy({} as ReturnType<typeof createDrizzleJobStore>, { get: (_target, property) => (get() as never)[property as never] && typeof (get() as never)[property as never] === "function" ? ((...args: unknown[]) => ((get() as never)[property as never] as (...a: unknown[]) => unknown)(...args)) : (get() as never)[property as never] })
  }
  const all = async (sql: string, ...params: unknown[]) => ((await d1().prepare(sql).bind(...params).all()).results ?? []) as Record<string, unknown>[]
  const run = async (sql: string, ...params: unknown[]) => { await d1().prepare(sql).bind(...params).run() }
  const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))
  const driverFor = (history: "best_effort" | "required"): JobStoreDifferentialDriver => ({
    label: `d1/${history}`,
    store: lazyStore(history),
    historyRequired: history === "required",
    expiredFinalAttemptError: "LEASE_EXPIRED_AFTER_FINAL_ATTEMPT",
    lifecycleRuns: 50,
    light: true,
    leaseTickMs: 600,
    claimReadbackMayLoseToCancel: true,
    reset: async () => { await run("DELETE FROM df_execs"); await run("DELETE FROM df_jobs") },
    expireLease: async (id) => { await run("UPDATE df_jobs SET lease_expires_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - 3600000 WHERE id = ? AND status = 'running'", id) },
    dump: async (): Promise<RawJobRow[]> => (await all("SELECT * FROM df_jobs")).map((r) => ({
      id: r.id as string, status: r.status as string, attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), priority: Number(r.priority),
      runAt: Number(r.run_at), nextAttemptAt: num(r.next_attempt_at), leaseOwner: r.lease_owner as string | null, claimToken: r.claim_token as string | null,
      leaseExpiresAt: num(r.lease_expires_at), lastError: r.last_error as string | null, resultPayload: r.result_payload, startedAt: num(r.started_at),
      completedAt: num(r.completed_at), partitionKey: r.partition_key as string | null, correlationId: r.correlation_id as string | null,
      idempotencyKey: r.idempotency_key as string | null, tenantId: r.tenant_id as string | null, scope: r.scope as string, jobType: r.job_type as string,
      jobVersion: Number(r.job_version), payload: r.payload, metadata: r.metadata,
    })),
    executionsFor: async (jobIds) => (await all(`SELECT id, job_id, attempt, worker_id, status FROM df_execs WHERE job_id IN (${jobIds.map(() => "?").join(",")})`, ...jobIds)).map((r) => ({ id: r.id as string, jobId: r.job_id as string, attempt: Number(r.attempt), workerId: r.worker_id as string, status: r.status as string })),
    executions: async (ids) => (await all(`SELECT id, job_id, attempt, worker_id, status FROM df_execs WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids)).map((r) => ({ id: r.id as string, jobId: r.job_id as string, attempt: Number(r.attempt), workerId: r.worker_id as string, status: r.status as string })),
  })

  beforeAll(async () => {
    fixture = await openD1Fixture()
    for (const statement of SCHEMA) await fixture.db.exec(statement)
  })
  afterAll(async () => { printCoverage("d1"); await fixture?.close() })

  defineLifecycleRegressions(driverFor("best_effort"))
  defineLifecycleDifferential(driverFor("best_effort"))
  defineLifecycleDifferential(driverFor("required"))
  defineConcurrentLinearizability(driverFor("best_effort"))
  defineConcurrentStorm(driverFor("best_effort"))
  defineDispatcherAgainstStore(driverFor("best_effort"))
})
