import type { Pool, PoolClient } from "pg"
import { uuidv7 } from "uuidv7"
import type { AtomicRecordBackend } from "../drizzle-shared/fencedDeliveryStateMachine"

const IDENTIFIER = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/

export interface PgAtomicRecordBackendConfig<TKey> {
  readonly pool: Pick<Pool, "connect">
  readonly table: string
  readonly encodeKey: (key: TKey) => string
}

/** PostgreSQL JSON record backend using backend time and a locked transaction per transition. */
export class PgAtomicRecordBackend<TKey, TRecord> implements AtomicRecordBackend<TKey, TRecord> {
  readonly transactional = true
  private readonly table: string

  constructor(private readonly config: PgAtomicRecordBackendConfig<TKey>) {
    if (!IDENTIFIER.test(config.table)) throw new Error("Unsafe atomic-record table name")
    this.table = config.table
  }

  async read(key: TKey): Promise<TRecord | null> {
    const client = await this.config.pool.connect()
    try {
      const result = await client.query<{ record: TRecord }>(`SELECT record FROM ${this.table} WHERE record_key = $1`, [this.config.encodeKey(key)])
      return result.rows[0]?.record ?? null
    } finally { client.release() }
  }

  async transact<TResult>(key: TKey, transition: Parameters<AtomicRecordBackend<TKey, TRecord>["transact"]>[1]): Promise<TResult> {
    const client: PoolClient = await this.config.pool.connect()
    const recordKey = this.config.encodeKey(key)
    try {
      await client.query("BEGIN")
      await client.query(`INSERT INTO ${this.table} (record_key, record, revision) VALUES ($1, 'null'::jsonb, 0) ON CONFLICT DO NOTHING`, [recordKey])
      const currentResult = await client.query<{ record: TRecord | null }>(`SELECT record FROM ${this.table} WHERE record_key = $1 FOR UPDATE`, [recordKey])
      const nowResult = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")
      const outcome = await transition(currentResult.rows[0]?.record ?? null, nowResult.rows[0]!.now, uuidv7, client)
      await client.query(`UPDATE ${this.table} SET record = $2::jsonb, revision = revision + 1 WHERE record_key = $1`, [recordKey, JSON.stringify(outcome.record)])
      await client.query("COMMIT")
      return outcome.result as TResult
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally { client.release() }
  }
}
