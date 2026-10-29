import { describe, expect, it } from "vitest"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Predicate } from "@xonava/core/domain"
import { createDrizzleRepository } from "../drizzleRepository"
import { createScriptedDb } from "../../__tests__/support/scriptedDb"

const widgets = sqliteTable("widgets", { id: text("id").primaryKey(), name: text("name").notNull(), version: integer("version").notNull() })
const norm = (sql: string | undefined) => (sql ?? "").replace(/\s+/g, " ")

describe("d1 repository default predicate compiler", () => {
  it("compiles text predicates for SQLite without LIKE patterns", async () => {
    const scripted = createScriptedDb("sqlite", () => [])
    const repo = createDrizzleRepository({
      db: scripted.db as never, table: widgets as never, entity: { name: "widget", primaryKey: "id", fields: {} } as never,
      columnMap: { id: widgets.id, name: widgets.name, version: widgets.version } as never,
    }) as unknown as { findOneWhere(filter: unknown): Promise<unknown> }
    await repo.findOneWhere(Predicate.contains("name", "a%"))
    await repo.findOneWhere(Predicate.startsWith("name", "a"))
    expect(norm(scripted.ops[0]!.where!.sql)).toBe('(instr("widgets"."name", ?) > 0)')
    expect(scripted.ops[0]!.where!.params).toEqual(["a%"])
    expect(norm(scripted.ops[1]!.where!.sql)).toBe('(substr("widgets"."name", 1, length(?)) = ?)')
    expect(scripted.ops[1]!.where!.params).toEqual(["a", "a"])
  })
})
