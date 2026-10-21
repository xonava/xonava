import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { InboxKey, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord } from "@xonava/core/events"
import { D1AtomicRecordBackend, DrizzleD1InboxStore, createDrizzleD1OutboxStore } from "@xonava/adapters/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { defineDeliveryConcurrency } from "../shared/deliveryStoreDifferentialConcurrency.js"
import { defineDeliveryDifferential, defineDeliveryRegressions, printCoverage, shiftTimestamps, type DeliveryDriver } from "../shared/deliveryStoreDifferential.js"
import { INBOX_KEYS, inboxRecordFor } from "../shared/deliveryStoreDifferentialModel.js"

const SCHEMA = [
  "CREATE TABLE df_inbox_records (record_key TEXT PRIMARY KEY, record TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE df_outbox_records (record_key TEXT PRIMARY KEY, record TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE df_effects (id TEXT PRIMARY KEY)",
]

describe("D1 delivery store differential", () => {
  let fixture: D1Fixture
  const d1 = () => fixture.db
  const all = async (sql: string) => ((await d1().prepare(sql).all()).results ?? []) as Record<string, unknown>[]
  // The stores are created lazily so the Miniflare database exists by the time a property runs.
  let inboxStore: DrizzleD1InboxStore | undefined
  let outboxStore: ReturnType<typeof createDrizzleD1OutboxStore> | undefined
  const inbox = () => (inboxStore ??= new DrizzleD1InboxStore(new D1AtomicRecordBackend<InboxKey, InboxRecord>({ database: d1() as never, table: "df_inbox_records", encodeKey: (key) => `${key.scopeId}:${key.consumerKey}:${key.messageId}` })))
  const outbox = () => (outboxStore ??= createDrizzleD1OutboxStore(new D1AtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>({ database: d1() as never, table: "df_outbox_records", encodeKey: (key) => `${key.scopeId}:${key.messageId}` })))
  const lazy = <T extends object>(get: () => T): T => new Proxy({} as T, { get: (_target, property) => { const value = (get() as never)[property as never] as unknown; return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(get()) : value } })

  const driver: DeliveryDriver = {
    label: "d1",
    inbox: lazy(inbox),
    outbox: lazy(outbox),
    transactionalAck: false,
    supportsConsume: false,
    lifecycleRuns: 50,
    concurrencyRuns: 50,
    light: true,
    reset: async () => { for (const table of ["df_inbox_records", "df_outbox_records", "df_effects"]) await d1().prepare(`DELETE FROM ${table}`).run() },
    advance: async (ms) => {
      for (const table of ["df_inbox_records", "df_outbox_records"]) {
        for (const row of await all(`SELECT record_key, record FROM ${table}`)) {
          await d1().prepare(`UPDATE ${table} SET record = ? WHERE record_key = ?`).bind(JSON.stringify(shiftTimestamps(JSON.parse(row.record as string), ms)), row.record_key).run()
        }
      }
    },
    effects: async () => (await all("SELECT id FROM df_effects ORDER BY id")).map((row) => row.id as string),
    acknowledgeWithEffect: (key, token, effectId, failMutation) => inbox().acknowledgeBatch(key, token, [
      d1().prepare("INSERT INTO df_effects (id) VALUES (?)").bind(effectId) as never,
      ...(failMutation ? [d1().prepare("UPDATE df_effects SET id = id WHERE id = '__missing__'") as never] : []),
    ], effectId),
    writeEffect: async () => { throw new Error("D1 has no transactional acknowledge") },
  }

  beforeAll(async () => {
    fixture = await openD1Fixture()
    for (const statement of SCHEMA) await fixture.db.exec(statement)
  })
  afterAll(async () => { printCoverage("d1"); await fixture?.close() })

  defineDeliveryRegressions(driver)
  defineDeliveryDifferential(driver)
  defineDeliveryConcurrency(driver)

  it("acknowledgeBatch requires at least one business statement and changes nothing otherwise", async () => {
    await driver.reset()
    const key = INBOX_KEYS[0]!
    await driver.inbox.observe(inboxRecordFor(0))
    const claimed = (await driver.inbox.claim(key, "w1", 300_000))!
    expect(() => inbox().acknowledgeBatch(key, claimed.claim!.token, [], "none")).toThrow("at least one business statement")
    expect(await driver.inbox.get(key)).toMatchObject({ state: "claimed", claim: { token: claimed.claim!.token } })
  })
})
