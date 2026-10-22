import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterAll, beforeAll, describe } from "vitest"
import { createDbTagGenerationStore } from "@xonava/adapters/cache"
import { openD1Fixture, type D1Fixture } from "./database.js"
import {
  defineConcurrentInvalidation, defineKvConcurrentInvalidation, defineKvGenerationDifferential, defineTagGenerationDifferential, defineTagGenerationRegressions,
  type TagGenerationStoreDifferentialDriver,
} from "../shared/tagGenerationStoreDifferential.js"

// The documented shape of the generation table (`tag`, `generation`) in an isolated table.
const generations = sqliteTable("df_tag_generations", { tag: text("tag").primaryKey(), generation: integer("generation").notNull() })

describe("D1 tag generation store differential", () => {
  let fixture: D1Fixture
  const db = () => fixture.db
  const all = async (sql: string, ...params: unknown[]) => ((await db().prepare(sql).bind(...params).all()).results ?? []) as Record<string, unknown>[]
  // The store is created lazily so the Miniflare database exists by the time a property runs.
  const store = () => createDbTagGenerationStore({ db: drizzle(db() as never) as never, table: generations })
  const driver: TagGenerationStoreDifferentialDriver = {
    label: "d1",
    store: { getTagGeneration: (tag) => store().getTagGeneration(tag), advanceTagGeneration: (tag) => store().advanceTagGeneration(tag) },
    lifecycleRuns: 50,
    concurrencyRuns: 50,
    light: true,
    maxWorkers: 6,
    reset: async () => { await db().prepare("DELETE FROM df_tag_generations").run() },
    dump: async () => (await all("SELECT tag, generation FROM df_tag_generations")).map((r) => ({ tag: r.tag as string, generation: Number(r.generation) })),
    seed: async (tag, generation) => { await db().prepare("INSERT INTO df_tag_generations(tag,generation) VALUES(?,?)").bind(tag, generation).run() },
  }

  beforeAll(async () => {
    fixture = await openD1Fixture()
    await fixture.db.exec("CREATE TABLE IF NOT EXISTS df_tag_generations (tag TEXT PRIMARY KEY, generation INTEGER NOT NULL)")
  })
  afterAll(async () => { await fixture?.close() })

  defineTagGenerationRegressions(driver)
  defineTagGenerationDifferential(driver)
  defineConcurrentInvalidation(driver)
  defineKvGenerationDifferential("d1")
  defineKvConcurrentInvalidation("d1")
})
