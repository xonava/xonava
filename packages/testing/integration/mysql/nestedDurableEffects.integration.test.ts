import { describe, it } from "vitest"
import { bigint, datetime, json, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { createDrizzleMySqlAuditSinkFactory, createDrizzleMySqlOutboxSinkFactory, createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry } from "@xonava/adapters/drizzle-mysql"
import { openMySqlFixture } from "./database.js"
import { assertNestedDurableEffects, mapNestedOutboxRecord, nestedItemEntity } from "../shared/nestedDurableEffects.js"

const items = mysqlTable("framework_nested_items", { id: varchar("id", { length: 100 }).primaryKey(), name: varchar("name", { length: 255 }).notNull() })
const audit = mysqlTable("framework_nested_audit", {
  id: varchar("id", { length: 100 }).primaryKey(), createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull(), tenantId: varchar("tenant_id", { length: 100 }),
  action: varchar("action", { length: 100 }).notNull(), resourceType: varchar("resource_type", { length: 100 }).notNull(), resourceId: varchar("resource_id", { length: 100 }).notNull(),
  actorId: varchar("actor_id", { length: 100 }).notNull(), actorType: varchar("actor_type", { length: 50 }).notNull(), oldValue: json("old_value"), newValue: json("new_value"), metadata: json("metadata"),
})
const outbox = mysqlTable("framework_nested_outbox", {
  id: varchar("id", { length: 100 }).primaryKey(), tenantId: varchar("tenant_id", { length: 100 }), idempotencyScope: varchar("idempotency_scope", { length: 255 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(), eventFingerprint: varchar("event_fingerprint", { length: 128 }).notNull(), eventType: varchar("event_type", { length: 100 }).notNull(),
  eventVersion: bigint("event_version", { mode: "number" }).notNull(), aggregateType: varchar("aggregate_type", { length: 100 }).notNull(), aggregateId: varchar("aggregate_id", { length: 100 }).notNull(),
  payload: json("payload").notNull(), occurredAt: datetime("occurred_at", { mode: "date", fsp: 3 }).notNull(),
})
const TABLES = ["framework_nested_items", "framework_nested_audit", "framework_nested_outbox"]

describe("MySQL nested operations with durable effects", () => {
  it("commits a joined child's row, outbox record and audit with the parent and discards them on rollback", async () => {
    const { pool, db } = await openMySqlFixture()
    try {
      for (const table of TABLES) await pool.query(`DROP TABLE IF EXISTS \`${table}\``)
      await pool.query("CREATE TABLE framework_nested_items (id VARCHAR(100) PRIMARY KEY, name VARCHAR(255) NOT NULL) ENGINE=InnoDB")
      await pool.query("CREATE TABLE framework_nested_audit (id VARCHAR(100) PRIMARY KEY, created_at DATETIME(3) NOT NULL, tenant_id VARCHAR(100) NULL, action VARCHAR(100) NOT NULL, resource_type VARCHAR(100) NOT NULL, resource_id VARCHAR(100) NOT NULL, actor_id VARCHAR(100) NOT NULL, actor_type VARCHAR(50) NOT NULL, old_value JSON NULL, new_value JSON NULL, metadata JSON NULL) ENGINE=InnoDB")
      await pool.query("CREATE TABLE framework_nested_outbox (id VARCHAR(100) PRIMARY KEY, tenant_id VARCHAR(100) NULL, idempotency_scope VARCHAR(255) NOT NULL, idempotency_key VARCHAR(255) NOT NULL, event_fingerprint VARCHAR(128) NOT NULL, event_type VARCHAR(100) NOT NULL, event_version INT NOT NULL, aggregate_type VARCHAR(100) NOT NULL, aggregate_id VARCHAR(100) NOT NULL, payload JSON NOT NULL, occurred_at DATETIME(3) NOT NULL, UNIQUE KEY framework_nested_outbox_uq (idempotency_scope, idempotency_key)) ENGINE=InnoDB")
      const registry = new DrizzleMySqlEntityRegistry().register(nestedItemEntity, items, { id: items.id, name: items.name })
      const count = async (sql: string, id: string) => Number(((await pool.query(sql, [id]))[0] as { n: number }[])[0]!.n)
      await assertNestedDurableEffects({
        persistence: createDrizzleMySqlPersistenceProvider({ db, registry }),
        auditSinkFactory: createDrizzleMySqlAuditSinkFactory(audit),
        outboxSinkFactory: createDrizzleMySqlOutboxSinkFactory(outbox, mapNestedOutboxRecord),
        counts: async (id) => ({
          items: await count("SELECT COUNT(*) AS n FROM framework_nested_items WHERE id = ?", id),
          audit: await count("SELECT COUNT(*) AS n FROM framework_nested_audit WHERE resource_id = ?", id),
          outbox: await count("SELECT COUNT(*) AS n FROM framework_nested_outbox WHERE aggregate_id = ?", id),
        }),
      }, `nested-mysql-${Date.now()}`)
    } finally {
      for (const table of TABLES) await pool.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => undefined)
      await pool.end()
    }
  })
})
