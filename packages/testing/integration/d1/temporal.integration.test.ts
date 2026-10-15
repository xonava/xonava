import { describe, expect, it } from "vitest"
import { DrizzleD1TemporalHistoryStore } from "@xonava/adapters/drizzle-d1"
import { reconstructAsOf } from "@xonava/core/temporal"
import { temporaryD1Fixture } from "./database.js"

describe("temporal D1 integration", () => {
  it("allocates contiguous revisions concurrently and reconstructs exact boundaries", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      const store = new DrizzleD1TemporalHistoryStore<{ value: number }>(fixture.db as never)
      const base = { scopeId: "tenant-a" as never, entityType: "invoice", entityId: "one" }
      const start = Date.UTC(2026, 0, 1)
      const created = await store.append({ ...base, occurredAt: new Date(start), kind: "created", state: { value: 0 } })
      const appended = await Promise.all(Array.from({ length: 19 }, (_, index) => store.append({ ...base, occurredAt: new Date(start), kind: "updated", state: { value: index + 1 } })))
      expect([created, ...appended].map(item => item.revision).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
      const history = { ...base, entityId: "history" }
      for (let index = 0; index < 20; index += 1) await store.append({ ...history, occurredAt: new Date(start + index), kind: index ? "updated" : "created", state: { value: index } })
      expect(await reconstructAsOf(store, history, new Date(start + 9))).toMatchObject({ revision: 10, state: { value: 9 }, deleted: false })
      await store.saveSnapshot({ ...history, revision: 10, occurredAt: new Date(start + 9), state: { value: 9 } })
      expect(await reconstructAsOf(store, history, new Date(start + 19))).toMatchObject({ revision: 20, state: { value: 19 }, replayedRevisions: 10 })
    } finally { await fixture.close(); await fixture.cleanup() }
  })

  it("preserves deletion, restoration, scope isolation, and pagination", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      const store = new DrizzleD1TemporalHistoryStore<{ value: number }>(fixture.db as never)
      const resource = { scopeId: "tenant-a" as never, entityType: "case", entityId: "one" }
      await store.append({ ...resource, occurredAt: new Date(1), kind: "created", state: { value: 1 } })
      await store.append({ ...resource, occurredAt: new Date(2), kind: "deleted", state: null })
      await store.append({ ...resource, occurredAt: new Date(3), kind: "restored", state: { value: 2 } })
      await store.append({ ...resource, scopeId: "tenant-b" as never, occurredAt: new Date(1), kind: "created", state: { value: 99 } })
      expect(await reconstructAsOf(store, resource, new Date(2))).toMatchObject({ revision: 2, deleted: true })
      expect(await reconstructAsOf(store, resource, new Date(3))).toMatchObject({ revision: 3, state: { value: 2 }, deleted: false })
      expect((await store.revisions(resource, { afterRevision: 0, asOf: new Date(3), limit: 2 }))).toMatchObject({ hasMore: true, items: [{ revision: 1 }, { revision: 2 }] })
    } finally { await fixture.close(); await fixture.cleanup() }
  })

  it("rolls back history when a participant in the atomic batch fails", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      const store = new DrizzleD1TemporalHistoryStore<{ value: number }>(fixture.db as never)
      const revision = { scopeId: "tenant-a" as never, entityType: "case", entityId: "rollback", occurredAt: new Date(1), kind: "created" as const, state: { value: 1 } }
      await expect(store.appendWithStatements(revision, [fixture.db.prepare("INSERT INTO missing_temporal_consumer VALUES (1)") as never])).rejects.toThrow()
      await expect(store.append(revision)).resolves.toMatchObject({ revision: 1 })
    } finally { await fixture.close(); await fixture.cleanup() }
  })
  it("rejects backdated and invalid lifecycle revisions without advancing the head", async () => { const fixture = await temporaryD1Fixture(); try { const store = new DrizzleD1TemporalHistoryStore<{ value: number }>(fixture.db as never); const resource = { scopeId: "tenant" as never, entityType: "case", entityId: "chronology" }; await store.append({ ...resource, occurredAt: new Date(2), kind: "created", state: { value: 1 } }); await expect(store.append({ ...resource, occurredAt: new Date(1), kind: "updated", state: { value: 2 } })).rejects.toThrow(); await expect(store.append({ ...resource, occurredAt: new Date(3), kind: "restored", state: { value: 2 } })).rejects.toThrow(); await expect(store.append({ ...resource, occurredAt: new Date(3), kind: "updated", state: { value: 3 } })).resolves.toMatchObject({ revision: 2 }) } finally { await fixture.close(); await fixture.cleanup() } })
})
