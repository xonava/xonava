import type { Pool } from "pg"
import { uuidv7 } from "uuidv7"
import type { FencedLease, LeaseResourceKey } from "@xonava/core/events"
import { FencedLeaseStore, type AtomicLeaseBackend } from "../drizzle-shared/fencedLeaseStore"
import { pgSchemaName } from "./pgSchemaName"

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/

/** Production table names for the fenced leases. */
export const PG_LEASE_TABLES = Object.freeze({ leases: "lease_records" })
export interface PgLeaseStoreOptions {
  /** Optional PostgreSQL schema that qualifies the lease table. */
  readonly schema?: string
  readonly tables?: { readonly leases?: string }
}

/** PostgreSQL fenced-lease backend: a row lock per resource and the database clock (`clock_timestamp()`) for every decision. */
export class PgAtomicLeaseBackend implements AtomicLeaseBackend {
  private readonly table: string
  /** @param table lease table `(resource_key text primary key, lease jsonb null, revision bigint)`, optionally schema-qualified. */
  constructor(private readonly pool: Pick<Pool, "connect">, table: string = PG_LEASE_TABLES.leases) {
    if (!/^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/.test(table)) throw new Error("Unsafe lease table name")
    this.table = table
  }

  private key(resource: LeaseResourceKey): string { return `${resource.scopeId}:${resource.namespace}:${resource.resourceId}` }

  async transition<T>(resource: LeaseResourceKey, change: Parameters<AtomicLeaseBackend["transition"]>[1]): Promise<T> {
    const client = await this.pool.connect()
    const key = this.key(resource)
    try {
      await client.query("BEGIN")
      await client.query(`INSERT INTO ${this.table} (resource_key, lease, revision) VALUES ($1, NULL, 0) ON CONFLICT DO NOTHING`, [key])
      const current = await client.query<{ lease: FencedLease | null }>(`SELECT lease FROM ${this.table} WHERE resource_key = $1 FOR UPDATE`, [key])
      const time = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      const outcome = change(current.rows[0]?.lease ?? null, new Date(time.rows[0]!.now), uuidv7)
      await client.query(`UPDATE ${this.table} SET lease = $2::jsonb, revision = revision + 1 WHERE resource_key = $1`, [key, outcome.lease === null ? null : JSON.stringify(outcome.lease)])
      await client.query("COMMIT")
      return outcome.result as T
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally { client.release() }
  }

  async read(resource: LeaseResourceKey): Promise<{ lease: FencedLease | null; backendNow: Date }> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<{ lease: FencedLease | null; now: Date }>(`SELECT (SELECT lease FROM ${this.table} WHERE resource_key = $1) AS lease, clock_timestamp() AS now`, [this.key(resource)])
      const row = result.rows[0]!
      return { lease: row.lease ?? null, backendNow: new Date(row.now) }
    } finally { client.release() }
  }
}

/** @param tableOrOptions a table name (optionally `schema.table`) or `{schema?, tables?: {leases?}}`. */
export const createPgLeaseStore = (pool: Pick<Pool, "connect">, tableOrOptions: string | PgLeaseStoreOptions = PG_LEASE_TABLES.leases): FencedLeaseStore => {
  if (typeof tableOrOptions === "string") return new FencedLeaseStore(new PgAtomicLeaseBackend(pool, tableOrOptions))
  const name = tableOrOptions.tables?.leases ?? PG_LEASE_TABLES.leases
  if (!IDENTIFIER.test(name)) throw new Error("Unsafe lease table name")
  return new FencedLeaseStore(new PgAtomicLeaseBackend(pool, tableOrOptions.schema === undefined ? name : `${pgSchemaName(tableOrOptions.schema).toLowerCase()}.${name}`))
}
