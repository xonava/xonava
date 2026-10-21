import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import type { InboxKey, InboxRecord, OutboxDeliveryKey, OutboxDeliveryRecord } from "@xonava/core/events"
import { PgAtomicRecordBackend, createDrizzlePgInboxStore, createDrizzlePgOutboxStore } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import { defineDeliveryConcurrency } from "../shared/deliveryStoreDifferentialConcurrency.js"
import { defineDeliveryDifferential, defineDeliveryRegressions, printCoverage, shiftTimestamps, type DeliveryDriver } from "../shared/deliveryStoreDifferential.js"

const SCHEMA = "df_delivery"
const DDL = `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.inbox_records (record_key text PRIMARY KEY, record jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0);
CREATE TABLE ${SCHEMA}.outbox_delivery_records (record_key text PRIMARY KEY, record jsonb NOT NULL, revision bigint NOT NULL DEFAULT 0);
CREATE TABLE ${SCHEMA}.effects (id text PRIMARY KEY);`

describe("PostgreSQL delivery store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 12 })
  const inbox = createDrizzlePgInboxStore(new PgAtomicRecordBackend<InboxKey, InboxRecord>({ pool, table: `${SCHEMA}.inbox_records`, encodeKey: (key) => `${key.scopeId}:${key.consumerKey}:${key.messageId}` }))
  const outbox = createDrizzlePgOutboxStore(new PgAtomicRecordBackend<OutboxDeliveryKey, OutboxDeliveryRecord>({ pool, table: `${SCHEMA}.outbox_delivery_records`, encodeKey: (key) => `${key.scopeId}:${key.messageId}` }))
  const driver: DeliveryDriver = {
    label: "postgres",
    inbox,
    outbox,
    transactionalAck: true,
    supportsConsume: true,
    lifecycleRuns: 60,
    concurrencyRuns: 50,
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.inbox_records, ${SCHEMA}.outbox_delivery_records, ${SCHEMA}.effects`) },
    advance: async (ms) => {
      for (const table of ["inbox_records", "outbox_delivery_records"]) {
        for (const row of (await pool.query(`SELECT record_key, record FROM ${SCHEMA}.${table}`)).rows as { record_key: string; record: unknown }[]) {
          await pool.query(`UPDATE ${SCHEMA}.${table} SET record = $2::jsonb WHERE record_key = $1`, [row.record_key, JSON.stringify(shiftTimestamps(row.record, ms))])
        }
      }
    },
    effects: async () => (await pool.query(`SELECT id FROM ${SCHEMA}.effects ORDER BY id`)).rows.map((row: { id: string }) => row.id),
    acknowledgeWithEffect: (key, token, effectId, failMutation) => inbox.acknowledge(key, token, async (transaction) => {
      await (transaction as pg.PoolClient).query(`INSERT INTO ${SCHEMA}.effects (id) VALUES ($1)`, [effectId])
      if (failMutation) throw new Error("crash")
      return effectId
    }),
    writeEffect: async (transaction, effectId) => { await (transaction as pg.PoolClient).query(`INSERT INTO ${SCHEMA}.effects (id) VALUES ($1)`, [effectId]) },
  }

  beforeAll(async () => { await pool.query(DDL) })
  afterAll(async () => { printCoverage("pg"); await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineDeliveryRegressions(driver)
  defineDeliveryDifferential(driver)
  defineDeliveryConcurrency(driver)
})
