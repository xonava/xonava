import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DrizzlePgWorkflowStore } from "adapters/drizzle-pg"
import { bootstrapPostgresFixture, readPostgresMigration } from "../../fixtures/postgres/bootstrap.js"
import { openPgFixture, pgCertificationUrl } from "./database.js"
import { registerWorkflowSignalBufferingTests, type DbReceipt, type SignalBufferingHarness } from "../shared/workflowSignalBuffering.js"

const toReceipts = (rows: Record<string, unknown>[]): DbReceipt[] => rows.map((row) => ({ id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), seq: Number(row.seq), consumed: row.consumed_at != null, consumedRevision: row.consumed_revision == null ? null : Number(row.consumed_revision) }))

describe("PostgreSQL buffered workflow signals", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 8 })
  const harness: SignalBufferingHarness = {
    store: new DrizzlePgWorkflowStore(pool, { schema: "framework_test" }),
    expireLease: async (id) => { await pool.query("UPDATE framework_test.workflows SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [id]) },
    receipts: async (ids) => toReceipts((await pool.query("SELECT id,instance_id,name,seq,consumed_at,consumed_revision FROM framework_test.workflow_signals WHERE instance_id = ANY($1) ORDER BY seq", [ids])).rows),
  }
  beforeAll(async () => { const fixture = await openPgFixture(); await fixture.end() })
  afterAll(() => pool.end())

  registerWorkflowSignalBufferingTests(() => harness, `sbpg${Date.now()}`)

  it("migration 0002 marks receipts stored before it as consumed, in delivery order, and leaves later receipts pending", async () => {
    const schema = `df_signal_backfill_${process.pid}`
    const admin = new pg.Client({ connectionString: pgCertificationUrl() })
    const cleanup: Array<() => Promise<void>> = []
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await admin.query(await readPostgresMigration("0001_framework.sql", schema))
      await admin.query(`INSERT INTO ${schema}.workflows (id,workflow_type,workflow_version,execution_scope,status,current_step,variables,waiting_signal) VALUES ('legacy','t',1,'{"kind":"tenant","tenantId":"t1"}','waiting','approve','{}','go')`)
      // Inserted out of delivery order on purpose: the backfilled seq follows delivered_at, not the primary key.
      await admin.query(`INSERT INTO ${schema}.workflow_signals (id,instance_id,name,payload,delivered_at) VALUES ('z-first','legacy','go','{"n":1}','2026-01-01T00:00:01Z'),('a-second','legacy','go','{"n":2}','2026-01-01T00:00:02Z'),('m-third','legacy','other','{"n":3}','2026-01-01T00:00:03Z')`)
      await admin.query(await readPostgresMigration("0002_workflow_signal_buffering.sql", schema))
      const migrated = await admin.query(`SELECT id,seq,consumed_at,delivered_at,consumed_revision FROM ${schema}.workflow_signals ORDER BY seq`)
      expect(migrated.rows.map((row) => row.id)).toEqual(["z-first", "a-second", "m-third"])
      for (const row of migrated.rows) { expect(row.consumed_at).toEqual(row.delivered_at); expect(row.consumed_revision).toBeNull() }
      // Re-running the migration changes nothing (it is guarded), so a later pending receipt is not swallowed by a re-run.
      const scratch = new pg.Pool({ connectionString: pgCertificationUrl(), max: 2 })
      cleanup.push(() => scratch.end())
      const store = new DrizzlePgWorkflowStore(scratch, { schema })
      await store.start({ id: "fresh", workflowType: "t", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, initialStep: "approve", variables: {} })
      await store.deliverSignal({ id: "new-early", instanceId: "fresh", name: "go", payload: {} })
      await admin.query(await readPostgresMigration("0002_workflow_signal_buffering.sql", schema))
      const rerun = await admin.query(`SELECT id,seq,consumed_at FROM ${schema}.workflow_signals ORDER BY seq`)
      expect(rerun.rows.map((row) => [row.id, row.consumed_at != null])).toEqual([["z-first", true], ["a-second", true], ["m-third", true], ["new-early", false]])
      expect(Number(rerun.rows[3]!.seq)).toBeGreaterThan(Number(rerun.rows[2]!.seq))
      // Legacy receipts never wake or feed a new wait; the legacy-by-name lookup still sees the latest one.
      expect(await store.getSignal("legacy", "go")).toMatchObject({ id: "a-second", payload: { n: 2 } })
      expect(await store.getSignalById("legacy", "z-first")).toMatchObject({ payload: { n: 1 } })
      const [claim] = await store.claimDue({ workerId: "w", limit: 10, leaseDurationMs: 60_000 })
      expect(claim!.instance.id).toBe("fresh")
    } finally {
      for (const close of cleanup) await close()
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
      await admin.end()
    }
  })

  it("bootstrapping the shared fixture again keeps pending receipts pending", async () => {
    const id = `sbpg-boot-${Date.now()}`
    await harness.store.start({ id, workflowType: "t", workflowVersion: 1, executionScope: { kind: "tenant", tenantId: "t1" }, initialStep: "approve", variables: {} })
    await harness.store.deliverSignal({ id: `${id}-sig`, instanceId: id, name: "go", payload: {} })
    const client = new pg.Client({ connectionString: pgCertificationUrl() })
    await client.connect()
    try { await bootstrapPostgresFixture(client) } finally { await client.end() }
    expect((await harness.receipts([id]))[0]).toMatchObject({ consumed: false })
  })
})
