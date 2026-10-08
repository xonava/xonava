import type { DrizzleD1Database } from "drizzle-orm/d1"
import { getTableColumns, is, sql, SQL, type AnyColumn, type SQLChunk } from "drizzle-orm"
import { ConfigurationError } from "core/domain"
import { SQLiteAsyncDialect, type AnySQLiteTable } from "drizzle-orm/sqlite-core"
import type { DrizzleSessionLike, DrizzleUpdateResult } from "./drizzleRepository"
import { d1DriverValue, getAffectedRows } from "./d1Utils"

interface D1BindingLike {
  prepare(query: string): { bind(...values: unknown[]): unknown }
  batch(statements: unknown[]): Promise<unknown[]>
}

const D1_DIALECT = new SQLiteAsyncDialect()

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
      // historyValues are keyed by the history table's TypeScript property
      // keys. The INSERT … SELECT is emitted with explicit physical column
      // names so only supplied columns are written (defaults still apply),
      // and every bound value is driver-encoded: D1 rejects object bindings,
      // so Dates become epoch milliseconds (or the column's own encoding).
      const historyColumns = getTableColumns(args.historyTable) as Record<string, AnyColumn>
      const targets: SQLChunk[] = []
      const selections: SQL[] = []
      for (const [key, value] of Object.entries(args.historyValues)) {
        const column = historyColumns[key]
        if (!column) throw new ConfigurationError("Execution history value does not match a history table column")
        targets.push(sql.identifier(column.name))
        selections.push(is(value, SQL) ? value : sql`${d1DriverValue(column, value)}`)
      }
      const historySql = sql`insert into ${args.historyTable} (${sql.join(targets, sql`, `)}) select ${sql.join(selections, sql`, `)} from ${args.updateTable} where ${args.historyWhere ?? sql`0`}`
      const update = db.update(args.updateTable).set(args.updateSet as Record<string, unknown>).where(args.updateWhere)
      const clear = db.update(args.updateTable).set({ claimToken: null }).where(args.historyWhere)
      // Drizzle's D1 batch cannot carry a parameterized raw statement, so the
      // three statements are bound directly against the D1 binding; D1 runs a
      // batch as one implicit transaction.
      const client = (db as unknown as { $client?: D1BindingLike }).$client
      if (!client || typeof client.batch !== "function") throw new ConfigurationError("D1 atomic job transitions require the D1 binding")
      const bind = (query: { sql: string; params: unknown[] }) => client.prepare(query.sql).bind(...query.params)
      const results = await client.batch([bind(update.toSQL()), bind(D1_DIALECT.sqlToQuery(historySql)), bind(clear.toSQL())])
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
