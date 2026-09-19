import type { DrizzleD1Database } from "drizzle-orm/d1"
import { sql } from "drizzle-orm"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import type { DrizzleSessionLike, DrizzleUpdateResult } from "./drizzleRepository"
import { getAffectedRows } from "./d1Utils"

export interface DrizzleD1Adapter {
  readonly raw: DrizzleD1Database<Record<string, never>>
  readonly repository: DrizzleSessionLike
}

/**
 * Wraps a real Drizzle D1 database into the DrizzleSessionLike interface
 * that drizzleRepository.ts consumes. This is the boundary between the
 * generic repository adapter and a production D1 binding.
 *
 * Uses as-casts at the adapter boundary — this is acceptable because
 * the DrizzleSessionLike interface already types the repository internals.
 */
export function createDrizzleSession(db: DrizzleD1Database<Record<string, never>>): DrizzleSessionLike {
  return {
    async atomicJobTransition(args) {
      const historySelect = Object.fromEntries(Object.keys(args.historyValues).map((key) => [
        key,
        sql`${args.historyValues[key]}`,
      ]))
      const history = db.insert(args.historyTable).select(
        db.select(historySelect).from(args.updateTable).where(args.historyWhere),
      )
       const update = db.update(args.updateTable).set(args.updateSet as Record<string, unknown>).where(args.updateWhere)
       const clear = db.update(args.updateTable).set({ claimToken: null }).where(args.historyWhere)
      const results = await db.batch([update, history, clear] as never)
      const updateResult = results[0] as { meta?: { changes?: number } }
      return { applied: (updateResult.meta?.changes ?? 0) > 0, historyId: args.historyValues.id as string }
    },
    select(...args: unknown[]) {
      const selectFn = args.length > 0
        ? (db.select as (...a: unknown[]) => ReturnType<typeof db.select>)(args[0])
        : db.select()

      return {
        from(table: AnySQLiteTable) {
          const fromBuilder = selectFn.from(table) as {
            where: (w: unknown) => {
              limit: (n: number) => Promise<unknown[]>
              orderBy: (o: unknown) => {
                limit: (n: number) => {
                  offset: (o: number) => Promise<unknown[]>
                }
              }
            }
          }
          return {
            where(whereClause: unknown) {
              const whereBuilder = fromBuilder.where(whereClause)
              return {
                limit(n: number) { return whereBuilder.limit(n) },
                orderBy(orderBy: unknown) {
                  return {
                    limit(n: number) {
                      return {
                        offset(o: number) { return whereBuilder.orderBy(orderBy).limit(n).offset(o) },
                      }
                    },
                  }
                },
              }
            },
          }
        },
      }
    },

    insert(table: AnySQLiteTable) {
      return {
        values(data: unknown) {
          return (db.insert as (t: AnySQLiteTable) => { values: (d: unknown) => unknown })(table).values(data)
        },
      }
    },

    async updateReturning(table: AnySQLiteTable, data: unknown, whereClause: unknown): Promise<unknown[]> {
      return await db.update(table).set(data as Record<string, unknown>).where(whereClause as never).returning()
    },

    update(table: AnySQLiteTable) {
      return {
        set(data: unknown) {
          return {
            async where(whereClause: unknown): Promise<DrizzleUpdateResult> {
              const result: unknown = await db.update(table).set(data as Record<string, unknown>).where(whereClause as never)
              return { affectedRows: getAffectedRows(result) }
            },
          }
        },
      }
    },

    delete(table: AnySQLiteTable) {
      return {
        async where(whereClause: unknown): Promise<DrizzleUpdateResult> {
          const result: unknown = await db.delete(table).where(whereClause as never)
          return { affectedRows: getAffectedRows(result) }
        },
      }
    },
  }
}

export function createDrizzleD1Adapter(db: DrizzleD1Database<Record<string, never>>): DrizzleD1Adapter {
  return { raw: db, repository: createDrizzleSession(db) }
}
