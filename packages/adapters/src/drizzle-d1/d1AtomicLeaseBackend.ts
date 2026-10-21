import { uuidv7 } from "uuidv7"
import type { FencedLease, LeaseResourceKey } from "@xonava/core/events"
import { FencedLeaseStore, type AtomicLeaseBackend } from "../drizzle-shared/fencedLeaseStore"
import type { D1AtomicDatabase, D1Result } from "./d1AtomicRecordBackend"

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const NOW_MS = "CAST(unixepoch('subsec') * 1000 AS INTEGER)"

/** Production table names for the fenced leases. */
export const D1_LEASE_TABLES = Object.freeze({ leases: "lease_records" })
export interface D1LeaseStoreOptions { readonly tables?: { readonly leases?: string }; readonly maxRetries?: number }

/**
 * D1 fenced-lease backend using the database clock and compare-and-swap on a per-row `revision`.
 *
 * D1 has no interactive transactions, so a transition reads `(lease, revision, now)`, computes the change in memory, and commits
 * it with ONE conditional statement: `UPDATE ... WHERE resource_key = ? AND revision = ?` (or `INSERT OR IGNORE` with revision 1 when
 * the row does not exist yet). Each statement executes atomically inside D1's single writer, so of any number of racing
 * transitions that read the same revision exactly one sees `changes = 1`; the others see 0 and re-read and recompute.
 * No transition is ever applied on top of a lease it did not read, which gives the same linearizable acquire/renew/release as the
 * locked transaction of the MySQL and PostgreSQL backends. Time read before the write is safe because a lease only ever expires
 * (time moves forward) and any other mutation bumps the revision and defeats the write.
 */
export class D1AtomicLeaseBackend implements AtomicLeaseBackend {
  private readonly table: string
  constructor(private readonly database: D1AtomicDatabase, table: string = D1_LEASE_TABLES.leases, private readonly maxRetries = 16) {
    if (!IDENTIFIER.test(table)) throw new Error("Unsafe lease table name")
    this.table = table
  }

  private key(resource: LeaseResourceKey): string { return `${resource.scopeId}:${resource.namespace}:${resource.resourceId}` }

  async transition<T>(resource: LeaseResourceKey, change: Parameters<AtomicLeaseBackend["transition"]>[1]): Promise<T> {
    const key = this.key(resource)
    for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
      const row = await this.database.prepare(`SELECT lease, revision, ${NOW_MS} AS now_ms FROM ${this.table} WHERE resource_key = ?`).bind(key).first<{ lease: string | null; revision: number; now_ms: number }>()
      const nowMs = row?.now_ms ?? (await this.database.prepare(`SELECT ${NOW_MS} AS now_ms`).first<{ now_ms: number }>())!.now_ms
      const outcome = change(row?.lease ? JSON.parse(row.lease) as FencedLease : null, new Date(nowMs), uuidv7)
      const encoded = outcome.lease === null ? null : JSON.stringify(outcome.lease)
      const statement = row
        ? this.database.prepare(`UPDATE ${this.table} SET lease = ?, revision = revision + 1 WHERE resource_key = ? AND revision = ?`).bind(encoded, key, row.revision)
        : this.database.prepare(`INSERT OR IGNORE INTO ${this.table} (resource_key, lease, revision) VALUES (?, ?, 1)`).bind(key, encoded)
      const [result] = await this.database.batch<D1Result>([statement])
      if ((result?.meta?.changes ?? 0) === 1) return outcome.result as T
    }
    throw new Error("D1 lease transition exceeded retry budget")
  }

  async read(resource: LeaseResourceKey): Promise<{ lease: FencedLease | null; backendNow: Date }> {
    const row = await this.database.prepare(`SELECT (SELECT lease FROM ${this.table} WHERE resource_key = ?) AS lease, ${NOW_MS} AS now_ms`).bind(this.key(resource)).first<{ lease: string | null; now_ms: number }>()
    return { lease: row?.lease ? JSON.parse(row.lease) as FencedLease : null, backendNow: new Date(row!.now_ms) }
  }
}

/** @param tableOrOptions a table name or `{tables?: {leases?}, maxRetries?}`. */
export const createD1LeaseStore = (database: D1AtomicDatabase, tableOrOptions: string | D1LeaseStoreOptions = D1_LEASE_TABLES.leases): FencedLeaseStore => {
  const options: D1LeaseStoreOptions = typeof tableOrOptions === "string" ? { tables: { leases: tableOrOptions } } : tableOrOptions
  return new FencedLeaseStore(new D1AtomicLeaseBackend(database, options.tables?.leases ?? D1_LEASE_TABLES.leases, options.maxRetries))
}
