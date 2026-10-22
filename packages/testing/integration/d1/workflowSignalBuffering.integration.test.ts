import { Miniflare } from "miniflare"
import { ASYNC_D1_WORKER_SCRIPT, asyncD1Binding } from "./asyncD1.js"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DrizzleD1WorkflowStore } from "@xonava/adapters/drizzle-d1"
import { applyD1Migration, readD1Migration, d1MigrationStatements } from "../../fixtures/d1/bootstrap.js"
import { temporaryD1Fixture, type D1Fixture } from "./database.js"
import { tolerateStaleConnections } from "./staleConnection.js"
import { applyWorkflowStep } from "@xonava/core/workflow"
import { claim, ledgerViolations, registerWorkflowSignalBufferingTests, startInstance, type DbReceipt, type SignalBufferingHarness } from "../shared/workflowSignalBuffering.js"

const scope = { kind: "tenant", tenantId: "t1" } as const

describe("D1 buffered workflow signals", () => {
  let fixture: (D1Fixture & { cleanup(): Promise<void> }) | undefined
  let harness: SignalBufferingHarness
  beforeAll(async () => {
    fixture = await temporaryD1Fixture()
    const db = fixture.db
    harness = {
      store: new DrizzleD1WorkflowStore(db as never),
      // D1 serializes writes, so more iterations only add Miniflare round trips (each store call is a synchronous worker-thread fetch).
      raceRuns: 30,
      expireLease: async (id) => { await db.prepare("UPDATE framework_workflows SET lease_expires_at_ms = 0 WHERE id = ?").bind(id).run() },
      receipts: async (ids) => {
        const rows = await db.prepare(`SELECT id,instance_id,name,seq,consumed_at_ms,consumed_revision FROM framework_workflow_signals WHERE instance_id IN (${ids.map(() => "?").join(",")}) ORDER BY seq`).bind(...ids).all()
        return (rows.results as Record<string, unknown>[]).map((row): DbReceipt => ({ id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), seq: Number(row.seq), consumed: row.consumed_at_ms != null, consumedRevision: row.consumed_revision == null ? null : Number(row.consumed_revision) }))
      },
    }
  })
  afterAll(async () => { await fixture?.close(); await fixture?.cleanup() })

  registerWorkflowSignalBufferingTests(() => harness, `sbd1${Date.now()}`)

  it("a lease that lapses between the consume and the update of a wait's commit consumes nothing (the receipt is not orphaned)", async () => {
    // SQLite reads 'now' once per statement, so the fence can pass for the consume and fail for the update inside one batch.
    // A trigger that expires the lease as the receipt is consumed reproduces that interleaving deterministically.
    const db = fixture!.db
    const store = new DrizzleD1WorkflowStore(db as never)
    const id = `sbd1-lapse-${Date.now()}`
    await startInstance(store, id)
    const { claim: running, fence } = await claim(store, id)
    expect(await store.deliverSignal({ id: `${id}-sig`, instanceId: id, name: "go", payload: { n: 1 } })).toEqual({ delivered: true, duplicate: false })
    await db.exec("CREATE TRIGGER sb_lease_lapses AFTER UPDATE OF consumed_at_ms ON framework_workflow_signals WHEN NEW.consumed_at_ms IS NOT NULL BEGIN UPDATE framework_workflows SET lease_expires_at_ms = 0 WHERE id = NEW.instance_id; END")
    try {
      expect(await store.commit(fence, applyWorkflowStep(running.instance, { kind: "wait", signal: "go" }, new Date()))).toBe(false)
    } finally { await db.exec("DROP TRIGGER sb_lease_lapses") }
    const rejected = await store.get(id)
    expect(rejected).toMatchObject({ status: "pending", revision: fence.revision, leaseOwner: "signals", resumeSignalId: null })
    expect(await harness.receipts([id])).toMatchObject([{ id: `${id}-sig`, consumed: false, consumedRevision: null }])
    // Once the wait has completed, a repeated commit with the old fence is rejected and must not un-consume the receipt the completed transition consumed.
    const next = await claim(store, id, "signals-2")
    expect(await store.commit(next.fence, applyWorkflowStep(next.claim.instance, { kind: "wait", signal: "go" }, new Date()))).toBe(true)
    expect(await store.get(id)).toMatchObject({ status: "pending", resumeSignalId: `${id}-sig`, revision: next.fence.revision + 1 })
    expect(await store.commit(next.fence, applyWorkflowStep(next.claim.instance, { kind: "wait", signal: "go" }, new Date()))).toBe(false)
    expect(await harness.receipts([id])).toMatchObject([{ id: `${id}-sig`, consumed: true, consumedRevision: next.fence.revision + 1 }])
    expect(await ledgerViolations(harness, [id])).toEqual([])
  })

  it("migration 0002 marks receipts stored before it as consumed, in delivery order, and leaves later receipts pending", async () => {
    const mf = new Miniflare({ modules: true, script: ASYNC_D1_WORKER_SCRIPT, compatibilityDate: "2025-09-01", d1Databases: { DB: "signal-backfill" } })
    try {
      const db = tolerateStaleConnections(asyncD1Binding(mf))
      await db.exec(await readD1Migration("0001_framework.sql"))
      await db.exec(`INSERT INTO framework_workflows (id,workflow_type,workflow_version,execution_scope,status,current_step,variables,waiting_signal,created_at_ms,updated_at_ms) VALUES ('legacy','t',1,'{"kind":"tenant","tenantId":"t1"}','waiting','approve','{}','go',1,1)`)
      // Inserted out of delivery order on purpose: the backfilled seq follows delivered_at_ms, not the rowid.
      await db.exec(`INSERT INTO framework_workflow_signals (id,instance_id,name,payload,delivered_at_ms) VALUES ('z-first','legacy','go','{"n":2}',2000)`)
      await db.exec(`INSERT INTO framework_workflow_signals (id,instance_id,name,payload,delivered_at_ms) VALUES ('a-second','legacy','go','{"n":1}',1000)`)
      await db.exec(`INSERT INTO framework_workflow_signals (id,instance_id,name,payload,delivered_at_ms) VALUES ('m-third','legacy','other','{"n":3}',3000)`)
      expect(await applyD1Migration(db, "0002_workflow_signal_buffering.sql")).toBe(true)
      const migrated = (await db.prepare("SELECT id,seq,consumed_at_ms,delivered_at_ms,consumed_revision FROM framework_workflow_signals ORDER BY seq").all()).results as Record<string, unknown>[]
      expect(migrated.map((row) => row.id)).toEqual(["a-second", "z-first", "m-third"])
      for (const row of migrated) { expect(row.consumed_at_ms).toBe(row.delivered_at_ms); expect(row.consumed_revision).toBeNull() }
      // A second application is detected and skipped, so it cannot swallow pending receipts.
      const store = new DrizzleD1WorkflowStore(db as never)
      await store.start({ id: "fresh", workflowType: "t", workflowVersion: 1, executionScope: scope, initialStep: "approve", variables: {} })
      await store.deliverSignal({ id: "new-early", instanceId: "fresh", name: "go", payload: {} })
      expect(await applyD1Migration(db, "0002_workflow_signal_buffering.sql")).toBe(false)
      const rerun = (await db.prepare("SELECT id,seq,consumed_at_ms FROM framework_workflow_signals ORDER BY seq").all()).results as Record<string, unknown>[]
      expect(rerun.map((row) => [row.id, row.consumed_at_ms != null])).toEqual([["a-second", true], ["z-first", true], ["m-third", true], ["new-early", false]])
      expect(Number(rerun[3]!.seq)).toBeGreaterThan(Number(rerun[2]!.seq))
      expect(await store.getSignal("legacy", "go")).toMatchObject({ id: "z-first", payload: { n: 2 } })
      expect(await store.getSignalById("legacy", "a-second")).toMatchObject({ payload: { n: 1 } })
      // Legacy receipts feed no wait: the fresh instance (not the parked legacy one) is the claimable work.
      const [claim] = await store.claimDue({ workerId: "w", limit: 10, leaseDurationMs: 60_000 })
      expect(claim!.instance.id).toBe("fresh")
    } finally { await mf.dispose() }
  })

  it("applies the migration file as one statement per line", async () => {
    const statements = d1MigrationStatements(await readD1Migration("0002_workflow_signal_buffering.sql"))
    expect(statements.length).toBeGreaterThan(5)
    for (const statement of statements) expect(statement.endsWith(";")).toBe(true)
  })
})
