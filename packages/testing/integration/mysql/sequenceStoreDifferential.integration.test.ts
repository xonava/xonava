import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe } from "vitest"
import { DrizzleMySqlSequenceStore, mysqlSequenceSchemaSql } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"
import {
  defineConcurrentAllocation, defineConcurrentTransactions, defineSequenceDifferential, defineSequenceRegressions, type SequenceStoreDifferentialDriver,
} from "../shared/sequenceStoreDifferential.js"

const DATABASE = "framework_df_sequence"

function databaseUrl(): string {
  const url = new URL(mysqlCertificationUrl())
  url.pathname = `/${DATABASE}`
  return url.toString()
}

describe("MySQL sequence store differential", () => {
  // The pool connects lazily; the database is created in beforeAll before the first query.
  const pool: Pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 12 })
  const driver: SequenceStoreDifferentialDriver = {
    label: "mysql",
    store: new DrizzleMySqlSequenceStore(pool),
    maxWorkers: 10,
    // Several first allocations of one key waiting behind a rolled-back inserter deadlock (ER_LOCK_DEADLOCK 1213); InnoDB aborts one victim.
    retryable: (error) => (error as { errno?: number }).errno === 1213,
    reset: async () => { await pool.query("DELETE FROM sequences") },
    dump: async () => ((await pool.query<RowDataPacket[]>("SELECT scope_id, name, period, value FROM sequences"))[0] as Record<string, unknown>[]).map((r) => ({ scope: r.scope_id as string, name: r.name as string, period: r.period as string, value: Number(r.value) })),
    seed: async (scope, name, period, value) => { await pool.query("INSERT INTO sequences(scope_id,name,period,value) VALUES(?,?,?,?)", [scope, name, period, value]) },
    transact: async (commit, fn) => {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        let result
        try { result = await fn(new DrizzleMySqlSequenceStore(connection)) } catch (error) { await connection.rollback(); throw error }
        if (commit) await connection.commit(); else await connection.rollback()
        return result
      } finally { connection.release() }
    },
  }

  beforeAll(async () => {
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    await admin.end()
    await pool.query(mysqlSequenceSchemaSql())
  })
  afterAll(async () => {
    await pool.end()
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.end()
  })

  defineSequenceRegressions(driver)
  defineSequenceDifferential(driver)
  defineConcurrentAllocation(driver)
  defineConcurrentTransactions(driver)
})
