import pg from "pg"
import { afterAll, beforeAll, describe, it } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { createDrizzleAuditSinkFactory, createDrizzleOutboxSinkFactory, createDrizzlePersistenceProvider } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import { assertNestedDurableEffects, mapNestedOutboxRecord } from "../shared/nestedDurableEffects.js"

const items = pgTable("framework_nested_items", { id: text("id").primaryKey(), name: text("name").notNull() })
const audit = pgTable("framework_nested_audit", {
  id: text("id").primaryKey(), createdAt: timestamp("created_at", { withTimezone: true }).notNull(), tenantId: text("tenant_id"), action: text("action").notNull(),
  resourceType: text("resource_type").notNull(), resourceId: text("resource_id").notNull(), actorId: text("actor_id").notNull(), actorType: text("actor_type").notNull(),
  impersonatedByAdminId: text("impersonated_by_admin_id"), oldValue: text("old_value"), newValue: text("new_value"), metadata: text("metadata"),
})
const outbox = pgTable("framework_nested_outbox", {
  id: text("id").primaryKey(), tenantId: text("tenant_id"), idempotencyScope: text("idempotency_scope").notNull(), idempotencyKey: text("idempotency_key").notNull(),
  eventFingerprint: text("event_fingerprint").notNull(), eventType: text("event_type").notNull(), eventVersion: integer("event_version").notNull(),
  aggregateType: text("aggregate_type").notNull(), aggregateId: text("aggregate_id").notNull(), payload: jsonb("payload").notNull(), occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
})
const DROP = "DROP TABLE IF EXISTS framework_nested_items, framework_nested_audit, framework_nested_outbox"

describe("PostgreSQL nested operations with durable effects", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 4 })
  beforeAll(async () => {
    await pool.query(DROP)
    await pool.query("CREATE TABLE framework_nested_items (id text PRIMARY KEY, name text NOT NULL)")
    await pool.query("CREATE TABLE framework_nested_audit (id text PRIMARY KEY, created_at timestamptz NOT NULL, tenant_id text, action text NOT NULL, resource_type text NOT NULL, resource_id text NOT NULL, actor_id text NOT NULL, actor_type text NOT NULL, impersonated_by_admin_id text, old_value text, new_value text, metadata text)")
    await pool.query("CREATE TABLE framework_nested_outbox (id text PRIMARY KEY, tenant_id text, idempotency_scope text NOT NULL, idempotency_key text NOT NULL, event_fingerprint text NOT NULL, event_type text NOT NULL, event_version integer NOT NULL, aggregate_type text NOT NULL, aggregate_id text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL, UNIQUE (idempotency_scope, idempotency_key))")
  })
  afterAll(async () => {
    await pool.query(DROP).catch(() => undefined)
    await pool.end()
  })

  it("commits a joined child's row, outbox record and audit with the parent and discards them on rollback", async () => {
    const registry = { get: (name: string) => name === "nestedItem" ? { table: items, columnMap: { id: items.id, name: items.name } } : undefined }
    const count = async (sql: string, id: string) => Number((await pool.query<{ n: string }>(sql, [id])).rows[0]!.n)
    await assertNestedDurableEffects({
      persistence: createDrizzlePersistenceProvider({ db: drizzle(pool), registry: registry as never }),
      auditSinkFactory: createDrizzleAuditSinkFactory(audit),
      outboxSinkFactory: createDrizzleOutboxSinkFactory(outbox, mapNestedOutboxRecord),
      counts: async (id) => ({
        items: await count("SELECT count(*) AS n FROM framework_nested_items WHERE id = $1", id),
        audit: await count("SELECT count(*) AS n FROM framework_nested_audit WHERE resource_id = $1", id),
        outbox: await count("SELECT count(*) AS n FROM framework_nested_outbox WHERE aggregate_id = $1", id),
      }),
    }, `nested-pg-${Date.now()}`)
  })
})
