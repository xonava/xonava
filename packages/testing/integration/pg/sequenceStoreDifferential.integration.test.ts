import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import { DrizzlePgSequenceStore, postgresSequenceSchemaSql } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import {
  defineConcurrentAllocation, defineConcurrentTransactions, defineSequenceDifferential, defineSequenceRegressions, type SequenceStoreDifferentialDriver,
} from "../shared/sequenceStoreDifferential.js"

const SCHEMA = "df_sequence"

describe("PostgreSQL sequence store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 12 })
  const driver: SequenceStoreDifferentialDriver = {
    label: "postgres",
    store: new DrizzlePgSequenceStore(pool, SCHEMA),
    maxWorkers: 10,
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.sequences`) },
    dump: async () => (await pool.query(`SELECT scope_id, name, period, value FROM ${SCHEMA}.sequences`)).rows.map((r) => ({ scope: r.scope_id as string, name: r.name as string, period: r.period as string, value: Number(r.value) })),
    seed: async (scope, name, period, value) => { await pool.query(`INSERT INTO ${SCHEMA}.sequences(scope_id,name,period,value) VALUES($1,$2,$3,$4)`, [scope, name, period, value]) },
    transact: async (commit, fn) => {
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        let result
        try { result = await fn(new DrizzlePgSequenceStore(client, SCHEMA)) } catch (error) { await client.query("ROLLBACK"); throw error }
        await client.query(commit ? "COMMIT" : "ROLLBACK")
        return result
      } finally { client.release() }
    },
  }

  beforeAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; ${postgresSequenceSchemaSql(SCHEMA)}`) })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineSequenceRegressions(driver)
  defineSequenceDifferential(driver)
  defineConcurrentAllocation(driver)
  defineConcurrentTransactions(driver)
})
