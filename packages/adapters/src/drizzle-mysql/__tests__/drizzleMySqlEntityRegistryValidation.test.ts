import { describe, expect, it } from "vitest"
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { ConfigurationError } from "core/domain"
import type { EntityDescriptor } from "core/persistence"
import { DrizzleMySqlEntityRegistry, createDrizzleMySqlPersistenceProvider } from "../drizzlePersistenceProvider"

const table = mysqlTable("registry_rows", { id: varchar("id", { length: 100 }).primaryKey(), name: varchar("name", { length: 100 }).notNull(), version: int("version").notNull() })
const columns = { id: table.id, name: table.name, version: table.version }
type Row = { id: string; name: string; version: number }
const entity = (overrides: Partial<EntityDescriptor<Row>> = {}): EntityDescriptor<Row> => ({ name: "registryRow", primaryKey: "id", fields: { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } }, ...overrides })

describe("MySQL DrizzleMySqlEntityRegistry.register validation", () => {
  it("registers a complete entity", () => {
    const registry = new DrizzleMySqlEntityRegistry()
    expect(registry.register(entity({ versionField: "version" } as never), table, columns)).toBe(registry)
    expect(registry.get("registryRow")?.table).toBe(table)
  })
  it("rejects an entity without declared fields", () => {
    expect(() => new DrizzleMySqlEntityRegistry().register(entity({ fields: {} as never }), table, columns)).toThrow(ConfigurationError)
  })
  it("rejects a primary key that is not a declared field", () => {
    expect(() => new DrizzleMySqlEntityRegistry().register(entity({ primaryKey: "uuid" as never }), table, columns)).toThrow(/primary key "uuid" is not a declared field/)
  })
  it("rejects a version field that is not a declared field", () => {
    expect(() => new DrizzleMySqlEntityRegistry().register(entity({ versionField: "rev" } as never), table, columns)).toThrow(/version field "rev" is not a declared field/)
  })
  it("rejects a column map missing declared fields", () => {
    const { version: _version, ...partial } = columns
    expect(() => new DrizzleMySqlEntityRegistry().register(entity(), table, partial)).toThrow(/missing fields: version/)
  })
})

describe("MySQL provider maxPageSize validation", () => {
  const db = {} as never
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid maxPageSize %s", (value) => {
    expect(() => createDrizzleMySqlPersistenceProvider({ db, registry: new DrizzleMySqlEntityRegistry(), maxPageSize: value })).toThrow(new ConfigurationError("MySQL maxPageSize must be a finite positive integer"))
  })
  it("accepts a positive integer maxPageSize", () => {
    expect(createDrizzleMySqlPersistenceProvider({ db, registry: new DrizzleMySqlEntityRegistry(), maxPageSize: 25 }).capabilities.maxPageSize).toBe(25)
  })
})
