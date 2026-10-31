import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe } from "vitest"
import type { FencedLease } from "@xonava/core/events"
import { createMySqlLeaseStore } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"
import { defineLeaseConcurrency } from "../shared/leaseStoreDifferentialConcurrency.js"
import { defineLeaseDifferential, defineLeaseRegressions, printCoverage, shiftTimestamps, type LeaseDriver } from "../shared/leaseStoreDifferential.js"
import { keyOf } from "../shared/leaseStoreDifferentialModel.js"

const DATABASE = "framework_df_lease"

function databaseUrl(): string {
  const url = new URL(mysqlCertificationUrl())
  url.pathname = `/${DATABASE}`
  return url.toString()
}

describe("MySQL lease store differential", () => {
  // The pool connects lazily; the database is created in beforeAll before the first query.
  const pool: Pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 12 })
  const rows = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0] as Record<string, unknown>[]
  const parse = (value: unknown): FencedLease | null => (value === null || value === undefined ? null : typeof value === "string" ? JSON.parse(value) as FencedLease : value as FencedLease)
  const driver: LeaseDriver = {
    label: "mysql",
    store: createMySqlLeaseStore(pool),
    lifecycleRuns: 60,
    concurrencyRuns: 50,
    reset: async () => { await pool.query("DELETE FROM leases") },
    advance: async (ms) => {
      for (const row of await rows("SELECT resource_key, lease FROM leases WHERE lease IS NOT NULL")) {
        await pool.query("UPDATE leases SET lease = ? WHERE resource_key = ?", [JSON.stringify(shiftTimestamps(parse(row.lease), ms)), row.resource_key])
      }
    },
    peek: async (resource) => {
      const [row] = await rows("SELECT (SELECT lease FROM leases WHERE resource_key = ?) AS lease, CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS DECIMAL(20,0)) AS now_ms", [keyOf(resource)])
      return { lease: parse(row!.lease), nowMs: Number(row!.now_ms) }
    },
  }

  beforeAll(async () => {
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\` CHARACTER SET utf8mb4`)
    await admin.end()
    // Production layout after migration 0006: byte-exact (utf8mb4_0900_bin) resource keys.
    await pool.query("CREATE TABLE leases (resource_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL PRIMARY KEY, lease JSON NULL, revision BIGINT NOT NULL DEFAULT 0) ENGINE=InnoDB")
  })
  afterAll(async () => {
    printCoverage("mysql")
    await pool.end()
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.end()
  })

  defineLeaseRegressions(driver)
  defineLeaseDifferential(driver)
  defineLeaseConcurrency(driver)
})
