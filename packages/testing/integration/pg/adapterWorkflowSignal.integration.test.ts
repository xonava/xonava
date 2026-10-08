import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DrizzlePgWorkflowStore } from "adapters/drizzle-pg"
import { openPgFixture, pgCertificationUrl } from "./database.js"

describe("PostgreSQL workflow signal delivery to a missing instance", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl() })
  beforeAll(async () => { const fixture = await openPgFixture(); await fixture.end() })
  afterAll(() => pool.end())

  it("returns delivered:false instead of throwing a raw foreign-key error", async () => {
    const store = new DrizzlePgWorkflowStore(pool, { schema: "framework_test" })
    await expect(store.deliverSignal({ id: "sig-missing", instanceId: "wf-does-not-exist", name: "approve", payload: {} })).resolves.toEqual({ delivered: false, duplicate: false })
    expect((await pool.query("SELECT 1 FROM framework_test.workflow_signals WHERE id='sig-missing'")).rowCount).toBe(0)
  })

  it("still delivers and deduplicates for an existing instance", async () => {
    const store = new DrizzlePgWorkflowStore(pool, { schema: "framework_test" })
    await store.start({ id: "wf-signal-exists", workflowType: "order", workflowVersion: 1, executionScope: { kind: "system", systemKey: "framework" }, initialStep: "s", variables: {} })
    await expect(store.deliverSignal({ id: "sig-exists", instanceId: "wf-signal-exists", name: "approve", payload: {} })).resolves.toEqual({ delivered: true, duplicate: false })
    await expect(store.deliverSignal({ id: "sig-exists", instanceId: "wf-signal-exists", name: "approve", payload: {} })).resolves.toEqual({ delivered: false, duplicate: true })
  })

  it("normalizes other provider failures without leaking SQL", async () => {
    const store = new DrizzlePgWorkflowStore(pool, { schema: "framework_test" })
    await store.start({ id: "wf-signal-bad", workflowType: "order", workflowVersion: 1, executionScope: { kind: "system", systemKey: "framework" }, initialStep: "s", variables: {} })
    const failure = await store.deliverSignal({ id: "sig-bad", instanceId: "wf-signal-bad", name: null as never, payload: {} }).then(() => null, (error: unknown) => error)
    expect(failure).toMatchObject({ code: "VALIDATION_ERROR" })
    expect(String((failure as Error).message)).not.toMatch(/workflow_signals|insert/i)
  })
})
