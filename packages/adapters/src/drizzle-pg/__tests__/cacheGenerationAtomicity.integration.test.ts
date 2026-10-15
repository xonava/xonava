import { drizzle } from "drizzle-orm/node-postgres"
import { pgTable, integer, text, timestamp, varchar, uniqueIndex } from "drizzle-orm/pg-core"
import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { CacheService } from "@xonava/core/cache"
import { internalRepositoryForDescriptor } from "../../repository/dynamicRepository"
import type { AuditRecord, OutboxRecord } from "@xonava/core/events"
import type { EntityDescriptor } from "@xonava/core/persistence"
import {
  createDbTagGenerationStore,
  InMemoryCacheAdapter,
  SharedGenerationCacheAdapter,
} from "../../cache"
import {
  createDrizzleAuditSinkFactory,
  createDrizzleOutboxSinkFactory,
  createDrizzlePersistenceProvider,
  createDrizzlePgIdempotencyStore,
  DrizzleEntityRegistry,
  getDrizzleSession,
} from ".."

const databaseUrl = process.env.FRAMEWORK_PG_DATABASE_URL
  ?? process.env.FRAMEWORK_TEST_PG_URL
  ?? process.env.DATABASE_URL
const enabled = databaseUrl !== undefined
  && (process.env.FRAMEWORK_PG_INTEGRATION === "1" || process.env.FRAMEWORK_TEST_PG_URL !== undefined)

