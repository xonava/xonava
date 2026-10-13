import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DrizzlePgTemporalHistoryStore, DrizzlePgWorkflowStore } from "adapters/drizzle-pg"
import { scheduleWorkflowRetry } from "core/workflow"
import { readPostgresMigration } from "../../fixtures/postgres/bootstrap.js"
import { pgCertificationUrl } from "./database.js"

/**
 * node-postgres returns timestamptz columns as Date objects; the stores must keep their millisecond precision when decoding
 * (String(date) is a locale string without milliseconds). Own schema, so no other suite shares the rows.
 */
const SCHEMA = `df_tsprec_${process.pid}`
const scope = { kind: "tenant", tenantId: "t1" } as const

describe("PostgreSQL timestamp precision", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 4 })
  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.query(await readPostgresMigration("0001_framework.sql", SCHEMA))
    await pool.query(await readPostgresMigration("0002_workflow_signal_buffering.sql", SCHEMA))
  })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined); await pool.end() })

  it("workflow instances and signal receipts keep the milliseconds of every timestamp column", async () => {
    const store = new DrizzlePgWorkflowStore(pool, { schema: SCHEMA })
    const id = "ts-wf"
    await store.start({ id, workflowType: "t", workflowVersion: 1, executionScope: scope, initialStep: "a", variables: {} })
    const [claim] = await store.claimDue({ workerId: "w", limit: 1, leaseDurationMs: 60_000 })
    const fence = { instanceId: id, workerId: "w", claimToken: claim!.claimToken, revision: claim!.instance.revision }
    // A lease expiry, created_at and updated_at written by the database with sub-second parts; the raw rows are the oracle.
    const raw = (await pool.query(`SELECT wake_at, lease_expires_at, created_at, updated_at FROM ${SCHEMA}.workflows WHERE id = $1`, [id])).rows[0]
    const running = await store.get(id)
    expect(running!.leaseExpiresAt!.getTime()).toBe((raw.lease_expires_at as Date).getTime())
    expect(running!.createdAt.getTime()).toBe((raw.created_at as Date).getTime())
    expect(running!.updatedAt.getTime()).toBe((raw.updated_at as Date).getTime())
    expect(running!.createdAt.getTime() % 1000, "the database timestamp has a millisecond part (flake guard)").not.toBe(0)

    const wakeAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_123)
    expect(await store.commit(fence, scheduleWorkflowRetry(claim!.instance, wakeAt, new Date()))).toBe(true)
    expect((await store.get(id))!.wakeAt!.getTime()).toBe(wakeAt.getTime())

    await store.deliverSignal({ id: "ts-sig", instanceId: id, name: "go", payload: {} })
    const stored = (await pool.query(`SELECT delivered_at FROM ${SCHEMA}.workflow_signals WHERE id = 'ts-sig'`)).rows[0].delivered_at as Date
    expect(stored.getTime() % 1000, "the delivery timestamp has a millisecond part (flake guard)").not.toBe(0)
    expect((await store.getSignalById!(id, "ts-sig"))!.deliveredAt.getTime()).toBe(stored.getTime())
    expect((await store.getSignal(id, "go"))!.deliveredAt.getTime()).toBe(stored.getTime())
  })

  it("temporal revisions keep the milliseconds of occurred_at", async () => {
    const store = new DrizzlePgTemporalHistoryStore<{ value: number }>(pool, SCHEMA)
    const resource = { scopeId: "tenant-a" as never, entityType: "invoice", entityId: "ts-temporal" }
    const occurredAt = new Date(1_700_000_000_123)
    const created = await store.append({ ...resource, occurredAt, kind: "created", state: { value: 1 } })
    expect(created.occurredAt.getTime()).toBe(occurredAt.getTime())
    const page = await store.revisions(resource, { afterRevision: 0, asOf: new Date(1_800_000_000_000), limit: 10 })
    expect(page.items.map((revision) => revision.occurredAt.getTime())).toEqual([occurredAt.getTime()])
  })
})
