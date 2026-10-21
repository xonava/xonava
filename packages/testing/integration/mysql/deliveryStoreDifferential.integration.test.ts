import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe } from "vitest"
import { createMySqlInboxStore, createMySqlOutboxStore } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"
import { defineDeliveryConcurrency } from "../shared/deliveryStoreDifferentialConcurrency.js"
import { defineDeliveryDifferential, defineDeliveryRegressions, printCoverage, shiftTimestamps, type DeliveryDriver } from "../shared/deliveryStoreDifferential.js"

const DATABASE = "framework_df_delivery"

function databaseUrl(): string {
  const url = new URL(mysqlCertificationUrl())
  url.pathname = `/${DATABASE}`
  return url.toString()
}

describe("MySQL delivery store differential", () => {
  // The pool connects lazily; the database is created in beforeAll before the first query.
  const pool: Pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 12 })
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0] as Record<string, unknown>[]
  // Production layout: one atomic_records table holds both inbox and outbox records.
  const inbox = createMySqlInboxStore(pool)
  const outbox = createMySqlOutboxStore(pool)
  const driver: DeliveryDriver = {
    label: "mysql",
    inbox,
    outbox,
    transactionalAck: true,
    supportsConsume: true,
    lifecycleRuns: 60,
    concurrencyRuns: 50,
    reset: async () => { await pool.query("DELETE FROM atomic_records"); await pool.query("DELETE FROM df_effects") },
    advance: async (ms) => {
      for (const row of await rows("SELECT record_key, record FROM atomic_records")) {
        if (row.record === null || row.record === undefined) continue
        const record = typeof row.record === "string" ? JSON.parse(row.record) : row.record
        await pool.query("UPDATE atomic_records SET record = ? WHERE record_key = ?", [JSON.stringify(shiftTimestamps(record, ms)), row.record_key])
      }
    },
    effects: async () => (await rows("SELECT id FROM df_effects ORDER BY id")).map((row) => row.id as string),
    acknowledgeWithEffect: (key, token, effectId, failMutation) => inbox.acknowledge(key, token, async (transaction) => {
      await (transaction as PoolConnection).query("INSERT INTO df_effects (id) VALUES (?)", [effectId])
      if (failMutation) throw new Error("crash")
      return effectId
    }),
    writeEffect: async (transaction, effectId) => { await (transaction as PoolConnection).query("INSERT INTO df_effects (id) VALUES (?)", [effectId]) },
  }

  beforeAll(async () => {
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    await admin.end()
    const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/mysql/migrations/0001_framework.sql"), "utf8")
    for (const statement of source.split(";").map((value) => value.trim()).filter(Boolean)) {
      if (/^CREATE TABLE (?:IF NOT EXISTS )?atomic_records\b/.test(statement)) await pool.query(statement)
    }
    await pool.query("CREATE TABLE df_effects (id VARCHAR(100) PRIMARY KEY) ENGINE=InnoDB")
  })
  afterAll(async () => {
    printCoverage("mysql")
    await pool.end()
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.end()
  })

  defineDeliveryRegressions(driver)
  defineDeliveryDifferential(driver)
  defineDeliveryConcurrency(driver)
})
