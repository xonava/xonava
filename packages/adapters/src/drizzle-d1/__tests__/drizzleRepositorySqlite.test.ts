import { beforeEach, describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ConfigurationError, ConflictError, NotFoundError, OptimisticConcurrencyError, Predicate, ValidationError } from "@xonava/core/domain"
import { createDrizzleD1Adapter, createDrizzleRepository } from "@xonava/adapters/drizzle-d1"
import type { DrizzleColumnMap } from "@xonava/adapters/drizzle-d1"
import { createFakeD1, type FakeD1 } from "../../__tests__/support/fakeD1"

const widgets = sqliteTable("widgets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  score: integer("score"),
  status: text("status"),
  version: integer("version").notNull(),
  createdAt: integer("created_at"),
})
const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
})

const SCHEMA = [
  "CREATE TABLE widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, score INTEGER, status TEXT, version INTEGER NOT NULL, created_at INTEGER)",
  "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)",
]

const widgetColumns = { id: widgets.id, name: widgets.name, score: widgets.score, status: widgets.status, version: widgets.version, createdAt: widgets.createdAt } satisfies DrizzleColumnMap
const widgetEntity = {
  name: "widget",
  primaryKey: "id",
  versionField: "version",
  fields: { id: { type: "string" }, name: { type: "string" }, score: { type: "number", nullable: true }, status: { type: "string", nullable: true }, version: { type: "number" }, createdAt: { type: "number", nullable: true } },
} as const
const noteEntity = { name: "note", primaryKey: "id", fields: { id: { type: "string" }, body: { type: "string" } } } as const

let d1: FakeD1
const session = () => createDrizzleD1Adapter(drizzle(d1 as never) as never).repository
const widgetRepo = (extra: Record<string, unknown> = {}) =>
  createDrizzleRepository({ db: session(), table: widgets, entity: widgetEntity as never, columnMap: widgetColumns, ...extra }) as unknown as Record<string, (...args: unknown[]) => Promise<any>>
const noteRepo = () =>
  createDrizzleRepository({ db: session(), table: notes, entity: noteEntity as never, columnMap: { id: notes.id, body: notes.body } }) as unknown as Record<string, (...args: unknown[]) => Promise<any>>

const seed = async () => {
  const repo = widgetRepo()
  await repo.insert!({ id: "w1", name: "alpha", score: 10, status: "open", version: 1, createdAt: 1 })
  await repo.insert!({ id: "w2", name: "bravo", score: 20, status: "open", version: 1, createdAt: 2 })
  await repo.insert!({ id: "w3", name: "charlie", score: null, status: "closed", version: 1, createdAt: 3 })
  return repo
}
const rowsOf = (sql: string) => d1.sqlite.prepare(sql).all() as Record<string, unknown>[]

beforeEach(() => { d1 = createFakeD1(SCHEMA) })

