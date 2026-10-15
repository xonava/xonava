import { afterAll, beforeAll, describe } from "vitest"
import { DrizzleD1WorkflowStore } from "@xonava/adapters/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { defineStoreContractDifferential, printCoverage, type DbReceipt, type WorkflowStoreDriver } from "../shared/workflowStoreDifferential.js"
import { defineWorkflowConcurrency } from "../shared/workflowStoreDifferentialConcurrency.js"

describe("D1 workflow store differential", () => {
  // Own Miniflare instance (openD1Fixture creates a fresh in-memory database).
  let fixture: D1Fixture
  let main: DrizzleD1WorkflowStore | undefined
  const db = () => fixture.db
  const driver: WorkflowStoreDriver = {
    label: "d1",
    get store() { return (main ??= new DrizzleD1WorkflowStore(db() as never)) },
    openStore: () => new DrizzleD1WorkflowStore(db() as never),
    reset: async () => { await db().prepare("DELETE FROM framework_workflow_signals").run(); await db().prepare("DELETE FROM framework_workflows").run() },
    setLeaseExpiry: async (id, at) => { await db().prepare("UPDATE framework_workflows SET lease_expires_at_ms = ? WHERE id = ? AND lease_owner IS NOT NULL").bind(at.getTime(), id).run() },
    setWakeAt: async (id, at) => { await db().prepare("UPDATE framework_workflows SET wake_at_ms = ? WHERE id = ? AND wake_at_ms IS NOT NULL").bind(at.getTime(), id).run() },
    receipts: async (): Promise<DbReceipt[]> => ((await db().prepare("SELECT id,instance_id,name,seq,consumed_at_ms,consumed_revision FROM framework_workflow_signals ORDER BY seq").all()).results as Record<string, unknown>[]).map((row) => ({
      id: String(row.id), instanceId: String(row.instance_id), name: String(row.name), seq: Number(row.seq), consumed: row.consumed_at_ms != null, consumedRevision: row.consumed_revision == null ? null : Number(row.consumed_revision),
    })),
    // Miniflare costs ~20 ms per statement: short sequences, partial comparison between full ones.
    light: true,
    maxOps: 10,
    lifecycleRuns: 50,
  }

  beforeAll(async () => { fixture = await openD1Fixture() })
  afterAll(async () => { printCoverage("d1"); await fixture?.close() })

  defineStoreContractDifferential(driver)
  defineWorkflowConcurrency(driver)
})
