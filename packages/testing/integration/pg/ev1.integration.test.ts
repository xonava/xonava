import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { InboxKey, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord } from "@xonava/core/events"
import { PgAtomicRecordBackend, createDrizzlePgInboxStore, createDrizzlePgOutboxStore } from "@xonava/adapters/drizzle-pg"
import { openPgFixture, pgCertificationUrl } from "./database.js"

const scopeId = "tenant:t1" as never
const provenance = { format: "framework.authority-provenance", formatVersion: 1 } as never
const key: InboxKey = { consumerKey: "ledger", messageId: "ev1-pg", scopeId }
const record: InboxRecord = { ...key, consumerDefinitionVersion: 1, state: "pending", attempt: 0, replayGeneration: 0, claim: null, firstObservedAt: "", lastObservedAt: "", eventFormatVersion: 1, eventPayloadVersion: 1, originalProvenance: provenance, replay: { kind: "original-delivery" }, history: [] }

describe("EV1 PostgreSQL live atomic inbox", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl() })
  beforeAll(async () => { const fixture = await openPgFixture(); await fixture.end(); await pool.query("TRUNCATE framework_test.inbox_records, framework_test.ev1_business_effects") })
  afterAll(() => pool.end())
  it("serializes claims and atomically rolls back or commits the business mutation with acknowledgement", async () => {
    const backend = new PgAtomicRecordBackend<InboxKey, InboxRecord>({ pool, table: "framework_test.inbox_records", encodeKey: value => `${value.scopeId}:${value.consumerKey}:${value.messageId}` })
    const store = createDrizzlePgInboxStore(backend)
    await store.observe(record)
    const claims = await Promise.all([store.claim(key, "a", 60_000), store.claim(key, "b", 60_000)])
    const claim = claims.find(Boolean)!
    expect(claims.filter(Boolean)).toHaveLength(1)
    await expect(store.acknowledge(key, claim.claim!.token, async transaction => { const client = transaction as pg.PoolClient; await client.query("INSERT INTO framework_test.ev1_business_effects VALUES ($1,$2)", ["rollback", "x"]); throw new Error("crash") })).rejects.toThrow("crash")
    expect((await pool.query("SELECT count(*)::int AS n FROM framework_test.ev1_business_effects")).rows[0].n).toBe(0)
    expect((await store.get(key))!.state).toBe("claimed")
    await store.acknowledge(key, claim.claim!.token, async transaction => { await (transaction as pg.PoolClient).query("INSERT INTO framework_test.ev1_business_effects VALUES ($1,$2)", ["commit", "ok"]); return "ok" })
    expect((await store.get(key))!.state).toBe("processed")
  })
  it("recovers expired claims with a fresh token and persists fenced outbox publication", async () => {
    const inboxBackend = new PgAtomicRecordBackend<InboxKey, InboxRecord>({ pool, table: "framework_test.inbox_records", encodeKey: value => `${value.scopeId}:${value.consumerKey}:${value.messageId}` })
    const store = createDrizzlePgInboxStore(inboxBackend)
    const takeoverKey = { ...key, messageId: "ev1-pg-takeover" }
    await store.observe({ ...record, ...takeoverKey })
    const first = await store.claim(takeoverKey, "first", 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await store.claim(takeoverKey, "second", 60_000)
    expect(second!.claim!.token).not.toBe(first!.claim!.token)
    await expect(store.renew(takeoverKey, first!.claim!.token, 1000)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    const outboxBackend = new PgAtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>({ pool, table: "framework_test.outbox_delivery_records", encodeKey: value => `${value.scopeId}:${value.messageId}` })
    const outbox = createDrizzlePgOutboxStore(outboxBackend)
    const delivery: OutboxDeliveryRecord = { envelope: { messageId: "out-pg" } as never, scopeId, idempotencyKey: "out-pg", state: "pending", attempt: 0, claim: null }
    await outbox.append(delivery)
    const outClaim = await outbox.claim({ messageId: "out-pg", scopeId }, "publisher", 60_000)
    await outbox.markPublished({ messageId: "out-pg", scopeId }, outClaim!.claim!.token)
    expect((await outbox.get({ messageId: "out-pg", scopeId }))!.state).toBe("published")
  })
})
