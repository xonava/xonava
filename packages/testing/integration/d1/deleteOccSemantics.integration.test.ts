import { afterAll, beforeAll, describe } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleRepository } from "@xonava/adapters/drizzle-d1"
import type { VersionedEntityDescriptor } from "@xonava/core/persistence"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { defineDeleteOccSemantics, type OccItem, type OccRepository } from "../shared/deleteOccSemantics.js"

const items = sqliteTable("df_delete_occ_items", { id: text("id").primaryKey(), name: text("name").notNull(), version: integer("version").notNull() })
const entity: VersionedEntityDescriptor<OccItem> = { name: "items", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } } }

describe("D1 delete with optimistic concurrency", () => {
  let fixture: D1Fixture
  let repo: OccRepository
  beforeAll(async () => {
    fixture = await openD1Fixture()
    await fixture.db.exec("CREATE TABLE df_delete_occ_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL)")
    repo = createDrizzleRepository<OccItem>({ db: drizzle(fixture.db as never) as never, table: items, entity, columnMap: { id: items.id, name: items.name, version: items.version } as never }) as unknown as OccRepository
  })
  afterAll(async () => { await fixture?.close() })
  defineDeleteOccSemantics({ label: "d1", repo: () => repo, reset: async () => { await fixture.db.exec("DELETE FROM df_delete_occ_items") }, bump: async (id) => { await fixture.db.prepare("UPDATE df_delete_occ_items SET version = version + 1 WHERE id = ?").bind(id).run() } })
})
