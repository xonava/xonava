import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DrizzlePgTemporalHistoryStore } from "@xonava/adapters/drizzle-pg"
import { reconstructAsOf } from "@xonava/core/temporal"
import { openPgFixture, pgCertificationUrl } from "./database.js"

describe("temporal PostgreSQL integration", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 24 })
  beforeAll(async () => { const fixture = await openPgFixture(); await fixture.end() })
  afterAll(() => pool.end())
  it("allocates a gap-free stream under concurrent connections", async () => {
    const store = new DrizzlePgTemporalHistoryStore<{ value: number }>(pool, "framework_test")
    const resource = { scopeId: "tenant-a" as never, entityType: "invoice", entityId: "pg-race" }
    const created = await store.append({ ...resource, occurredAt: new Date(1_000), kind: "created", state: { value: 0 } })
    const revisions = await Promise.all(Array.from({ length: 19 }, (_, value) => store.append({ ...resource, occurredAt: new Date(1_000), kind: "updated", state: { value: value + 1 } })))
    expect([created, ...revisions].map(x => x.revision).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(await reconstructAsOf(store, resource, new Date(1_000))).toMatchObject({ revision: 20 })
  })
  it("participates in a caller transaction and rolls back head and history", async () => {
    const client = await pool.connect()
    const resource = { scopeId: "tenant-a" as never, entityType: "invoice", entityId: "pg-rollback" }
    try { await client.query("BEGIN"); await new DrizzlePgTemporalHistoryStore<{ value: number }>(client, "framework_test").append({ ...resource, occurredAt: new Date(), kind: "created", state: { value: 1 } }); await client.query("ROLLBACK") } finally { client.release() }
    expect((await pool.query("SELECT count(*)::int AS count FROM framework_test.temporal_revisions WHERE entity_id=$1", [resource.entityId])).rows[0]?.count).toBe(0)
    expect((await pool.query("SELECT count(*)::int AS count FROM framework_test.temporal_heads WHERE entity_id=$1", [resource.entityId])).rows[0]?.count).toBe(0)
  })
  it("rejects backdated and invalid lifecycle revisions without advancing the head", async () => { const store = new DrizzlePgTemporalHistoryStore<{ value: number }>(pool, "framework_test"); const resource = { scopeId: "tenant-a" as never, entityType: "invoice", entityId: "pg-chronology" }; await store.append({ ...resource, occurredAt: new Date(2_000), kind: "created", state: { value: 1 } }); await expect(store.append({ ...resource, occurredAt: new Date(1_000), kind: "updated", state: { value: 2 } })).rejects.toThrow(); await expect(store.append({ ...resource, occurredAt: new Date(3_000), kind: "restored", state: { value: 2 } })).rejects.toThrow(); await expect(store.append({ ...resource, occurredAt: new Date(3_000), kind: "updated", state: { value: 3 } })).resolves.toMatchObject({ revision: 2 }) })
})
