import mysql from "mysql2/promise"
import pg from "pg"
import { getTableColumns } from "drizzle-orm"
import { drizzle as drizzleD1 } from "drizzle-orm/d1"
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres"
import { boolean, integer as pgInteger, pgSchema, text as pgText, timestamp } from "drizzle-orm/pg-core"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1Adapter, createDrizzleJobStore as createD1JobStore, createDrizzleScheduleStore as createD1ScheduleStore, DrizzleD1WorkflowStore } from "@xonava/adapters/drizzle-d1"
import { createDrizzleJobStore as createPgJobStore, createDrizzleScheduleStore as createPgScheduleStore, createPgSession, DrizzlePgWorkflowStore } from "@xonava/adapters/drizzle-pg"
import { DrizzleMySqlJobStore, DrizzleMySqlScheduleStore, DrizzleMySqlWorkflowStore } from "@xonava/adapters/drizzle-mysql"
import type { JobStore, ScheduleStore } from "@xonava/core/execution"
import type { WorkflowStore } from "@xonava/core/workflow"
import { asyncD1Binding } from "../integration/d1/asyncD1.js"
import { temporaryD1Fixture } from "../integration/d1/database.js"
import { tolerateStaleConnections } from "../integration/d1/staleConnection.js"
import { readPostgresMigration } from "../fixtures/postgres/bootstrap.js"
import { POSTGRES_FIXTURE_MIGRATIONS } from "../fixtures/postgres/schema.js"
import { bootstrapMySqlFixture } from "../fixtures/mysql/bootstrap.js"
import type { ScheduleDriver } from "../integration/shared/scheduleStoreDifferential.js"
import type { DbReceipt } from "../integration/shared/workflowSignalBuffering.js"
import type { SoakAdapter } from "./config.js"

/**
 * The database side of the soak. Every database is private to the run (its own D1 instance, PostgreSQL schema or MySQL
 * database) so the soak cannot collide with other suites or agents sharing the server.
 *
 * D1 runs in the orchestrator process: workerd allows one process per database file (a second process gets
 * SQLITE_BUSY), exactly like the real service, where Workers reach D1 over the network. The worker processes therefore
 * talk to the Miniflare worker in front of the database over HTTP with the same wire protocol the in-process fixtures
 * use (asyncD1Binding), and a SIGKILL of a worker loses its in-flight request like a crashed Worker would.
 * PostgreSQL and MySQL workers hold their own connections; a killed worker's open transaction is rolled back by the server.
 */
export type SoakDescriptor =
  | { adapter: "d1"; url: string }
  | { adapter: "pg"; url: string; schema: string }
  | { adapter: "mysql"; url: string }

export type SoakRow = Record<string, unknown>

/** SQL with `?` placeholders on every database (rewritten to `$n` for PostgreSQL; statements that already use `$n` pass through). */
export interface SoakSql {
  run(sql: string, params?: readonly unknown[]): Promise<number>
  all(sql: string, params?: readonly unknown[]): Promise<SoakRow[]>
  /** Inserts the row unless its primary key exists; true when this call inserted it. */
  insertIgnore(table: string, row: Readonly<Record<string, unknown>>): Promise<boolean>
  /** The qualified name of one of the soak-owned tables. */
  table(name: SoakTable): string
}

export type SoakTable = "soak_inflight" | "soak_runs" | "soak_violations" | "soak_signal_uses"

export interface SoakConnection {
  readonly adapter: SoakAdapter
  readonly jobStore: JobStore
  readonly scheduleStore: ScheduleStore
  readonly workflowStore: WorkflowStore
  readonly sql: SoakSql
  /** Used to create schedule rows the way a deployer's admin tooling would (shared with the schedule differential). */
  readonly scheduleDriver: ScheduleDriver
  /** Qualified job tables and the name of the attempts column, for the whole-table invariant scans. */
  readonly jobsTable: string
  readonly jobExecutionsTable: string
  readonly jobAttemptsColumn: string
  receipts(instanceIds: readonly string[]): Promise<DbReceipt[]>
  close(): Promise<void>
}

