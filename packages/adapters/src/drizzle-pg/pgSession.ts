import type { AnyPgTable, PgDatabase, PgTransaction } from "drizzle-orm/pg-core"
import type { DrizzleSessionLike, DrizzleUpdateResult } from "./drizzleRepository"
import { getAffectedRows } from "./pgUtils"

/**
 * Wraps a real Drizzle node-postgres database into the DrizzleSessionLike interface
 * that drizzleRepository.ts consumes. This is the boundary between the
 * generic repository adapter and a local PostgreSQL connection.
 *
 * Postgres returns { rowCount: number } for UPDATE/DELETE, unlike D1's { meta: { changes } }.
 * Postgres supports .returning() on INSERT, UPDATE, and DELETE.
 */

// Drizzle's query-result HKT varies by PostgreSQL driver, so this is the
// narrowest driver-neutral boundary for sessions and transaction scopes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PgDatabaseLike = PgDatabase<any, any, any> | PgTransaction<any, any, any>

export function createPgSession(db: PgDatabaseLike): DrizzleSessionLike {
  return {
    async atomicJobTransition(args) {
      return db.transaction(async (tx) => {
        const session = createPgSession(tx)
        const result = await session.update(args.updateTable).set(args.updateSet).where(args.updateWhere)
        // node-postgres reports `rowCount`, not `affectedRows`; a fenced-out
        // transition must never write history or report applied.
        if (getAffectedRows(result) === 0) return { applied: false, historyId: args.historyValues.id as string }
        await session.insert(args.historyTable).values(args.historyValues)
        await session.update(args.updateTable).set({ claimToken: null }).where(args.historyWhere)
        return { applied: true, historyId: args.historyValues.id as string }
      })
    },
    select(...args: unknown[]) {
      const selectFn = args.length > 0
        // Drizzle's overloaded select signature cannot accept the session's untyped argument list directly.
        ? db.select(args[0] as Parameters<typeof db.select>[0])
        : db.select()

      return {
        from(table: AnyPgTable) {
          const fromBuilder = (selectFn as { from(t: AnyPgTable): unknown }).from(table)
          return {
            where(whereClause: unknown) {
              const whereBuilder = (fromBuilder as { where(w: unknown): unknown }).where(whereClause)
              return {
                limit(n: number) {
                  return (whereBuilder as { limit(n: number): Promise<unknown[]> }).limit(n)
                },
                orderBy(orderBy: unknown) {
                  return {
                    limit(n: number) {
                      return {
                        offset(o: number) {
                          return ((whereBuilder as { orderBy(o: unknown): { limit(n: number): { offset(o: number): Promise<unknown[]> } } })
                            .orderBy(orderBy).limit(n).offset(o))
                        },
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

    insert(table: AnyPgTable) {
      const insertBuilder = db.insert(table) as {
        values(d: unknown): Promise<unknown> & {
          onConflictDoNothing(config?: { target: unknown[] }): Promise<unknown> & { returning<R>(columns?: unknown): Promise<R[]> }
          returning<R>(columns?: unknown): Promise<R[]>
        }
      }
      return {
        values(data: unknown) {
          const valuesBuilder = insertBuilder.values(data)
          return valuesBuilder
        },
      }
    },

    update(table: AnyPgTable) {
      return {
        set(data: unknown) {
          const setBuilder = (db.update(table) as {
            set(d: unknown): {
              where(w: unknown): Promise<DrizzleUpdateResult> & { returning<R>(columns?: unknown): Promise<R[]> }
            }
          }).set(data)
          return {
            where(whereClause: unknown) {
              const whereResult = setBuilder.where(whereClause)
              return whereResult
            },
          }
        },
      }
    },

    delete(table: AnyPgTable) {
      return {
        where(whereClause: unknown) {
          const deleteResult = (db.delete(table) as {
            where(w: unknown): Promise<DrizzleUpdateResult> & { returning<R>(columns?: unknown): Promise<R[]> }
          }).where(whereClause)
          return deleteResult
        },
      }
    },
  }
}