describe("D1 repository against a real SQLite engine: reads", () => {
  it("finds by id and by predicate, returning null for misses", async () => {
    const repo = await seed()
    expect((await repo.findById!("w2"))?.name).toBe("bravo")
    expect(await repo.findById!("missing")).toBeNull()
    expect((await repo.findOneWhere!(Predicate.eq("name", "charlie")))?.id).toBe("w3")
    expect(await repo.findOneWhere!(Predicate.eq("name", "zulu"))).toBeNull()
    await expect(repo.findOneWhere!(undefined)).rejects.toBeInstanceOf(ValidationError)
  })

  it("lists with a filter, explicit sort, projection and offset pagination", async () => {
    const repo = await seed()
    const result = await repo.findMany!({
      filter: Predicate.eq("status", "open"),
      sort: [{ field: "score", direction: "desc" }],
      projection: { fields: ["id", "score"] },
      pagination: { kind: "offset", page: 1, pageSize: 1 },
    })
    expect(result.rowCount).toBe(2)
    expect(result.rows).toEqual([{ id: "w2", score: 20 }])
    expect(result.pageSize).toBe(1)
    const second = await repo.findMany!({ filter: Predicate.eq("status", "open"), sort: [{ field: "score", direction: "desc" }], pagination: { kind: "offset", page: 2, pageSize: 1 } })
    expect(second.rows.map((row: { id: string }) => row.id)).toEqual(["w1"])
  })

  it("defaults the order to created_at then primary key when no sort is given", async () => {
    const repo = await seed()
    const result = await repo.findMany!()
    expect(result.rows.map((row: { id: string }) => row.id)).toEqual(["w1", "w2", "w3"])
    expect(result.rowCount).toBe(3)
  })

  it("honours explicit NULLS ordering", async () => {
    const repo = await seed()
    const first = await repo.findMany!({ sort: [{ field: "score", direction: "asc", nulls: "first" }] })
    expect(first.rows.map((row: { id: string }) => row.id)).toEqual(["w3", "w1", "w2"])
    const last = await repo.findMany!({ sort: [{ field: "score", direction: "desc", nulls: "last" }] })
    expect(last.rows.map((row: { id: string }) => row.id)).toEqual(["w2", "w1", "w3"])
  })

  it("rejects unknown sort and projection fields", async () => {
    const repo = await seed()
    await expect(repo.findMany!({ sort: [{ field: "nope", direction: "asc" }] })).rejects.toBeInstanceOf(ValidationError)
    await expect(repo.findMany!({ projection: { fields: ["nope"] } })).rejects.toBeInstanceOf(ValidationError)
  })

  it("rejects unsupported read consistency and cursor pagination without a sort", async () => {
    const repo = await seed()
    await expect(repo.findMany!({ consistency: "eventual" })).rejects.toBeInstanceOf(Error)
    await expect(repo.findMany!({ pagination: { kind: "cursor", direction: "after", limit: 2 } })).rejects.toThrow("cursor pagination requires an explicit stable sort")
  })

  it("walks keyset cursor pages forward and backward with page info", async () => {
    const repo = await seed()
    const sort = [{ field: "score", direction: "asc" as const, nulls: "last" as const }, { field: "id", direction: "asc" as const }]
    const page1 = await repo.findMany!({ sort, pagination: { kind: "cursor", direction: "after", limit: 2 } })
    expect(page1.rows.map((row: { id: string }) => row.id)).toEqual(["w1", "w2"])
    expect(page1.pageInfo).toEqual({ kind: "cursor", hasNextPage: true, hasPreviousPage: false })
    const page2 = await repo.findMany!({ sort, pagination: { kind: "cursor", direction: "after", limit: 2, values: [20, "w2"] } })
    expect(page2.rows.map((row: { id: string }) => row.id)).toEqual(["w3"])
    expect(page2.pageInfo).toEqual({ kind: "cursor", hasNextPage: false, hasPreviousPage: true })
    const back = await repo.findMany!({ filter: Predicate.isNotNull("status"), sort, pagination: { kind: "cursor", direction: "before", limit: 2, values: [null, "w3"] } })
    expect(back.rows.map((row: { id: string }) => row.id)).toEqual(["w1", "w2"])
  })

  it("clamps pageSize to maxPageSize and rejects offsets beyond maxOffset", async () => {
    await seed()
    const repo = widgetRepo({ maxPageSize: 2, maxOffset: 1 })
    const clamped = await repo.findMany!({ pagination: { kind: "offset", page: 1, pageSize: 3 } })
    expect(clamped.pageSize).toBe(2)
    expect(clamped.rows).toHaveLength(2)
    await expect(repo.findMany!({ pagination: { kind: "offset", page: 5, pageSize: 2 } })).rejects.toBeInstanceOf(ValidationError)
  })

  it("validates configuration at construction", () => {
    expect(() => widgetRepo({ maxPageSize: 0 })).toThrow(ConfigurationError)
    expect(() => widgetRepo({ maxOffset: -1 })).toThrow(ConfigurationError)
    expect(() => createDrizzleRepository({ db: session(), table: widgets, entity: widgetEntity as never, columnMap: { name: widgets.name } })).toThrow(/primary key/)
  })
})