const TEXT = "VARCHAR(190)"
function soakDdl(qualify: (name: SoakTable) => string): string[] {
  return [
    `CREATE TABLE ${qualify("soak_inflight")} (unit ${TEXT} PRIMARY KEY, worker ${TEXT} NOT NULL, started_ms BIGINT NOT NULL)`,
    `CREATE TABLE ${qualify("soak_runs")} (unit ${TEXT} NOT NULL, attempt INTEGER NOT NULL, worker ${TEXT} NOT NULL, started_ms BIGINT NOT NULL, outcome ${TEXT}, PRIMARY KEY (unit, attempt))`,
    `CREATE TABLE ${qualify("soak_violations")} (id ${TEXT} PRIMARY KEY, kind ${TEXT} NOT NULL, unit ${TEXT}, detail VARCHAR(500), worker ${TEXT}, at_ms BIGINT NOT NULL)`,
    `CREATE TABLE ${qualify("soak_signal_uses")} (signal_id ${TEXT} NOT NULL, n_after INTEGER NOT NULL, PRIMARY KEY (signal_id, n_after))`,
  ]
}

const columnsOf = (row: Readonly<Record<string, unknown>>): { names: string[]; values: unknown[] } => ({ names: Object.keys(row), values: Object.values(row) })
const toDollar = (statement: string): string => { let index = 0; return statement.replace(/\?/g, () => `$${++index}`) }

// ---------------------------------------------------------------------------------------------------------------------
// D1

