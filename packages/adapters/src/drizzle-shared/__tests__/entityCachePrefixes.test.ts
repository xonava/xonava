import { describe, expect, it } from "vitest"
import { z } from "zod"
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core"
import { integer as sqliteInteger, sqliteTable, text as sqliteText } from "drizzle-orm/sqlite-core"
import { ConfigurationError } from "core/domain"
import { defineEntity } from "core/entity"
import { DrizzleEntityRegistry as D1Registry } from "adapters/drizzle-d1"
import { DrizzleMySqlEntityRegistry } from "../../drizzle-mysql/drizzlePersistenceProvider"
import { DrizzleEntityRegistry as PgRegistry } from "adapters/drizzle-pg"

type Row = { id: string; tenantId: string; name: string; version: number }

function compiled(moduleKey: string, name: string, cache: false | { tag: string; keyPrefix: string } | undefined) {
  return defineEntity<Row, { name: string }, { name: string }>({
    moduleKey,
    entity: { name, primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" } } },
    entityScope: { kind: "tenant" },
    policy: { skipCapabilityCheck: true },
    cache: cache === undefined ? { tag: `${moduleKey}.${name}` } as never : cache,
    audit: false,
    validation: { createBody: z.object({ name: z.string() }), updateBody: z.object({ name: z.string() }), idParams: z.object({ id: z.string() }) },
  })
}

const pgRows = pgTable("rows", { id: pgText("id").primaryKey(), tenantId: pgText("tenant_id").notNull(), name: pgText("name").notNull(), version: pgInteger("version").notNull() })
const mysqlRows = mysqlTable("rows", { id: varchar("id", { length: 64 }).primaryKey(), tenantId: varchar("tenant_id", { length: 64 }).notNull(), name: varchar("name", { length: 64 }).notNull(), version: int("version").notNull() })
const sqliteRows = sqliteTable("rows", { id: sqliteText("id").primaryKey(), tenantId: sqliteText("tenant_id").notNull(), name: sqliteText("name").notNull(), version: sqliteInteger("version").notNull() })

type Entity = ReturnType<typeof compiled>
interface Harness {
  create(): { register(entity: Entity, namespace?: string): unknown; get(name: string, namespace?: string): unknown }
}
const harnesses: Record<string, Harness> = {
  pg: { create: () => { const r = new PgRegistry(); return { register: (e, ns) => r.register(e, pgRows, { id: pgRows.id, tenantId: pgRows.tenantId, name: pgRows.name, version: pgRows.version }, ns), get: (n, ns) => r.get(n, ns) } } },
  mysql: { create: () => { const r = new DrizzleMySqlEntityRegistry(); return { register: (e, ns) => r.register(e, mysqlRows, { id: mysqlRows.id, tenantId: mysqlRows.tenantId, name: mysqlRows.name, version: mysqlRows.version }, ns), get: (n, ns) => r.get(n, ns) } } },
  d1: { create: () => { const r = new D1Registry(); return { register: (e, ns) => r.register(e, sqliteRows, { id: sqliteRows.id, tenantId: sqliteRows.tenantId, name: sqliteRows.name, version: sqliteRows.version }, ns), get: (n, ns) => r.get(n, ns) } } },
}

describe.each(Object.entries(harnesses))("%s entity registry: duplicate explicit cache key prefixes", (_dialect, { create }) => {
  it("rejects a second entity reusing an explicit keyPrefix, naming both entities and the prefix", () => {
    const registry = create()
    registry.register(compiled("billing", "invoice", { tag: "billing.invoice", keyPrefix: "shared" }))
    let error: unknown
    try { registry.register(compiled("crm", "contact", { tag: "crm.contact", keyPrefix: "shared" })) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(ConfigurationError)
    const message = (error as Error).message
    expect(message).toContain("billing:invoice")
    expect(message).toContain("crm:contact")
    expect(message).toContain('"shared"')
    // The rejected registration is not recorded, and a distinct prefix is still accepted.
    expect(registry.get("contact")).toBeUndefined()
    expect(() => registry.register(compiled("crm", "contact", { tag: "crm.contact", keyPrefix: "crm-contact" }))).not.toThrow()
  })

  it("accepts distinct explicit prefixes and distinct defaults", () => {
    const registry = create()
    registry.register(compiled("billing", "invoice", { tag: "a", keyPrefix: "p1" }))
    registry.register(compiled("billing", "payment", { tag: "b", keyPrefix: "p2" }))
    registry.register(compiled("billing", "refund", undefined))
    registry.register(compiled("crm", "refund", undefined), "other")
    expect(registry.get("payment")).toBeDefined()
  })

  it("skips entities with caching disabled and plain persistence descriptors", () => {
    const registry = create()
    registry.register(compiled("billing", "invoice", false))
    registry.register(compiled("crm", "contact", false))
    registry.register(compiled("ops", "task", { tag: "ops.task", keyPrefix: "p" }))
    expect(registry.get("invoice")).toBeDefined()
    expect(registry.get("contact")).toBeDefined()
  })

  it("still reports a duplicate registration key before the prefix check", () => {
    const registry = create()
    registry.register(compiled("billing", "invoice", { tag: "t", keyPrefix: "same" }))
    expect(() => registry.register(compiled("billing", "invoice", { tag: "t", keyPrefix: "same" }))).toThrow(/already registered|duplicate/i)
  })
})