describe("D1 repository against a real SQLite engine: writes", () => {
  it("inserts a versioned row, maps unique violations to ConflictError and refuses an invalid supplied version", async () => {
    const repo = await seed()
    const created = await repo.insert!({ id: "w9", name: "india", score: 1, status: "open", version: 1, createdAt: 9 })
    expect(created).toMatchObject({ id: "w9", version: 1 })
    await expect(repo.insert!({ id: "w10", name: "alpha", score: 1, status: "open", version: 1, createdAt: 9 })).rejects.toBeInstanceOf(ConflictError)
    await expect(repo.insert!({ id: "w11", name: "x", version: 1.5 })).rejects.toBeInstanceOf(Error)
    expect(rowsOf("SELECT id FROM widgets WHERE id IN ('w10','w11')")).toEqual([])
  })

  it("fails an insert that omits the primary key after the write", async () => {
    await expect(noteRepo().insert!({ body: "x" })).rejects.toBeInstanceOf(Error)
  })

  it("updates with optimistic concurrency and increments the version in the database", async () => {
    const repo = await seed()
    const updated = await repo.update!("w1", { status: "closed" }, { optimisticConcurrency: { expectedVersion: 1 } })
    expect(updated).toMatchObject({ id: "w1", status: "closed", version: 2 })
    await expect(repo.update!("w1", { status: "open" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(repo.update!("nope", { status: "open" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    expect(rowsOf("SELECT version FROM widgets WHERE id = 'w1'")).toEqual([{ version: 2 }])
  })

  it("requires an expected version for versioned updates and refuses framework-managed fields", async () => {
    const repo = await seed()
    await expect(repo.update!("w1", { status: "closed" })).rejects.toBeInstanceOf(Error)
    await expect(repo.updateOneWhere!(Predicate.eq("id", "w1"), { version: 7 }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(Error)
  })

  it("updateOneWhere updates exactly one row, reports zero for misses and rejects multi-row matches", async () => {
    const repo = await seed()
    await expect(repo.updateOneWhere!(Predicate.eq("status", "open"), { score: 1 }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ValidationError)
    await expect(repo.updateOneWhere!(Predicate.eq("name", "zulu"), { score: 1 }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(repo.updateOneWhere!(Predicate.eq("name", "alpha"), { score: 99 }, { optimisticConcurrency: { expectedVersion: 4 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    expect(await repo.updateOneWhere!(Predicate.eq("name", "alpha"), { score: 99 }, { optimisticConcurrency: { expectedVersion: 1 } })).toEqual({ updatedCount: 1 })
    expect(rowsOf("SELECT score, version FROM widgets WHERE id = 'w1'")).toEqual([{ score: 99, version: 2 }])
  })

  it("updateOneWhereReturning returns the new row or null and enforces the same guards", async () => {
    const repo = await seed()
    const row = await repo.updateOneWhereReturning!(Predicate.eq("name", "bravo"), { status: "archived" }, { optimisticConcurrency: { expectedVersion: 1 } })
    expect(row).toMatchObject({ id: "w2", status: "archived", version: 2 })
    await expect(repo.updateOneWhereReturning!(Predicate.eq("status", "open"), { score: 1 }, { optimisticConcurrency: { expectedVersion: 1 } })).resolves.toMatchObject({ id: "w1" })
    await expect(repo.updateOneWhereReturning!(Predicate.eq("name", "zulu"), { score: 1 }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(repo.updateOneWhereReturning!(Predicate.eq("name", "alpha"), { score: 1 }, { optimisticConcurrency: { expectedVersion: 9 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(repo.updateOneWhereReturning!(Predicate.or(Predicate.eq("id", "w1"), Predicate.eq("id", "w3")), { score: 1 }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ValidationError)
    await expect(repo.updateOneWhereReturning!(Predicate.alwaysTrue(), { score: 1 }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(repo.updateOneWhereReturning!(undefined, { score: 1 }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ValidationError)
  })

  it("unversioned updateOneWhere returns counts and update(id) reports missing rows as NotFoundError", async () => {
    const repo = noteRepo()
    await repo.insert!({ id: "n1", body: "a" })
    expect(await repo.updateOneWhere!(Predicate.eq("id", "n1"), { body: "b" })).toEqual({ updatedCount: 1 })
    expect(await repo.updateOneWhere!(Predicate.eq("id", "none"), { body: "b" })).toEqual({ updatedCount: 0 })
    await expect(repo.update!("none", { body: "c" })).rejects.toBeInstanceOf(NotFoundError)
    expect((await repo.update!("n1", { body: "z" })).body).toBe("z")
    expect(await repo.updateOneWhereReturning!(Predicate.eq("id", "none"), { body: "q" })).toBeNull()
  })

  it("delete honours optimistic concurrency, idempotent deletes and missing rows", async () => {
    const repo = await seed()
    await expect(repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 7 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(repo.delete!("ghost", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(NotFoundError)
    await expect(repo.delete!("ghost", { idempotent: true, optimisticConcurrency: { expectedVersion: 1 } })).resolves.toBeUndefined()
    await repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 1 } })
    expect(rowsOf("SELECT id FROM widgets WHERE id = 'w1'")).toEqual([])
    await expect(repo.delete!("w1", { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(NotFoundError)
    await expect(repo.delete!("w2")).rejects.toBeInstanceOf(Error)
  })

  it("unversioned delete removes the row, 404s on repeat and tolerates idempotent repeats", async () => {
    const repo = noteRepo()
    await repo.insert!({ id: "n1", body: "a" })
    await repo.delete!("n1")
    await expect(repo.delete!("n1")).rejects.toBeInstanceOf(NotFoundError)
    await expect(repo.delete!("n1", { idempotent: true })).resolves.toBeUndefined()
  })

  it("deleteWhere counts deletions, guards all-row deletes and distinguishes OCC mismatches from misses", async () => {
    const repo = await seed()
    await expect(repo.deleteWhere!(undefined)).rejects.toBeInstanceOf(ValidationError)
    await expect(repo.deleteWhere!(Predicate.alwaysTrue(), { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(ConfigurationError)
    await expect(repo.deleteWhere!(Predicate.eq("name", "alpha"), { optimisticConcurrency: { expectedVersion: 5 } })).rejects.toBeInstanceOf(OptimisticConcurrencyError)
    await expect(repo.deleteWhere!(Predicate.eq("name", "zulu"), { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toBeInstanceOf(NotFoundError)
    expect(await repo.deleteWhere!(Predicate.eq("status", "open"), { optimisticConcurrency: { expectedVersion: 1 } })).toEqual({ deletedCount: 2 })
    expect(rowsOf("SELECT id FROM widgets")).toEqual([{ id: "w3" }])
  })

  it("unversioned deleteWhere returns zero without raising for misses", async () => {
    const repo = noteRepo()
    await repo.insert!({ id: "n1", body: "a" })
    expect(await repo.deleteWhere!(Predicate.eq("id", "none"))).toEqual({ deletedCount: 0 })
    expect(await repo.deleteWhere!(Predicate.eq("id", "n1"))).toEqual({ deletedCount: 1 })
    expect(repo.updateManyWhere).toBeUndefined
  })

  it("exposes no updateManyWhere for versioned entities", () => {
    expect(widgetRepo().updateManyWhere).toBeUndefined()
  })
})