const ts = (name: string) => integer(name, { mode: "timestamp_ms" })
const d1Jobs = sqliteTable("soak_jobs", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  status: text("status"), priority: integer("priority"), attempts: integer("attempts"), maxAttempts: integer("max_attempts"), runAt: ts("run_at"), nextAttemptAt: ts("next_attempt_at"),
  leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), idempotencyKey: text("idempotency_key"),
  idempotencyScope: text("idempotency_scope"), fingerprint: text("fingerprint"), correlationId: text("correlation_id"), lastError: text("last_error"),
  resultPayload: text("result_payload"), metadata: text("metadata"), createdAt: ts("created_at"), startedAt: ts("started_at"), completedAt: ts("completed_at"), partitionKey: text("partition_key"),
})
const d1Execs = sqliteTable("soak_job_execs", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt"), workerId: text("worker_id"), status: text("status"), errorMessage: text("error_message"), startedAt: ts("started_at"), finishedAt: ts("finished_at") })
const d1Schedules = sqliteTable("soak_schedules", {
  id: text("id").primaryKey(), jobType: text("job_type"), jobVersion: integer("job_version"), tenantId: text("tenant_id"), scope: text("scope"), scopeKey: text("scope_key"), payload: text("payload"),
  cronExpression: text("cron_expression"), timezone: text("timezone"), enabled: integer("enabled", { mode: "boolean" }), paused: integer("paused", { mode: "boolean" }),
  overlapPolicy: text("overlap_policy"), misfirePolicy: text("misfire_policy"), nextRunAt: ts("next_run_at"), lastRunAt: ts("last_run_at"), lastStatus: text("last_status"),
  lastError: text("last_error"), leaseOwner: text("lease_owner"), leaseExpiresAt: integer("lease_expires_at"), claimToken: text("claim_token"), remainingOccurrences: integer("remaining_occurrences"),
  effectiveFrom: ts("effective_from"), effectiveUntil: ts("effective_until"), calendarExclusionKey: text("calendar_exclusion_key"), owner: text("owner"), description: text("description"),
})
const D1_DDL = [
  "CREATE TABLE soak_jobs (id TEXT PRIMARY KEY, job_type TEXT, job_version INTEGER, tenant_id TEXT, scope TEXT, scope_key TEXT, payload TEXT, status TEXT, priority INTEGER, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, run_at INTEGER, next_attempt_at INTEGER, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, idempotency_key TEXT, idempotency_scope TEXT, fingerprint TEXT, correlation_id TEXT, last_error TEXT, result_payload TEXT, metadata TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER, partition_key TEXT)",
  "CREATE UNIQUE INDEX soak_jobs_idem ON soak_jobs (idempotency_scope, idempotency_key)",
  "CREATE TABLE soak_job_execs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER, worker_id TEXT, status TEXT, error_message TEXT, started_at INTEGER, finished_at INTEGER)",
  "CREATE TABLE soak_schedules (id TEXT PRIMARY KEY, job_type TEXT NOT NULL, job_version INTEGER NOT NULL, tenant_id TEXT, scope TEXT NOT NULL, scope_key TEXT, payload TEXT NOT NULL, cron_expression TEXT NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0, overlap_policy TEXT NOT NULL, misfire_policy TEXT NOT NULL, next_run_at INTEGER, last_run_at INTEGER, last_status TEXT, last_error TEXT, lease_owner TEXT, lease_expires_at INTEGER, claim_token TEXT, remaining_occurrences INTEGER, effective_from INTEGER, effective_until INTEGER, calendar_exclusion_key TEXT, owner TEXT, description TEXT)",
  ...soakDdl((name) => name),
]

type D1Binding = ReturnType<typeof asyncD1Binding>

function connectD1(descriptor: Extract<SoakDescriptor, { adapter: "d1" }>): SoakConnection {
  // A fetch-backed stand-in for Miniflare#dispatchFetch: asyncD1Binding only ever posts to the fixture worker.
  const remote = { dispatchFetch: (_url: unknown, init: RequestInit) => fetch(descriptor.url, init) }
  const db: D1Binding = tolerateStaleConnections(asyncD1Binding(remote as never))
  const session = createDrizzleD1Adapter(drizzleD1(db as never) as never).repository
  const sql: SoakSql = {
    run: async (statement, params = []) => Number(((await db.prepare(statement).bind(...params).run()) as { meta?: { changes?: number } }).meta?.changes ?? 0),
    all: async (statement, params = []) => ((await db.prepare(statement).bind(...params).all()) as { results?: SoakRow[] }).results ?? [],
    insertIgnore: async (table, row) => {
      const { names, values } = columnsOf(row)
      return (await sql.run(`INSERT OR IGNORE INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`, values)) > 0
    },
    table: (name) => name,
  }
  const schedulesConfig = { schedulesTable: d1Schedules, columnMap: { schedules: getTableColumns(d1Schedules) as never } }
  const scheduleStore = createD1ScheduleStore(session, schedulesConfig)
  return {
    adapter: "d1",
    jobStore: createD1JobStore(session, { jobsTable: d1Jobs, executionsTable: d1Execs, columnMap: { jobs: getTableColumns(d1Jobs) as never, executions: getTableColumns(d1Execs) as never } }),
    scheduleStore,
    workflowStore: new DrizzleD1WorkflowStore(db as never),
    sql,
    scheduleDriver: {
      label: "d1", store: scheduleStore, nullableNextRunAt: true,
      dialect: { table: "soak_schedules", leaseOwnerColumn: "lease_owner", param: () => "?", time: (ms) => ms, bool: (value) => (value ? 1 : 0), fromTime: (value) => (value === null ? null : Number(value)), fromBool: (value) => Number(value) === 1 },
      run: async (statement, params) => { await sql.run(statement, params) },
      all: (statement, params) => sql.all(statement, params),
    },
    jobsTable: "soak_jobs", jobExecutionsTable: "soak_job_execs", jobAttemptsColumn: "attempts",
    receipts: async (ids) => (await sql.all(`SELECT id,instance_id,name,seq,consumed_at_ms,consumed_revision FROM framework_workflow_signals WHERE instance_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`, ids)).map((row) => ({
      id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), seq: Number(row.seq), consumed: row.consumed_at_ms != null, consumedRevision: row.consumed_revision == null ? null : Number(row.consumed_revision),
    })),
    close: async () => undefined,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// PostgreSQL

function pgTables(schema: string) {
  const s = pgSchema(schema)
  const pts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })
  const jobs = s.table("jobs", {
    id: pgText("id").primaryKey(), jobType: pgText("job_type"), jobVersion: pgInteger("job_version"), tenantId: pgText("tenant_id"), scope: pgText("scope"), scopeKey: pgText("scope_key"),
    payload: pgText("payload"), status: pgText("status"), priority: pgInteger("priority"), attempts: pgInteger("attempts"), maxAttempts: pgInteger("max_attempts"),
    runAt: pts("run_at"), nextAttemptAt: pts("next_attempt_at"), leaseOwner: pgText("lease_owner"), leaseExpiresAt: pts("lease_expires_at"), claimToken: pgText("claim_token"),
    idempotencyKey: pgText("idempotency_key"), idempotencyScope: pgText("idempotency_scope"), fingerprint: pgText("fingerprint"), correlationId: pgText("correlation_id"),
    lastError: pgText("last_error"), resultPayload: pgText("result_payload"), metadata: pgText("metadata"), createdAt: pts("created_at"), startedAt: pts("started_at"),
    completedAt: pts("completed_at"), partitionKey: pgText("partition_key"),
  })
  const execs = s.table("job_executions", {
    id: pgText("id").primaryKey(), jobId: pgText("job_id"), attempt: pgInteger("attempt"), workerId: pgText("worker_id"), status: pgText("status"),
    errorMessage: pgText("error_message"), startedAt: pts("started_at"), finishedAt: pts("finished_at"),
  })
  const schedules = s.table("schedules", {
    id: pgText("id").primaryKey(), jobType: pgText("job_type"), jobVersion: pgInteger("job_version"), tenantId: pgText("tenant_id"), scope: pgText("scope"), scopeKey: pgText("scope_key"), payload: pgText("payload"),
    cronExpression: pgText("cron_expression"), timezone: pgText("timezone"), enabled: boolean("enabled"), paused: boolean("paused"), overlapPolicy: pgText("overlap_policy"),
    misfirePolicy: pgText("misfire_policy"), nextRunAt: pts("next_run_at"), lastRunAt: pts("last_run_at"), lastStatus: pgText("last_status"), lastError: pgText("last_error"),
    leaseOwner: pgText("lease_owner"), leaseExpiresAt: pts("lease_expires_at"), claimToken: pgText("claim_token"), remainingOccurrences: pgInteger("remaining_occurrences"),
    effectiveFrom: pts("effective_from"), effectiveUntil: pts("effective_until"), calendarExclusionKey: pgText("calendar_exclusion_key"), owner: pgText("owner"), description: pgText("description"),
  })
  return { jobs, execs, schedules }
}

