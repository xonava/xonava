import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe } from "vitest"
import { drizzle } from "drizzle-orm/mysql2"
import * as currentMySql from "@xonava/adapters/drizzle-mysql"
import * as previousMySql from "xonava-adapters-prev/drizzle-mysql"
import { bootstrapMySqlFixture } from "../../fixtures/mysql/bootstrap.js"
import { mysqlIdempotency, mysqlOutbox } from "../../fixtures/mysql/schema.js"
import { mysqlCertificationUrl } from "../mysql/database.js"
import { defineIdempotencyUpgrade, defineJobUpgrade, defineOutboxUpgrade, defineWorkflowUpgrade, type ReleaseStores, type UpgradeDriver } from "./durableStores.js"
import type { Release } from "./releases.js"

// Own database: other suites use the same server concurrently. The framework tables are the fixture's (every migration applied).
const DATABASE = "framework_upgrade_compat"

type TransactionRunner = { runInTransaction(work: (transaction: never) => Promise<void>): Promise<void> }

const mapRecord = (record: { type: string; version: number; aggregateType: string; aggregateId: string; payload: unknown; occurredAt: Date }) => ({
  eventType: record.type, eventVersion: record.version, aggregateType: record.aggregateType, aggregateId: record.aggregateId, payload: record.payload, occurredAt: record.occurredAt,
})

describe("MySQL N-1 upgrade compatibility", () => {
  let admin: Pool
  let pool: Pool
  const q = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0] as Record<string, unknown>[]

  function storesFor(module: typeof currentMySql | typeof previousMySql): ReleaseStores {
    const db = drizzle(pool)
    const idempotencyStore = module.createDrizzleMySqlIdempotencyStore<unknown>(db as never, mysqlIdempotency as never)
    const provider = module.createDrizzleMySqlPersistenceProvider({ db: db as never, registry: new module.DrizzleMySqlEntityRegistry() as never }) as unknown as TransactionRunner
    return {
      jobs: new module.DrizzleMySqlJobStore(pool, { executionHistory: "best_effort" }) as never,
      workflows: new module.DrizzleMySqlWorkflowStore(pool) as never,
      outbox: new module.DrizzleMySqlOutboxSink(db as never, mysqlOutbox as never, mapRecord as never) as never,
      idempotency: idempotencyStore as never,
      commit: async (item) => { await provider.runInTransaction((transaction) => idempotencyStore.markCommittedInTransaction(item as never, transaction)) },
    }
  }

  const driver: UpgradeDriver = {
    label: "mysql",
    stores: (release: Release) => storesFor(release === "current" ? currentMySql : previousMySql),
    reset: async () => {
      for (const table of ["job_executions", "jobs", "idempotency", "outbox", "workflow_signals", "workflows"]) await pool.query(`DELETE FROM \`${table}\``)
    },
    jobRow: async (jobId) => {
      const [row] = await q("SELECT fingerprint, scope, tenant_id, scope_key FROM jobs WHERE id = ?", [jobId])
      return { fingerprint: (row!.fingerprint ?? null) as string | null, scope: row!.scope as string, tenantId: (row!.tenant_id ?? null) as string | null, scopeKey: (row!.scope_key ?? null) as string | null }
    },
    setJobFingerprint: async (jobId, fingerprint) => { await pool.query("UPDATE jobs SET fingerprint = ? WHERE id = ?", [fingerprint, jobId]) },
    outboxRows: async (scopeId, key) => (await q("SELECT event_fingerprint FROM outbox WHERE idempotency_scope = ? AND idempotency_key = ?", [scopeId, key])).map((row) => ({ fingerprint: row.event_fingerprint as string })),
    setOutboxFingerprint: async (scopeId, key, fingerprint) => { await pool.query("UPDATE outbox SET event_fingerprint = ? WHERE idempotency_scope = ? AND idempotency_key = ?", [fingerprint, scopeId, key]) },
    resumeSignalId: async (instanceId) => ((await q("SELECT resume_signal_id FROM workflows WHERE id = ?", [instanceId]))[0]?.resume_signal_id ?? null) as string | null,
    setResumeSignalId: async (instanceId, value) => { await pool.query("UPDATE workflows SET resume_signal_id = ? WHERE id = ?", [value, instanceId]) },
  }

  beforeAll(async () => {
    admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    pool = mysql.createPool({ uri: mysqlCertificationUrl(), database: DATABASE, connectionLimit: 12 })
    await bootstrapMySqlFixture(pool)
  })
  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin?.end()
  })

  defineJobUpgrade(driver)
  defineWorkflowUpgrade(driver)
  defineOutboxUpgrade(driver)
  defineIdempotencyUpgrade(driver)
})
