import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe } from "vitest"
import { DrizzleMySqlWorkflowStore } from "@xonava/adapters/drizzle-mysql"
import { bootstrapMySqlFixture } from "../../fixtures/mysql/bootstrap.js"
import { mysqlCertificationUrl } from "./database.js"
import { defineStoreContractDifferential, printCoverage, type DbReceipt, type WorkflowStoreDriver } from "../shared/workflowStoreDifferential.js"
import { defineWorkflowConcurrency } from "../shared/workflowStoreDifferentialConcurrency.js"

// Own database: other suites use the same server concurrently.
const DATABASE = "framework_df_workflows"

describe("MySQL workflow store differential", () => {
  let admin: Pool
  let pool: Pool
  const driver: WorkflowStoreDriver = {
    label: "mysql",
    maxOps: 28,
    get store() { return stores[0]! },
    openStore: () => new DrizzleMySqlWorkflowStore(pool),
    reset: async () => { await pool.query("DELETE FROM workflow_signals"); await pool.query("DELETE FROM workflows") },
    setLeaseExpiry: async (id, at) => { await pool.query("UPDATE workflows SET lease_expires_at = ? WHERE id = ? AND lease_owner IS NOT NULL", [at, id]) },
    setWakeAt: async (id, at) => { await pool.query("UPDATE workflows SET wake_at = ? WHERE id = ? AND wake_at IS NOT NULL", [at, id]) },
    receipts: async (): Promise<DbReceipt[]> => (await pool.query<RowDataPacket[]>("SELECT id,instance_id,name,seq,consumed_at,consumed_revision FROM workflow_signals ORDER BY seq"))[0].map((row) => ({
      id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), seq: Number(row.seq), consumed: row.consumed_at != null, consumedRevision: row.consumed_revision == null ? null : Number(row.consumed_revision),
    })),
  }
  const stores: DrizzleMySqlWorkflowStore[] = []

  beforeAll(async () => {
    admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    pool = mysql.createPool({ uri: mysqlCertificationUrl(), database: DATABASE, connectionLimit: 12 })
    await bootstrapMySqlFixture(pool)
    stores.push(new DrizzleMySqlWorkflowStore(pool))
  })
  afterAll(async () => {
    printCoverage("mysql")
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin?.end()
  })

  defineStoreContractDifferential(driver)
  defineWorkflowConcurrency(driver)
})
