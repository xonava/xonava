import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgSchema, text } from "drizzle-orm/pg-core"
import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import { createDbTagGenerationStore } from "@xonava/adapters/cache"
import { pgCertificationUrl } from "./database.js"
import {
  defineConcurrentInvalidation, defineKvConcurrentInvalidation, defineKvGenerationDifferential, defineTagGenerationDifferential, defineTagGenerationRegressions,
  type TagGenerationStoreDifferentialDriver,
} from "../shared/tagGenerationStoreDifferential.js"

const SCHEMA = "df_tag_generation"
// The documented shape of the generation table (`tag`, `generation`) in an isolated schema.
const generations = pgSchema(SCHEMA).table("cache_generations", { tag: text("tag").primaryKey(), generation: integer("generation").notNull() })

describe("PostgreSQL tag generation store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 12 })
  const driver: TagGenerationStoreDifferentialDriver = {
    label: "postgres",
    store: createDbTagGenerationStore({ db: drizzle(pool) as never, table: generations }),
    maxWorkers: 10,
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.cache_generations`) },
    dump: async () => (await pool.query(`SELECT tag, generation FROM ${SCHEMA}.cache_generations`)).rows.map((r) => ({ tag: r.tag as string, generation: Number(r.generation) })),
    seed: async (tag, generation) => { await pool.query(`INSERT INTO ${SCHEMA}.cache_generations(tag,generation) VALUES($1,$2)`, [tag, generation]) },
  }

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.cache_generations (tag text PRIMARY KEY, generation integer NOT NULL);`)
  })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineTagGenerationRegressions(driver)
  defineTagGenerationDifferential(driver)
  defineConcurrentInvalidation(driver)
  defineKvGenerationDifferential("postgres")
  defineKvConcurrentInvalidation("postgres")
})
