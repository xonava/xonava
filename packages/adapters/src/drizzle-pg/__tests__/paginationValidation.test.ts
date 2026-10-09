import { pgTable, integer, text } from "drizzle-orm/pg-core"
import { PgDialect } from "drizzle-orm/pg-core/dialect"
import type { AnyColumn, SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, ValidationError } from "core/domain"
import { createDrizzlePersistenceProvider, createDrizzleRepository, type DrizzleSessionLike, DrizzleEntityRegistry, type PgDatabaseLike } from "adapters/drizzle-pg"

const table = pgTable("pagination_rows", { id: text("id").primaryKey(), name: text("name"), version: integer("version") })
const entity = { name: "pagination", primaryKey: "id", fields: { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } } } as const
const columnMap = { id: table.id, name: table.name, version: table.version }
const invalidPaginationValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 0, -1]
const invalidRequestValues = [...invalidPaginationValues, Number.MAX_SAFE_INTEGER + 1]

function session(): DrizzleSessionLike {
  let selectCount = 0
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          selectCount += 1
          if (selectCount === 1) return { limit: vi.fn(async () => [{ count: 5 }]) }
          return { orderBy: vi.fn(() => ({ limit: vi.fn(() => ({ offset: vi.fn(async () => []) })) })) }
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

  it("appends the primary key to non-unique sorts", async () => {
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

    await createDrizzleRepository({ db, table, entity, columnMap }).findMany({ sort: [{ field: "name", direction: "desc" }] })
    // Text sort keys (including the text primary-key tie breaker) order by code point, like keyset predicates.
    expect(new PgDialect().sqlToQuery(orderBy as SQL<unknown>).sql).toBe('("pagination_rows"."name" COLLATE "C") desc, ("pagination_rows"."id" COLLATE "C") desc')
  })
})
