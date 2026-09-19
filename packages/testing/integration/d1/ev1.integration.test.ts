import { describe, expect, it } from "vitest"
import type { InboxKey, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord } from "core/events"
import { D1AtomicRecordBackend, DrizzleD1InboxStore, createDrizzleD1OutboxStore } from "adapters/drizzle-d1"
import { temporaryD1Fixture } from "./database.js"

const scopeId = "tenant:t1" as never
const provenance = { format: "framework.authority-provenance", formatVersion: 1 } as never
const key: InboxKey = { consumerKey: "ledger", messageId: "ev1-d1", scopeId }
const record: InboxRecord = { ...key, consumerDefinitionVersion: 1, state: "pending", attempt: 0, replayGeneration: 0, claim: null, firstObservedAt: "", lastObservedAt: "", eventFormatVersion: 1, eventPayloadVersion: 1, originalProvenance: provenance, replay: { kind: "original-delivery" }, history: [] }

describe("EV1 D1 live atomic inbox", () => {
  it("uses a guarded atomic batch so failed business mutation cannot acknowledge", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      const database = fixture.db as never
      const backend = new D1AtomicRecordBackend<InboxKey, InboxRecord>({ database, table: "framework_inbox_records", encodeKey: value => `${value.scopeId}:${value.consumerKey}:${value.messageId}` })
      const store = new DrizzleD1InboxStore(backend)
      await store.observe(record)
      const claim = await store.claim(key, "worker", 60_000)
      await expect(store.acknowledgeBatch(key, claim!.claim!.token, [fixture.db.prepare("UPDATE framework_ev1_business_effects SET value = 'x' WHERE id = 'missing'") as never], "bad")).rejects.toThrow()
      expect((await store.get(key))!.state).toBe("claimed")
      await store.acknowledgeBatch(key, claim!.claim!.token, [fixture.db.prepare("INSERT INTO framework_ev1_business_effects (id,value) VALUES ('commit','ok')") as never], "ok")
      expect((await store.get(key))!.state).toBe("processed")
      expect(await fixture.db.prepare("SELECT value FROM framework_ev1_business_effects WHERE id = 'commit'").first()).toEqual({ value: "ok" })
    } finally { await fixture.close(); await fixture.cleanup() }
  })
  it("recovers expired claims and persists fenced outbox publication using D1 backend time", async () => {
    const fixture = await temporaryD1Fixture()
    try {
      const database = fixture.db as never
      const inboxBackend = new D1AtomicRecordBackend<InboxKey, InboxRecord>({ database, table: "framework_inbox_records", encodeKey: value => `${value.scopeId}:${value.consumerKey}:${value.messageId}` })
      const store = new DrizzleD1InboxStore(inboxBackend)
      const takeoverKey = { ...key, messageId: "ev1-d1-takeover" }
      await store.observe({ ...record, ...takeoverKey })
      const first = await store.claim(takeoverKey, "first", 1)
      await new Promise(resolve => setTimeout(resolve, 5))
      const second = await store.claim(takeoverKey, "second", 60_000)
      expect(second!.claim!.token).not.toBe(first!.claim!.token)
      await expect(store.renew(takeoverKey, first!.claim!.token, 1000)).rejects.toMatchObject({ code: "STALE_CLAIM" })
      const outboxBackend = new D1AtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>({ database, table: "framework_outbox_delivery_records", encodeKey: value => `${value.scopeId}:${value.messageId}` })
      const outbox = createDrizzleD1OutboxStore(outboxBackend)
      const delivery: OutboxDeliveryRecord = { envelope: { messageId: "out-d1" } as never, scopeId, idempotencyKey: "out-d1", state: "pending", attempt: 0, claim: null }
      await outbox.append(delivery)
      const outClaim = await outbox.claim({ messageId: "out-d1", scopeId }, "publisher", 60_000)
      await outbox.markPublished({ messageId: "out-d1", scopeId }, outClaim!.claim!.token)
      expect((await outbox.get({ messageId: "out-d1", scopeId }))!.state).toBe("published")
    } finally { await fixture.close(); await fixture.cleanup() }
  })
})
