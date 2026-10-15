import { describe, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { createDrizzleAuditSinkFactory, createDrizzleOutboxSinkFactory, createDrizzlePersistenceProvider, DrizzleEntityRegistry } from "@xonava/adapters/drizzle-d1"
import { openD1Fixture } from "./database.js"
import { assertNestedDurableEffectsRefusedWithoutTransactions, nestedItemEntity } from "../shared/nestedDurableEffects.js"

const items = sqliteTable("nested_items", { id: text("id").primaryKey(), name: text("name").notNull() })
const audit = sqliteTable("nested_audit", { id: text("id").primaryKey(), action: text("action"), resourceId: text("resource_id") })
const outbox = sqliteTable("nested_outbox", {
  id: text("id").primaryKey(), type: text("type"), aggregateId: text("aggregate_id"), payload: text("payload"), idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint"), provenance: text("provenance"),
}, (table) => [uniqueIndex("nested_outbox_identity").on(table.idempotencyScope, table.idempotencyKey)])
const SCHEMA = [
  "CREATE TABLE nested_items (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
  "CREATE TABLE nested_audit (id TEXT PRIMARY KEY, action TEXT, resource_id TEXT)",
  "CREATE TABLE nested_outbox (id TEXT PRIMARY KEY, type TEXT, aggregate_id TEXT, payload TEXT, idempotency_scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, event_fingerprint TEXT NOT NULL, provenance TEXT, UNIQUE (idempotency_scope, idempotency_key))",
]

describe("D1 nested operations with durable effects", () => {
  // D1 has no interactive transactions, so a child can never join its
  // parent's transaction; the composition must fail closed with nothing written.
  it("refuses transactional nested composition before writing a row, outbox record or audit", async () => {
    const fixture = await openD1Fixture()
    try {
      for (const statement of SCHEMA) await fixture.db.exec(statement)
      const db = drizzle(fixture.db as never)
      const registry = new DrizzleEntityRegistry().register(nestedItemEntity, items, { id: items.id, name: items.name })
      const count = async (table: string, column: string, id: string) => (await fixture.db.prepare(`SELECT count(*) AS c FROM ${table} WHERE ${column} = ?`).bind(id).first<{ c: number }>())!.c
      await assertNestedDurableEffectsRefusedWithoutTransactions({
        persistence: createDrizzlePersistenceProvider({ db, registry }),
        auditSinkFactory: createDrizzleAuditSinkFactory(audit, (record) => ({ id: record.id, action: record.action, resourceId: record.resourceId })),
        outboxSinkFactory: createDrizzleOutboxSinkFactory(outbox, (record) => ({ type: record.type, aggregateId: record.aggregateId, payload: JSON.stringify(record.payload) })),
        counts: async (id) => ({ items: await count("nested_items", "id", id), audit: await count("nested_audit", "resource_id", id), outbox: await count("nested_outbox", "aggregate_id", id) }),
      }, "nested-d1")
    } finally {
      await fixture.close()
    }
  })
})
