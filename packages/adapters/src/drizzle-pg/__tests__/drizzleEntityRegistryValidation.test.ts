import { describe, expect, it } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { ConfigurationError } from "@xonava/core/domain"
import type { EntityDescriptor } from "@xonava/core/persistence"
import { DrizzleEntityRegistry } from "@xonava/adapters/drizzle-pg"

const table = pgTable("registry_rows", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  version: integer("version").notNull(),
})

const columns = { id: table.id, name: table.name, version: table.version }

function entity(overrides: Partial<EntityDescriptor<{ id: string; name: string; version: number }>> = {}): EntityDescriptor<{ id: string; name: string; version: number }> {
  return {
    name: "registryRow",
    primaryKey: "id",
    fields: {
      id: { type: "string" },
      name: { type: "string" },
      version: { type: "number" },
    },
    ...overrides,
  }
}

describe("PostgreSQL DrizzleEntityRegistry.register validation (P1-04)", () => {
  it("registers a complete entity and supports namespace-scoped get", () => {
    const registry = new DrizzleEntityRegistry()
    expect(registry.register(entity(), table, columns)).toBe(registry)
    expect(registry.get("registryRow")?.table).toBe(table)
    expect(registry.get("registryRow", "tenant-1")).toBeUndefined()

    registry.register(entity(), table, columns, "tenant-1")
    expect(registry.get("registryRow", "tenant-1")?.columnMap).toEqual(columns)
  })

  it("allows extra column map keys not declared on the entity", () => {
    const registry = new DrizzleEntityRegistry()
    expect(() => registry.register(entity(), table, { ...columns, createdAt: table.id })).not.toThrow()
  })

  it("rejects an empty entity name", () => {
    expect(() => new DrizzleEntityRegistry().register(entity({ name: "" }), table, columns))
      .toThrow(new ConfigurationError('Drizzle registry registration "" requires a non-empty entity name.'))
  })

  it("rejects an entity without declared fields", () => {
    expect(() => new DrizzleEntityRegistry().register(entity({ fields: {} as never }), table, columns))
      .toThrow(/must declare fields/)
  })

  it("rejects a column map missing declared fields and lists them", () => {
    const { version: _version, ...partial } = columns
    expect(() => new DrizzleEntityRegistry().register(entity(), table, partial))
      .toThrow(new ConfigurationError("Entity \"registryRow\" column map is missing fields: version."))
  })

  it("rejects an empty column map key", () => {
    expect(() => new DrizzleEntityRegistry().register(entity(), table, { ...columns, "": table.id }))
      .toThrow(/empty column map key/)
  })

  it("rejects duplicate registration with the same key", () => {
    const registry = new DrizzleEntityRegistry()
    registry.register(entity(), table, columns)
    expect(() => registry.register(entity(), table, columns))
      .toThrow(new ConfigurationError("Entity \"registryRow\" is already registered in the Drizzle entity registry."))
    registry.register(entity(), table, columns, "tenant-1")
    expect(() => registry.register(entity(), table, columns, "tenant-1")).toThrow(/already registered/)
  })

  it("rejects an unknown primary key", () => {
    expect(() => new DrizzleEntityRegistry().register(entity({ primaryKey: "missing" as never }), table, columns))
      .toThrow(/primary key "missing" is not a declared field/)
  })

  it("rejects an undeclared version field", () => {
    expect(() => new DrizzleEntityRegistry().register(entity({ versionField: "missing" as never }), table, columns))
      .toThrow(/version field "missing" is not a declared field/)
  })
})
