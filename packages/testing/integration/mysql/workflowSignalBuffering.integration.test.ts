import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DrizzleMySqlWorkflowStore } from "adapters/drizzle-mysql"
import { applyMySqlSignalBufferingMigration, readMySqlMigrationStatements } from "../../fixtures/mysql/bootstrap.js"
import { mysqlCertificationUrl, openMySqlFixture } from "./database.js"
import { registerWorkflowSignalBufferingTests, type DbReceipt, type SignalBufferingHarness } from "../shared/workflowSignalBuffering.js"

const toReceipts = (rows: RowDataPacket[]): DbReceipt[] => rows.map((row) => ({ id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), seq: Number(row.seq), consumed: row.consumed_at != null, consumedRevision: row.consumed_revision == null ? null : Number(row.consumed_revision) }))
const scope = { kind: "tenant", tenantId: "t1" } as const

describe("MySQL buffered workflow signals", () => {
  let pool: Pool
  let harness: SignalBufferingHarness
  beforeAll(async () => {
    pool = (await openMySqlFixture()).pool
    harness = {
      store: new DrizzleMySqlWorkflowStore(pool),
      receipts: async (ids) => toReceipts((await pool.query<RowDataPacket[]>("SELECT id,instance_id,name,seq,consumed_at,consumed_revision FROM workflow_signals WHERE instance_id IN (?) ORDER BY seq", [ids]))[0]),
    }
  })
  afterAll(() => pool.end())

  registerWorkflowSignalBufferingTests(() => harness, `sbmy${Date.now()}`)

  it("migration 0002 marks receipts stored before it as consumed, in delivery order, and leaves later receipts pending", async () => {
    const database = `framework_df_signals_${process.pid}`
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    let scratch: Pool | undefined
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``)
      await admin.query(`CREATE DATABASE \`${database}\``)
      scratch = mysql.createPool({ uri: mysqlCertificationUrl(), database, connectionLimit: 4 })
      for (const statement of await readMySqlMigrationStatements("0001_framework.sql")) await scratch.query(statement)
      await scratch.query(`INSERT INTO workflows (id,workflow_type,workflow_version,execution_scope,status,current_step,variables,compensation_stack,waiting_signal) VALUES ('legacy','t',1,'{"kind":"tenant","tenantId":"t1"}','waiting','approve','{}','[]','go')`)
      // Inserted out of delivery order on purpose: the backfilled seq follows delivered_at, not the primary key.
      await scratch.query(`INSERT INTO workflow_signals (id,instance_id,name,payload,delivered_at) VALUES ('z-first','legacy','go','{"n":1}','2026-01-01 00:00:01.000'),('a-second','legacy','go','{"n":2}','2026-01-01 00:00:02.000'),('m-third','legacy','other','{"n":3}','2026-01-01 00:00:03.000')`)
      expect(await applyMySqlSignalBufferingMigration(scratch)).toBe(true)
      const [migrated] = await scratch.query<RowDataPacket[]>("SELECT id,seq,consumed_at,delivered_at,consumed_revision FROM workflow_signals ORDER BY seq")
      expect(migrated.map((row) => row.id)).toEqual(["z-first", "a-second", "m-third"])
      for (const row of migrated) { expect(row.consumed_at).toEqual(row.delivered_at); expect(row.consumed_revision).toBeNull() }
      // The bootstrap guard keeps a second application from touching pending receipts.
      const store = new DrizzleMySqlWorkflowStore(scratch)
      await store.start({ id: "fresh", workflowType: "t", workflowVersion: 1, executionScope: scope, initialStep: "approve", variables: {} })
      await store.deliverSignal({ id: "new-early", instanceId: "fresh", name: "go", payload: {} })
      expect(await applyMySqlSignalBufferingMigration(scratch)).toBe(false)
      const [rerun] = await scratch.query<RowDataPacket[]>("SELECT id,seq,consumed_at FROM workflow_signals ORDER BY seq")
      expect(rerun.map((row) => [row.id, row.consumed_at != null])).toEqual([["z-first", true], ["a-second", true], ["m-third", true], ["new-early", false]])
      expect(Number(rerun[3]!.seq)).toBeGreaterThan(Number(rerun[2]!.seq))
      expect(await store.getSignal("legacy", "go")).toMatchObject({ id: "a-second", payload: { n: 2 } })
      expect(await store.getSignalById("legacy", "z-first")).toMatchObject({ payload: { n: 1 } })
      // Only the fresh instance is claimable work; the legacy one stays parked and the legacy receipts feed no wait.
      const [claim] = await store.claimDue({ workerId: "w", limit: 10, leaseDurationMs: 60_000 })
      expect(claim!.instance.id).toBe("fresh")
    } finally {
      await scratch?.end()
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => undefined)
      await admin.end()
    }
  })
})
