import { pgTable, integer, text } from "drizzle-orm/pg-core"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import { sql, type AnyColumn, type SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, Predicate, ValidationError } from "@xonava/core/domain"
import { createDrizzlePersistenceProvider, createDrizzleRepository, type DrizzleSessionLike, DrizzleEntityRegistry, type PgDatabaseLike } from "@xonava/adapters/drizzle-pg"

const table = pgTable("pagination_rows", { id: text("id").primaryKey(), name: text("name"), version: integer("version") })
const entity = { name: "pagination", primaryKey: "id", fields: { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } } } as const
const columnMap = { id: table.id, name: table.name, version: table.version }
const invalidPaginationValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 0, -1]
const invalidRequestValues = [...invalidPaginationValues, Number.MAX_SAFE_INTEGER + 1]

function session(): DrizzleSessionLike {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          // A COUNT (only when a total is requested) ends in limit(); the page query goes through orderBy().
          return { limit: vi.fn(async () => [{ count: 5 }]), orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ offset: vi.fn(async () => []) })) })) }
        }),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => Object.assign(Promise.resolve([]), { returning: async () => [] })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Object.assign(Promise.resolve([]), { returning: async () => [] })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => Object.assign(Promise.resolve([]), { returning: async () => [] })) })),
  } as unknown as DrizzleSessionLike
}

describe("PostgreSQL pagination boundaries", () => {
  it.each(invalidPaginationValues)("rejects invalid maxPageSize %s", (value) => {
    expect(() => createDrizzlePersistenceProvider({
      db: { transaction: vi.fn() } as unknown as PgDatabaseLike,
      registry: new DrizzleEntityRegistry(),
      limits: { maxPageSize: value },
    })).toThrow(new ConfigurationError("PostgreSQL maxPageSize must be a finite positive integer"))
  })

  it("rejects invalid request values and clamps valid oversized pageSize", async () => {
    const repository = createDrizzleRepository({ db: session(), table, entity, columnMap, maxPageSize: 3 })
    for (const value of invalidRequestValues) {
      await expect(repository.findMany({ pagination: { kind: "offset", page: value, pageSize: 1 } })).rejects.toEqual(new ValidationError("page must be a finite positive integer"))
      await expect(repository.findMany({ pagination: { kind: "offset", page: 1, pageSize: value } })).rejects.toEqual(new ValidationError("pageSize must be a finite positive integer"))
    }
    await expect(repository.findMany({ pagination: { kind: "offset", page: 2, pageSize: 99 } })).resolves.toMatchObject({ page: 2, pageSize: 3 })
  })

  it("rejects an offset that exceeds the safe integer range", async () => {
    const repository = createDrizzleRepository({ db: session(), table, entity, columnMap })
    await expect(repository.findMany({ pagination: { kind: "offset", page: Number.MAX_SAFE_INTEGER, pageSize: 2 } }))
      .rejects.toEqual(new ValidationError("pagination offset exceeds the maximum safe integer"))
  })

  it("rejects an offset above the configured resource budget", async () => {
    const repository = createDrizzleRepository({ db: session(), table, entity, columnMap, maxOffset: 3 })
    await expect(repository.findMany({ pagination: { kind: "offset", page: 3, pageSize: 2 } }))
      .rejects.toEqual(new ValidationError("pagination offset exceeds the configured maximum of 3"))
  })

  async function capturedOrderBy(options: Parameters<ReturnType<typeof createDrizzleRepository>["findMany"]>[0]): Promise<string> {
    let orderBy: unknown
    const db = session()
    const originalSelect = db.select
    db.select = vi.fn(() => {
      const builder = originalSelect()
      const from = builder.from
      builder.from = vi.fn(() => {
        const whereBuilder = from(table)
        const where = whereBuilder.where
        whereBuilder.where = vi.fn(() => {
          const result = where(undefined)
          if ("orderBy" in result) {
            const originalOrderBy = result.orderBy
            result.orderBy = vi.fn((value: SQL<unknown> | AnyColumn) => {
              orderBy = value
              return originalOrderBy(value)
            })
          }
          return result
        })
        return whereBuilder
      })
      return builder
    })
    await createDrizzleRepository({ db, table, entity, columnMap }).findMany(options)
    return new PgDialect().sqlToQuery(orderBy as SQL<unknown>).sql
  }

  it("appends the primary key to non-unique sorts and keeps offset pages index-friendly", async () => {
    // Offset pages only need a deterministic order: native column order keeps index scans.
    expect(await capturedOrderBy({ sort: [{ field: "name", direction: "desc" }] })).toBe('"pagination_rows"."name" desc, "pagination_rows"."id" desc')
  })

  it("orders cursor pages exactly like keyset predicates compare (code-point text)", async () => {
    // Text sort keys, including the text primary-key tie breaker, order under COLLATE "C" like the cursor predicate.
    expect(await capturedOrderBy({ sort: [{ field: "name", direction: "desc" }], pagination: { kind: "cursor", direction: "after", limit: 2 } }))
      .toBe('("pagination_rows"."name" COLLATE "C") desc, ("pagination_rows"."id" COLLATE "C") desc')
  })

  it("accepts a plain predicate compiler that only implements compile", async () => {
    // Regression: repositories required compileWhere.
    const compile = vi.fn(() => sql`1 = 1`)
    const repository = createDrizzleRepository({ db: session(), table, entity, columnMap, predicateCompiler: { compile } })
    await repository.findMany({ filter: Predicate.eq("name", "x") })
    expect(compile).toHaveBeenCalled()
  })
})
