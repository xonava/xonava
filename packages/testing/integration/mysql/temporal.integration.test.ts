import { describe, expect, it } from "vitest"
import { DrizzleMySqlTemporalHistoryStore } from "@xonava/adapters/drizzle-mysql"
import { reconstructAsOf } from "@xonava/core/temporal"
import { openMySqlFixture } from "./database.js"

describe("temporal MySQL integration", () => {
  it("allocates a gap-free stream under concurrent pooled transactions", async () => {
    const { pool } = await openMySqlFixture()
    try {
      const store = new DrizzleMySqlTemporalHistoryStore<{ value: number }>(pool)
      const resource = { scopeId: "tenant-a" as never, entityType: "invoice", entityId: "mysql-race" }
      const created = await store.append({ ...resource, occurredAt: new Date(1_000), kind: "created", state: { value: 0 } })
      const revisions = await Promise.all(Array.from({ length: 19 }, (_, value) => store.append({ ...resource, occurredAt: new Date(1_000), kind: "updated", state: { value: value + 1 } })))
      expect([created, ...revisions].map(x => x.revision).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
      expect(await reconstructAsOf(store, resource, new Date(1_000))).toMatchObject({ revision: 20 })
    } finally { await pool.end() }
  })
  it("rolls back head and history in a caller transaction", async () => {
    const { pool } = await openMySqlFixture(); const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await new DrizzleMySqlTemporalHistoryStore<{ value: number }>(connection).append({ scopeId: "tenant-a" as never, entityType: "invoice", entityId: "mysql-rollback", occurredAt: new Date(), kind: "created", state: { value: 1 } })
      await connection.rollback()
      const [rows] = await pool.query("SELECT COUNT(*) AS count FROM temporal_revisions WHERE entity_id='mysql-rollback'")
      expect(Number((rows as { count: number }[])[0]?.count)).toBe(0)
    } finally { connection.release(); await pool.end() }
  })
  it("rejects backdated and invalid lifecycle revisions without advancing the head", async () => { const { pool } = await openMySqlFixture(); try { const store = new DrizzleMySqlTemporalHistoryStore<{ value: number }>(pool); const resource = { scopeId: "tenant-a" as never, entityType: "invoice", entityId: "mysql-chronology" }; await store.append({ ...resource, occurredAt: new Date(2_000), kind: "created", state: { value: 1 } }); await expect(store.append({ ...resource, occurredAt: new Date(1_000), kind: "updated", state: { value: 2 } })).rejects.toThrow(); await expect(store.append({ ...resource, occurredAt: new Date(3_000), kind: "restored", state: { value: 2 } })).rejects.toThrow(); await expect(store.append({ ...resource, occurredAt: new Date(3_000), kind: "updated", state: { value: 3 } })).resolves.toMatchObject({ revision: 2 }) } finally { await pool.end() } })
})
