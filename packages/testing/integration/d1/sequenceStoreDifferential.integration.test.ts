import { afterAll, beforeAll, describe } from "vitest"
import { D1_SEQUENCE_SCHEMA_SQL, DrizzleD1SequenceStore } from "@xonava/adapters/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { defineConcurrentAllocation, defineSequenceDifferential, defineSequenceRegressions, type SequenceStoreDifferentialDriver } from "../shared/sequenceStoreDifferential.js"

describe("D1 sequence store differential", () => {
  let fixture: D1Fixture
  const db = () => fixture.db
  const all = async (sql: string, ...params: unknown[]) => ((await db().prepare(sql).bind(...params).all()).results ?? []) as Record<string, unknown>[]
  // The store is created lazily so the Miniflare database exists by the time a property runs.
  const store = () => new DrizzleD1SequenceStore(db() as never)
  const driver: SequenceStoreDifferentialDriver = {
    label: "d1",
    store: { next: (scopeId, name, period) => store().next(scopeId, name, period) },
    lifecycleRuns: 50,
    concurrencyRuns: 50,
    light: true,
    maxWorkers: 6,
    reset: async () => { await db().prepare("DELETE FROM df_consumed").run(); await db().prepare("DELETE FROM framework_sequences").run() },
    dump: async () => (await all("SELECT scope_id, name, period, value FROM framework_sequences")).map((r) => ({ scope: r.scope_id as string, name: r.name as string, period: r.period as string, value: Number(r.value) })),
    seed: async (scope, name, period, value) => { await db().prepare("INSERT INTO framework_sequences(scope_id,name,period,value) VALUES(?,?,?,?)").bind(scope, name, period, value).run() },
    batchAllocate: async (scope, name, period, failConsumer) => {
      // The consumer reads the new value from framework_sequences in the same batch; a failing consumer must roll the allocation back.
      const consumer = db().prepare(failConsumer
        ? "INSERT INTO df_consumed(value) SELECT value FROM framework_sequences WHERE scope_id=? AND name=? AND period=? UNION ALL SELECT NULL"
        : "INSERT INTO df_consumed(value) SELECT value FROM framework_sequences WHERE scope_id=? AND name=? AND period=?").bind(scope, name, period)
      const value = await store().nextWithStatements(scope as never, name, period, [consumer])
      return { value, consumed: (await all("SELECT value FROM df_consumed ORDER BY value")).map((r) => Number(r.value)) }
    },
  }

  beforeAll(async () => {
    fixture = await openD1Fixture()
    await fixture.db.exec("CREATE TABLE IF NOT EXISTS df_consumed (value INTEGER NOT NULL)")
    await fixture.db.exec(D1_SEQUENCE_SCHEMA_SQL)
  })
  afterAll(async () => { await fixture?.close() })

  defineSequenceRegressions(driver)
  defineSequenceDifferential(driver)
  defineConcurrentAllocation(driver)
})
