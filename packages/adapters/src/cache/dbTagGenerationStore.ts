import { sql } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import type { AnyPgTable, PgDatabase, PgTransaction } from "drizzle-orm/pg-core"
import { CacheAdapterError } from "@xonava/core/cache"

/**
 * A single shared atomic counter table in the application DB (D1 or
 * PostgreSQL) whose increment is one serializable statement. This is the
 * genuinely linearizable generation source that the eventual KV generations
 * and process-local in-memory generations cannot provide.
 *
 * Expected table shape (migrations are owned by the app workstream):
 *   - `tag`        text/varchar, primary key
 *   - `generation` integer
 */
export interface TagGenerationStore {
  getTagGeneration: (tag: string) => Promise<string>
  advanceTagGeneration: (tag: string) => Promise<string>
}

// The narrow driver-neutral boundary between D1 and PostgreSQL, mirroring the
// PgDatabaseLike approach used by the repo's drizzle sessions.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDrizzleDatabase = PgDatabase<any, any, any> | PgTransaction<any, any, any> | DrizzleD1Database<any>

// Loose structural view of the drizzle builder chain the store needs. The
// real databases satisfy this shape at runtime; the casts at this boundary
// are deliberate and consistent with the existing drizzle adapters.
interface LooseDrizzleDb {
  select(): {
    from(table: unknown): {
      where(where: unknown): {
        limit(n: number): Promise<unknown[]>
      }
    }
  }
  insert(table: unknown): {
    values(data: unknown): {
      onConflictDoUpdate(options: unknown): {
        returning(columns?: unknown): Promise<unknown[]>
      }
    }
  }
}

interface LooseGenerationTable {
  tag: unknown
  generation: unknown
}

interface GenerationRow {
  generation?: unknown
}

export class DbTagGenerationStore implements TagGenerationStore {
  constructor(
    private readonly db: AnyDrizzleDatabase,
    private readonly table: AnySQLiteTable | AnyPgTable,
  ) {}

  async getTagGeneration(tag: string): Promise<string> {
    const rows = await (this.db as unknown as LooseDrizzleDb)
      .select()
      .from(this.table)
      .where(sql`tag = ${tag}`)
      .limit(1)
    const row = rows[0] as GenerationRow | undefined
    return row && typeof row.generation === "number" ? String(row.generation) : "0"
  }

  async advanceTagGeneration(tag: string): Promise<string> {
    // A single atomic upsert statement: INSERT ... ON CONFLICT(tag)
    // DO UPDATE SET generation = generation + 1 RETURNING generation. It is
    // serializable in both SQLite/D1 and PostgreSQL, so concurrent callers
    // across every process observe strictly increasing generations.
    const table = this.table as unknown as LooseGenerationTable
    const rows = await (this.db as unknown as LooseDrizzleDb)
      .insert(this.table)
      .values({ tag, generation: 1 })
      .onConflictDoUpdate({
        target: table.tag,
        set: { generation: sql`${table.generation} + 1` },
      })
      .returning()
    const row = rows[0] as GenerationRow | undefined
    if (row && typeof row.generation === "number") return String(row.generation)
    throw new CacheAdapterError("advanceTagGeneration", {
      cause: new Error("Shared generation store did not return an incremented generation"),
    })
  }
}

export function createDbTagGenerationStore(args: {
  db: AnyDrizzleDatabase
  table: AnySQLiteTable | AnyPgTable
}): TagGenerationStore {
  return new DbTagGenerationStore(args.db, args.table)
}
