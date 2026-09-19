import { describe, expect, it } from "vitest"
import { createDrizzleD1InboxStore, createDrizzleD1OutboxStore } from "../../drizzle-d1/drizzleInboxStore"
import { createDrizzlePgInboxStore } from "../../drizzle-pg/drizzleInboxStore"
import type { InboxKey, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord } from "core/events"
import type { AtomicRecordBackend } from "../fencedDeliveryStateMachine"

class MemoryBackend<K, R> implements AtomicRecordBackend<K, R> {
  transactional = true
  now = new Date("2026-09-11T00:00:00.000Z")
  private token = 0
  private readonly rows = new Map<string, R>()
  private queue = Promise.resolve()
  private id(key: K) { return JSON.stringify(key) }
  read(key: K) { return Promise.resolve(this.rows.get(this.id(key)) ?? null) }
  transact<T>(key: K, transition: AtomicRecordBackend<K, R>["transact"] extends (key: K, transition: infer F) => unknown ? F : never): Promise<T> {
    const task = this.queue.then(async () => {
      const id = this.id(key)
      const outcome = await transition(this.rows.get(id) ?? null, new Date(this.now), () => `token-${++this.token}`)
      this.rows.set(id, outcome.record)
      return outcome.result as T
    })
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }
}
const scopeId = "scope-1" as never
const provenance = { format: "framework.authority-provenance", formatVersion: 1 } as never
const key: InboxKey = { consumerKey: "ledger", messageId: "m1", scopeId }
const record: InboxRecord = { ...key, consumerDefinitionVersion: 1, state: "pending", attempt: 0, replayGeneration: 0, claim: null, firstObservedAt: "2026-09-11T00:00:00.000Z", lastObservedAt: "2026-09-11T00:00:00.000Z", eventFormatVersion: 1, eventPayloadVersion: 1, originalProvenance: provenance, replay: { kind: "original-delivery" }, history: [] }

describe.each([["PG", createDrizzlePgInboxStore], ["D1", createDrizzleD1InboxStore]] as const)("%s EV1 inbox conformance", (_name, factory) => {
  it("atomically claims, rejects races, renews, and fences stale owners after takeover", async () => {
    const backend = new MemoryBackend<InboxKey, InboxRecord>(); const store = factory(backend); await store.observe(record)
    const [winner, loser] = await Promise.all([store.claim(key, "a", 1000), store.claim(key, "b", 1000)])
    expect([winner, loser].filter(Boolean)).toHaveLength(1)
    const first = winner ?? loser!; const renewed = await store.renew(key, first.claim!.token, 2000); expect(renewed.claim!.leaseExpiresAt).toBe("2026-09-11T00:00:02.000Z")
    backend.now = new Date("2026-09-11T00:00:03.000Z"); const takeover = await store.claim(key, "b", 1000); expect(takeover!.claim!.token).not.toBe(first.claim!.token)
    await expect(store.acknowledge(key, first.claim!.token, async () => 1)).rejects.toMatchObject({ code: "STALE_CLAIM" })
  })
  it("rolls back failed acknowledgement and supports retry, max-attempt dead letter and authorized replay with history", async () => {
    const backend = new MemoryBackend<InboxKey, InboxRecord>(); const store = factory(backend); await store.observe(record)
    let claim = await store.claim(key, "a", 1000); await expect(store.acknowledge(key, claim!.claim!.token, async () => { throw new Error("mutation failed") })).rejects.toThrow("mutation failed")
    expect((await store.get(key))!.state).toBe("claimed")
    await store.scheduleRetry(key, claim!.claim!.token, "TEMP", 100, 2); backend.now = new Date("2026-09-11T00:00:00.100Z"); claim = await store.claim(key, "b", 1000)
    const dead = await store.scheduleRetry(key, claim!.claim!.token, "MAX", 100, 2); expect(dead.state).toBe("dead_lettered"); expect(dead.history).toHaveLength(1)
    const replayed = await store.replay(key, { requestedBy: provenance, reason: "operator approved", authorized: true, validateReplayEligibility: () => {} }); expect(replayed).toMatchObject({ state: "pending", attempt: 0, replayGeneration: 1 }); expect(replayed.history).toHaveLength(1)
  })
})

it("D1 outbox dispatch is atomically claimed and token fenced", async () => {
  const backend = new MemoryBackend<OutboxDeliveryKey, OutboxDeliveryRecord>(); const store = createDrizzleD1OutboxStore(backend)
  const outbox: OutboxDeliveryRecord = { envelope: { messageId: "m2" } as never, scopeId, idempotencyKey: "k", state: "pending", attempt: 0, claim: null }
  await store.append(outbox); const key = { messageId: "m2", scopeId }; const claim = await store.claim(key, "publisher", 1000); await store.markPublished(key, claim!.claim!.token); expect((await store.get(key))!.state).toBe("published")
})