function pgJobDdl(schema: string): string {
  return `CREATE TABLE ${schema}.jobs(id text primary key, job_type text, job_version int, tenant_id text, scope text, scope_key text, payload text, status text, priority int, attempts int NOT NULL, max_attempts int NOT NULL, run_at timestamptz, next_attempt_at timestamptz, lease_owner text, lease_expires_at timestamptz, claim_token text, idempotency_key text, idempotency_scope text, fingerprint text, correlation_id text, last_error text, result_payload text, metadata text, created_at timestamptz, started_at timestamptz, completed_at timestamptz, partition_key text, UNIQUE(idempotency_scope, idempotency_key));
CREATE TABLE ${schema}.job_executions(id text primary key, job_id text not null, attempt int not null, worker_id text not null, status text not null, error_message text, started_at timestamptz not null, finished_at timestamptz not null);
CREATE TABLE ${schema}.schedules(id text primary key, job_type text NOT NULL, job_version int NOT NULL, tenant_id text, scope text NOT NULL, scope_key text, payload text NOT NULL, cron_expression text NOT NULL, timezone text NOT NULL, enabled boolean NOT NULL, paused boolean NOT NULL DEFAULT false, overlap_policy text NOT NULL, misfire_policy text NOT NULL, next_run_at timestamptz, last_run_at timestamptz, last_status text, last_error text, lease_owner text, lease_expires_at timestamptz, claim_token text, remaining_occurrences int, effective_from timestamptz, effective_until timestamptz, calendar_exclusion_key text, owner text, description text);`
}

