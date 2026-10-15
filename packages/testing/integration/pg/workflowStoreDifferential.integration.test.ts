import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import { DrizzlePgWorkflowStore } from "@xonava/adapters/drizzle-pg"
import { readPostgresMigration } from "../../fixtures/postgres/bootstrap.js"
import { POSTGRES_FIXTURE_MIGRATIONS } from "../../fixtures/postgres/schema.js"
import { pgCertificationUrl } from "./database.js"
import { defineStoreContractDifferential, printCoverage, type DbReceipt, type WorkflowStoreDriver } from "../shared/workflowStoreDifferential.js"
import { defineWorkflowConcurrency } from "../shared/workflowStoreDifferentialConcurrency.js"

// Own schema: other suites use the same server concurrently.
const SCHEMA = "df_workflows"

describe("PostgreSQL workflow store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 12 })
  const driver: WorkflowStoreDriver = {
    label: "postgres",
    store: new DrizzlePgWorkflowStore(pool, { schema: SCHEMA }),
    openStore: () => new DrizzlePgWorkflowStore(pool, { schema: SCHEMA }),
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.workflow_signals, ${SCHEMA}.workflows`) },
    setLeaseExpiry: async (id, at) => { await pool.query(`UPDATE ${SCHEMA}.workflows SET lease_expires_at = $2 WHERE id = $1 AND lease_owner IS NOT NULL`, [id, at]) },
    setWakeAt: async (id, at) => { await pool.query(`UPDATE ${SCHEMA}.workflows SET wake_at = $2 WHERE id = $1 AND wake_at IS NOT NULL`, [id, at]) },
    receipts: async (): Promise<DbReceipt[]> => (await pool.query(`SELECT id,instance_id,name,seq,consumed_at,consumed_revision FROM ${SCHEMA}.workflow_signals ORDER BY seq`)).rows.map((row) => ({
      id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), seq: Number(row.seq), consumed: row.consumed_at != null, consumedRevision: row.consumed_revision == null ? null : Number(row.consumed_revision),
    })),
  }

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    for (const name of POSTGRES_FIXTURE_MIGRATIONS) await pool.query(await readPostgresMigration(name, SCHEMA))
  })
  afterAll(async () => { printCoverage("postgres"); await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineStoreContractDifferential(driver)
  defineWorkflowConcurrency(driver)
})
