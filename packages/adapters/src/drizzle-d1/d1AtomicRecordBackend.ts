import { uuidv7 } from "uuidv7"
import type { AtomicRecordBackend } from "../drizzle-shared/fencedDeliveryStateMachine"

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
export interface D1Result { readonly meta?: { readonly changes?: number } }
export interface D1Statement { bind(...values: unknown[]): D1Statement; first<T>(): Promise<T | null>; run(): Promise<D1Result> }
export interface D1AtomicDatabase { prepare(sql: string): D1Statement; batch<T = D1Result>(statements: readonly D1Statement[]): Promise<T[]> }

export interface D1AtomicRecordBackendConfig<TKey> {
  readonly database: D1AtomicDatabase
  readonly table: string
  readonly encodeKey: (key: TKey) => string
  readonly maxRetries?: number
}

/** D1 JSON record backend using compare-and-swap updates committed by an atomic batch. */
export class D1AtomicRecordBackend<TKey, TRecord> implements AtomicRecordBackend<TKey, TRecord> {
  readonly transactional = false
  private readonly table: string
  constructor(private readonly config: D1AtomicRecordBackendConfig<TKey>) {
    if (!IDENTIFIER.test(config.table)) throw new Error("Unsafe atomic-record table name")
    this.table = config.table
  }
  async read(key: TKey): Promise<TRecord | null> {
    const row = await this.config.database.prepare(`SELECT record FROM ${this.table} WHERE record_key = ?`).bind(this.config.encodeKey(key)).first<{ record: string }>()
    return row ? JSON.parse(row.record) as TRecord : null
  }
  async transact<TResult>(key: TKey, transition: Parameters<AtomicRecordBackend<TKey, TRecord>["transact"]>[1]): Promise<TResult> {
    const recordKey = this.config.encodeKey(key)
    for (let attempt = 0; attempt < (this.config.maxRetries ?? 16); attempt += 1) {
      const row = await this.config.database.prepare(`SELECT record, revision, CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms FROM ${this.table} WHERE record_key = ?`).bind(recordKey).first<{ record: string; revision: number; now_ms: number }>()
      const nowMs = row?.now_ms ?? (await this.config.database.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms").first<{ now_ms: number }>())!.now_ms
      const outcome = await transition(row ? JSON.parse(row.record) as TRecord : null, new Date(nowMs), uuidv7)
      const statement = row
        ? this.config.database.prepare(`UPDATE ${this.table} SET record = ?, revision = revision + 1 WHERE record_key = ? AND revision = ?`).bind(JSON.stringify(outcome.record), recordKey, row.revision)
        : this.config.database.prepare(`INSERT OR IGNORE INTO ${this.table} (record_key, record, revision) VALUES (?, ?, 1)`).bind(recordKey, JSON.stringify(outcome.record))
      const [result] = await this.config.database.batch<D1Result>([statement])
      if ((result?.meta?.changes ?? 0) === 1) return outcome.result as TResult
    }
    throw new Error("D1 atomic-record transition exceeded retry budget")
  }

  /** Commits pre-fenced business statements and the record transition in one rollback-on-error batch. */
  async transactBatch<TResult>(key: TKey, businessStatements: readonly D1Statement[], transition: (current: TRecord | null, backendNow: Date) => { readonly record: TRecord; readonly result: TResult }): Promise<TResult> {
    const recordKey = this.config.encodeKey(key)
    const row = await this.config.database.prepare(`SELECT record, revision, CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms FROM ${this.table} WHERE record_key = ?`).bind(recordKey).first<{ record: string; revision: number; now_ms: number }>()
    if (!row) throw new Error("Atomic-record row does not exist")
    const outcome = transition(JSON.parse(row.record) as TRecord, new Date(row.now_ms))
    const guard = this.config.database.prepare("SELECT CASE WHEN changes() = 1 THEN 1 ELSE json('framework_atomic_batch_guard_failure') END")
    const update = this.config.database.prepare(`UPDATE ${this.table} SET record = ?, revision = revision + 1 WHERE record_key = ? AND revision = ?`).bind(JSON.stringify(outcome.record), recordKey, row.revision)
    const statements: D1Statement[] = []
    for (const statement of businessStatements) statements.push(statement, guard)
    statements.push(update, guard)
    await this.config.database.batch(statements)
    return outcome.result
  }
}
