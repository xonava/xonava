import { integer, SQLiteSyncDialect, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { AnyColumn, SQL } from "drizzle-orm"
import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, ValidationError } from "core/domain"
import { createDrizzlePersistenceProvider, createDrizzleRepository, type DrizzleSessionLike, DrizzleEntityRegistry } from "adapters/drizzle-d1"
import type { DrizzleD1Database } from "drizzle-orm/d1"

const table = sqliteTable("pagination_rows", { id: text("id").primaryKey(), name: text("name"), version: integer("version") })
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
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => ({ affectedRows: 1 })) })),
  } as unknown as DrizzleSessionLike
}

describe("D1 pagination boundaries", () => {
  it.each(invalidPaginationValues)("rejects invalid maxPageSize %s", (value) => {
    expect(() => createDrizzlePersistenceProvider({
      db: { batch: vi.fn() } as unknown as DrizzleD1Database<Record<string, never>>,
      registry: new DrizzleEntityRegistry(),
      limits: { maxPageSize: value },
    })).toThrow(new ConfigurationError("D1 maxPageSize must be a finite positive integer"))
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
    expect(new SQLiteSyncDialect().sqlToQuery(orderBy as SQL<unknown>).sql).toContain('"pagination_rows"."id" desc')
  })
})
