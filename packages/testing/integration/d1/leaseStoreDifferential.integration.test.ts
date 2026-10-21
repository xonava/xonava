import { afterAll, beforeAll, describe } from "vitest"
import type { FencedLease } from "@xonava/core/events"
import { createD1LeaseStore } from "@xonava/adapters/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { defineLeaseConcurrency } from "../shared/leaseStoreDifferentialConcurrency.js"
import { defineLeaseDifferential, defineLeaseRegressions, printCoverage, shiftTimestamps, type LeaseDriver } from "../shared/leaseStoreDifferential.js"
import { keyOf } from "../shared/leaseStoreDifferentialModel.js"

const TABLE = "df_lease_records"

describe("D1 lease store differential", () => {
  let fixture: D1Fixture
  const d1 = () => fixture.db
  const all = async (sql: string) => ((await d1().prepare(sql).all()).results ?? []) as Record<string, unknown>[]
  // The store is created lazily so the Miniflare database exists by the time a property runs.
  let leaseStore: ReturnType<typeof createD1LeaseStore> | undefined
  const store = () => (leaseStore ??= createD1LeaseStore(d1() as never, TABLE))

  const driver: LeaseDriver = {
    label: "d1",
    store: new Proxy({} as LeaseDriver["store"], { get: (_target, property) => { const value = (store() as never)[property as never] as unknown; return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(store()) : value } }),
    lifecycleRuns: 50,
    concurrencyRuns: 50,
    light: true,
    reset: async () => { await d1().prepare(`DELETE FROM ${TABLE}`).run() },
    advance: async (ms) => {
      for (const row of await all(`SELECT resource_key, lease FROM ${TABLE} WHERE lease IS NOT NULL`)) {
        await d1().prepare(`UPDATE ${TABLE} SET lease = ? WHERE resource_key = ?`).bind(JSON.stringify(shiftTimestamps(JSON.parse(row.lease as string), ms)), row.resource_key).run()
      }
    },
    peek: async (resource) => {
      const row = await d1().prepare(`SELECT (SELECT lease FROM ${TABLE} WHERE resource_key = ?) AS lease, CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms`).bind(keyOf(resource)).first<{ lease: string | null; now_ms: number }>()
      return { lease: row!.lease === null ? null : JSON.parse(row!.lease) as FencedLease, nowMs: row!.now_ms }
    },
  }

  beforeAll(async () => {
    fixture = await openD1Fixture()
    await fixture.db.exec(`CREATE TABLE ${TABLE} (resource_key TEXT PRIMARY KEY, lease TEXT NULL, revision INTEGER NOT NULL DEFAULT 0)`)
  })
  afterAll(async () => { printCoverage("d1"); await fixture?.close() })

  defineLeaseRegressions(driver)
  defineLeaseDifferential(driver)
  defineLeaseConcurrency(driver)
})