function connectPg(descriptor: Extract<SoakDescriptor, { adapter: "pg" }>): SoakConnection {
  const { schema } = descriptor
  const pool = new pg.Pool({ connectionString: descriptor.url, max: 6 })
  pool.on("error", () => undefined)
  const tables = pgTables(schema)
  const session = createPgSession(drizzlePg(pool) as never)
  const sql: SoakSql = {
    run: async (statement, params = []) => (await pool.query(toDollar(statement), [...params])).rowCount ?? 0,
    all: async (statement, params = []) => (await pool.query(toDollar(statement), [...params])).rows as SoakRow[],
    insertIgnore: async (table, row) => {
      const { names, values } = columnsOf(row)
      return (await sql.run(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")}) ON CONFLICT DO NOTHING`, values)) > 0
    },
    table: (name) => `${schema}.${name}`,
  }
  const scheduleStore = createPgScheduleStore(session, { schedulesTable: tables.schedules, columnMap: { schedules: getTableColumns(tables.schedules) as never } })
  return {
    adapter: "pg",
    jobStore: createPgJobStore(session, { jobsTable: tables.jobs, executionsTable: tables.execs, columnMap: { jobs: getTableColumns(tables.jobs) as never, executions: getTableColumns(tables.execs) as never } }),
    scheduleStore,
    workflowStore: new DrizzlePgWorkflowStore(pool, { schema }),
    sql,
    scheduleDriver: {
      label: "pg", store: scheduleStore, nullableNextRunAt: true,
      dialect: {
        table: `${schema}.schedules`, leaseOwnerColumn: "lease_owner", param: (index) => `$${index}`, time: (ms) => (ms === null ? null : new Date(ms)), bool: (value) => value,
        fromTime: (value) => (value === null ? null : value instanceof Date ? value.getTime() : new Date(String(value)).getTime()), fromBool: (value) => Boolean(value),
      },
      run: async (statement, params) => { await sql.run(statement, params) },
      all: (statement, params) => sql.all(statement, params),
    },
    jobsTable: `${schema}.jobs`, jobExecutionsTable: `${schema}.job_executions`, jobAttemptsColumn: "attempts",
    receipts: async (ids) => (await sql.all(`SELECT id,instance_id,name,seq,consumed_at,consumed_revision FROM ${schema}.workflow_signals WHERE instance_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`, ids)).map((row) => ({
      id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), seq: Number(row.seq), consumed: row.consumed_at != null, consumedRevision: row.consumed_revision == null ? null : Number(row.consumed_revision),
    })),
    close: async () => { await pool.end() },
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// MySQL

function connectMySql(descriptor: Extract<SoakDescriptor, { adapter: "mysql" }>): SoakConnection {
  const pool = mysql.createPool({ uri: descriptor.url, connectionLimit: 6 })
  const sql: SoakSql = {
    run: async (statement, params = []) => Number(((await pool.query(statement, [...params]))[0] as { affectedRows?: number }).affectedRows ?? 0),
    all: async (statement, params = []) => (await pool.query(statement, [...params]))[0] as SoakRow[],
    insertIgnore: async (table, row) => {
      const { names, values } = columnsOf(row)
      return (await sql.run(`INSERT IGNORE INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`, values)) > 0
    },
    table: (name) => name,
  }
  const scheduleStore = new DrizzleMySqlScheduleStore(pool)
  return {
    adapter: "mysql",
    jobStore: new DrizzleMySqlJobStore(pool),
    scheduleStore,
    workflowStore: new DrizzleMySqlWorkflowStore(pool),
    sql,
    scheduleDriver: {
      label: "mysql", store: scheduleStore, nullableNextRunAt: true,
      dialect: {
        table: "schedules", leaseOwnerColumn: "worker_id", param: () => "?", time: (ms) => (ms === null ? null : new Date(ms)), bool: (value) => value,
        fromTime: (value) => (value === null ? null : value instanceof Date ? value.getTime() : new Date(String(value)).getTime()), fromBool: (value) => Boolean(value),
      },
      run: async (statement, params) => { await sql.run(statement, params) },
      all: (statement, params) => sql.all(statement, params),
    },
    jobsTable: "jobs", jobExecutionsTable: "job_executions", jobAttemptsColumn: "attempt",
    receipts: async (ids) => (await sql.all(`SELECT id,instance_id,name,seq,consumed_at,consumed_revision FROM workflow_signals WHERE instance_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`, ids)).map((row) => ({
      id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), seq: Number(row.seq), consumed: row.consumed_at != null, consumedRevision: row.consumed_revision == null ? null : Number(row.consumed_revision),
    })),
    close: async () => { await pool.end() },
  }
}

export function connectSoak(descriptor: SoakDescriptor): SoakConnection {
  if (descriptor.adapter === "d1") return connectD1(descriptor)
  if (descriptor.adapter === "pg") return connectPg(descriptor)
  return connectMySql(descriptor)
}

// ---------------------------------------------------------------------------------------------------------------------
// Hosting (orchestrator side)

export interface SoakHost {
  readonly descriptor: SoakDescriptor
  /** Hosting facts for the evidence file. */
  readonly location: string
  teardown(): Promise<void>
}

const uniqueSuffix = (runId: string): string => `${runId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12)}_${Date.now().toString(36)}_${process.pid}`

export async function hostSoakDatabase(adapter: SoakAdapter, runId: string): Promise<SoakHost> {
  if (adapter === "d1") {
    const fixture = await temporaryD1Fixture()
    for (const statement of D1_DDL) await fixture.db.exec(statement)
    const url = (await fixture.endpoint()).toString()
    return { descriptor: { adapter: "d1", url }, location: `miniflare D1 at ${url}`, teardown: async () => { await fixture.close(); await fixture.cleanup() } }
  }
  if (adapter === "pg") {
    const url = process.env.FRAMEWORK_TEST_PG_URL
    if (!url) throw new Error("PostgreSQL soak requires FRAMEWORK_TEST_PG_URL")
    const schema = `soak_${uniqueSuffix(runId)}`
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA ${schema}`)
      await client.query(pgJobDdl(schema))
      for (const name of POSTGRES_FIXTURE_MIGRATIONS) await client.query(await readPostgresMigration(name, schema))
      for (const statement of soakDdl((name) => `${schema}.${name}`)) await client.query(statement)
    } finally { await client.end() }
    return {
      descriptor: { adapter: "pg", url, schema }, location: `postgres schema ${schema}`,
      teardown: async () => { const drop = new pg.Client({ connectionString: url }); await drop.connect(); try { await drop.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await drop.end() } },
    }
  }
  const baseUrl = process.env.FRAMEWORK_TEST_MYSQL_URL
  if (!baseUrl) throw new Error("MySQL soak requires FRAMEWORK_TEST_MYSQL_URL")
  const database = `framework_soak_${uniqueSuffix(runId)}`
  const admin = mysql.createPool({ uri: baseUrl, connectionLimit: 2 })
  await admin.query(`CREATE DATABASE \`${database}\``)
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  const pool = mysql.createPool({ uri: url.toString(), connectionLimit: 4 })
  try {
    await bootstrapMySqlFixture(pool)
    for (const statement of soakDdl((name) => name)) await pool.query(statement)
  } finally { await pool.end() }
  return {
    descriptor: { adapter: "mysql", url: url.toString() }, location: `mysql database ${database}`,
    teardown: async () => { try { await admin.query(`DROP DATABASE IF EXISTS \`${database}\``) } finally { await admin.end() } },
  }
}