const businessTable = pgTable("framework_cache_atomicity_rows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
})
const generationTable = pgTable("framework_cache_atomicity_generations", {
  tag: text("tag").primaryKey(),
  generation: integer("generation").notNull(),
})
const auditTable = pgTable("framework_cache_atomicity_audits", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at").notNull(),
  tenantId: text("tenant_id"),
  action: varchar("action", { length: 100 }).notNull(),
  resourceType: varchar("resource_type", { length: 100 }).notNull(),
  resourceId: text("resource_id").notNull(),
  actorId: text("actor_id").notNull(),
  actorType: varchar("actor_type", { length: 20 }).notNull(),
  impersonatedByAdminId: text("impersonated_by_admin_id"),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  metadata: text("metadata"),
})
const outboxTable = pgTable("framework_cache_atomicity_outbox", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  eventType: text("event_type").notNull(),
  eventVersion: integer("event_version").notNull(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  payload: text("payload").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  eventFingerprint: text("event_fingerprint"),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  availableAt: timestamp("available_at").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
}, (table) => [uniqueIndex("framework_cache_atomicity_outbox_key").on(table.tenantId, table.idempotencyKey)])
const idempotencyTable = pgTable("framework_cache_atomicity_idempotency", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(),
  key: text("key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  token: text("token").notNull(),
  status: text("status").notNull(),
  result: text("result"),
  resourceEntity: text("resource_entity"),
  resourceId: text("resource_id"),
  resourceVersion: text("resource_version"),
  pendingInvalidations: text("pending_invalidations"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [uniqueIndex("framework_cache_atomicity_idempotency_key").on(table.scope, table.key)])

type Row = { id: string; name: string; version: number }
const entity: EntityDescriptor<Row> = {
  name: "framework_cache_atomicity_row",
  primaryKey: "id",
  versionField: "version",
  fields: { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } },
}

const pool = new Pool({ connectionString: databaseUrl, max: 4 })
const tag = "framework-cache-atomicity"

function createRegistry(): DrizzleEntityRegistry {
  return new DrizzleEntityRegistry().register(entity, businessTable, {
    id: businessTable.id,
    name: businessTable.name,
    version: businessTable.version,
  })
}

function audit(id: string, resourceId: string): AuditRecord {
  return {
    id,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    action: "create",
    resourceType: "frameworkCacheAtomicityRow",
    resourceId,
    actor: { id: "framework-proof", kind: "system", authentication: { kind: "authenticated", method: "worker", authenticatedAt: "2026-09-10T00:00:00.000Z" } },
    tenantId: "tenant-proof",
    oldValue: null,
    newValue: { name: "committed" },
  }
}

function outbox(id: string, aggregateId: string): OutboxRecord {
  return {
    id,
    type: "framework.cache.atomicity",
    version: 1,
    tenantId: "tenant-proof",
    scope: { kind: "tenant", tenantId: "tenant-proof" },
    scopeId: "fscope:v1:eyJraW5kIjoidGVuYW50IiwidGVuYW50SWQiOiJ0ZW5hbnQtcHJvb2YifQ" as never,
    aggregateType: "frameworkCacheAtomicityRow",
    aggregateId,
    payload: { name: "committed" },
    idempotencyKey: id,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  }
}

const createOutbox = createDrizzleOutboxSinkFactory(outboxTable, (record) => ({
  tenantId: record.tenantId,
  eventType: record.type,
  eventVersion: record.version,
  aggregateType: record.aggregateType,
  aggregateId: record.aggregateId,
  payload: JSON.stringify(record.payload),
  idempotencyKey: record.idempotencyKey,
  status: "pending",
  attempts: 0,
  availableAt: record.occurredAt,
  createdAt: record.occurredAt,
  updatedAt: record.occurredAt,
}))
const createAudit = createDrizzleAuditSinkFactory(auditTable)

describe.skipIf(!enabled)("PostgreSQL cache-generation atomicity proof", () => {
  beforeAll(async () => {
    await pool.query("DROP TABLE IF EXISTS framework_cache_atomicity_rows, framework_cache_atomicity_generations, framework_cache_atomicity_audits, framework_cache_atomicity_outbox, framework_cache_atomicity_idempotency")
    await pool.query("CREATE TABLE IF NOT EXISTS framework_cache_atomicity_rows (id text PRIMARY KEY, name text NOT NULL, version integer NOT NULL)")
    await pool.query("CREATE TABLE IF NOT EXISTS framework_cache_atomicity_generations (tag text PRIMARY KEY, generation integer NOT NULL)")
    await pool.query("CREATE TABLE IF NOT EXISTS framework_cache_atomicity_audits (id text PRIMARY KEY, created_at timestamptz NOT NULL, tenant_id text, action varchar(100) NOT NULL, resource_type varchar(100) NOT NULL, resource_id text NOT NULL, actor_id text NOT NULL, actor_type varchar(20) NOT NULL, impersonated_by_admin_id text, old_value text, new_value text, metadata text)")
    await pool.query("CREATE TABLE IF NOT EXISTS framework_cache_atomicity_outbox (id text PRIMARY KEY, tenant_id text NOT NULL, event_type text NOT NULL, event_version integer NOT NULL, aggregate_type text NOT NULL, aggregate_id text NOT NULL, payload text NOT NULL, idempotency_key text NOT NULL, event_fingerprint text, status text NOT NULL, attempts integer NOT NULL, available_at timestamptz NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, UNIQUE (tenant_id, idempotency_key))")
    await pool.query("CREATE TABLE IF NOT EXISTS framework_cache_atomicity_idempotency (id text PRIMARY KEY, scope text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, token text NOT NULL, status text NOT NULL, result text, resource_entity text, resource_id text, resource_version text, pending_invalidations text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, UNIQUE (scope, key))")
  })

  beforeEach(async () => {
    await pool.query("TRUNCATE framework_cache_atomicity_rows, framework_cache_atomicity_generations, framework_cache_atomicity_audits, framework_cache_atomicity_outbox, framework_cache_atomicity_idempotency")
  })

  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS framework_cache_atomicity_rows, framework_cache_atomicity_generations, framework_cache_atomicity_audits, framework_cache_atomicity_outbox, framework_cache_atomicity_idempotency")
    await pool.end()
  })

  it("commits business, generation, audit, outbox, and idempotency receipt as one PostgreSQL transaction", async () => {
    const db = drizzle(pool)
    const provider = createDrizzlePersistenceProvider({ db, registry: createRegistry() })
    const idempotency = createDrizzlePgIdempotencyStore(getDrizzleSession(provider), idempotencyTable)
    const acquired = await idempotency.acquire({ scope: "proof", key: "commit", fingerprint: "proof-commit" })
    if (acquired.outcome !== "acquired") throw new Error("idempotency reservation was not acquired")

    const payload = new InMemoryCacheAdapter()
    const cache = new CacheService({ adapter: new SharedGenerationCacheAdapter({ payload, generations: createDbTagGenerationStore({ db, table: generationTable }) }), correctnessCritical: true })
    await cache.getOrSet("row", async () => "old", [tag])
    const oldKey = (await payload.getTagKeys(tag))[0]
    if (!oldKey) throw new Error("cache proof did not record the old generation key")

    await db.transaction(async (tx) => {
      const txProvider = createDrizzlePersistenceProvider({ db: tx, registry: createRegistry() })
      await internalRepositoryForDescriptor(txProvider, entity).insert({ id: "commit-row", name: "committed", version: 1 })
      await createDbTagGenerationStore({ db: tx as never, table: generationTable }).advanceTagGeneration(tag)
      await createAudit.create(txProvider).write(audit("commit-audit", "commit-row"))
      await createOutbox.create(txProvider).append(outbox("commit-outbox", "commit-row"))
      const txIdempotency = createDrizzlePgIdempotencyStore(getDrizzleSession(txProvider), idempotencyTable)
      await txIdempotency.markCommittedInTransaction({ scope: "proof", key: "commit", fingerprint: "proof-commit", token: acquired.token, invalidations: [tag], resource: { entity: entity.name, id: "commit-row", version: 1 } }, txProvider)
    })

    const counts = await pool.query("SELECT (SELECT count(*) FROM framework_cache_atomicity_rows WHERE id = 'commit-row') AS business, (SELECT generation FROM framework_cache_atomicity_generations WHERE tag = $1) AS generation, (SELECT count(*) FROM framework_cache_atomicity_audits WHERE id = 'commit-audit') AS audit, (SELECT count(*) FROM framework_cache_atomicity_outbox WHERE id = 'commit-outbox') AS outbox, (SELECT status FROM framework_cache_atomicity_idempotency WHERE scope = 'proof' AND key = 'commit') AS receipt", [tag])
    expect(counts.rows[0]).toEqual({ business: "1", generation: 1, audit: "1", outbox: "1", receipt: "business-committed" })
    expect(await payload.get(oldKey)).toBe("old")
    await expect(cache.getOrSet("row", async () => "new", [tag])).resolves.toBe("new")
  })

  it("rolls back business, generation, audit, outbox, and committed receipt together", async () => {
    const db = drizzle(pool)
    const provider = createDrizzlePersistenceProvider({ db, registry: createRegistry() })
    const idempotency = createDrizzlePgIdempotencyStore(getDrizzleSession(provider), idempotencyTable)
    const acquired = await idempotency.acquire({ scope: "proof", key: "rollback", fingerprint: "proof-rollback" })
    if (acquired.outcome !== "acquired") throw new Error("idempotency reservation was not acquired")

    await expect(db.transaction(async (tx) => {
      const txProvider = createDrizzlePersistenceProvider({ db: tx, registry: createRegistry() })
      await internalRepositoryForDescriptor(txProvider, entity).insert({ id: "rollback-row", name: "rolled back", version: 1 })
      await createDbTagGenerationStore({ db: tx as never, table: generationTable }).advanceTagGeneration(tag)
      await createAudit.create(txProvider).write(audit("rollback-audit", "rollback-row"))
      await createOutbox.create(txProvider).append(outbox("rollback-outbox", "rollback-row"))
      const txIdempotency = createDrizzlePgIdempotencyStore(getDrizzleSession(txProvider), idempotencyTable)
      await txIdempotency.markCommittedInTransaction({ scope: "proof", key: "rollback", fingerprint: "proof-rollback", token: acquired.token, invalidations: [tag] }, txProvider)
      throw new Error("proof rollback")
    })).rejects.toThrow("proof rollback")

    const state = await pool.query("SELECT (SELECT count(*) FROM framework_cache_atomicity_rows WHERE id = 'rollback-row') AS business, (SELECT count(*) FROM framework_cache_atomicity_generations WHERE tag = $1) AS generation, (SELECT count(*) FROM framework_cache_atomicity_audits WHERE id = 'rollback-audit') AS audit, (SELECT count(*) FROM framework_cache_atomicity_outbox WHERE id = 'rollback-outbox') AS outbox, (SELECT status FROM framework_cache_atomicity_idempotency WHERE scope = 'proof' AND key = 'rollback') AS receipt", [tag])
    expect(state.rows[0]).toEqual({ business: "0", generation: "0", audit: "0", outbox: "0", receipt: "in-progress" })
  })
})
