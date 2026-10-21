import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import type { FencedLease } from "@xonava/core/events"
import { createPgLeaseStore } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import { defineLeaseConcurrency } from "../shared/leaseStoreDifferentialConcurrency.js"
import { defineLeaseDifferential, defineLeaseRegressions, printCoverage, shiftTimestamps, type LeaseDriver } from "../shared/leaseStoreDifferential.js"
import { keyOf } from "../shared/leaseStoreDifferentialModel.js"

const SCHEMA = "df_lease"
const DDL = `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.lease_records (resource_key text PRIMARY KEY, lease jsonb NULL, revision bigint NOT NULL DEFAULT 0);`

describe("PostgreSQL lease store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 12 })
  const driver: LeaseDriver = {
    label: "postgres",
    store: createPgLeaseStore(pool, `${SCHEMA}.lease_records`),
    lifecycleRuns: 60,
    concurrencyRuns: 50,
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.lease_records`) },
    advance: async (ms) => {
      for (const row of (await pool.query(`SELECT resource_key, lease FROM ${SCHEMA}.lease_records WHERE lease IS NOT NULL`)).rows as { resource_key: string; lease: unknown }[]) {
        await pool.query(`UPDATE ${SCHEMA}.lease_records SET lease = $2::jsonb WHERE resource_key = $1`, [row.resource_key, JSON.stringify(shiftTimestamps(row.lease, ms))])
      }
    },
    peek: async (resource) => {
      const result = await pool.query(`SELECT (SELECT lease FROM ${SCHEMA}.lease_records WHERE resource_key = $1) AS lease, floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS now_ms`, [keyOf(resource)])
      const row = result.rows[0] as { lease: FencedLease | null; now_ms: number }
      return { lease: row.lease ?? null, nowMs: Number(row.now_ms) }
    },
  }

  beforeAll(async () => { await pool.query(DDL) })
  afterAll(async () => { printCoverage("pg"); await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineLeaseRegressions(driver)
  defineLeaseDifferential(driver)
  defineLeaseConcurrency(driver)
})
