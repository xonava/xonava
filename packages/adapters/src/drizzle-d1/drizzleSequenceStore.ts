import type { ExecutionScopeId } from "@xonava/core/domain"
import type { SequenceStore } from "@xonava/core/sequence"
export interface D1SequenceStatement { bind(...values: unknown[]): D1SequenceStatement; first<T = Record<string, unknown>>(): Promise<T | null> }
export interface D1SequenceDatabase { prepare(sql: string): D1SequenceStatement; batch?(statements: D1SequenceStatement[]): Promise<unknown[]> }
export class DrizzleD1SequenceStore implements SequenceStore {
  constructor(private readonly db: D1SequenceDatabase) {}
  async next(scopeId: ExecutionScopeId, name: string, period: string): Promise<number> { const row = await this.db.prepare("INSERT INTO framework_sequences(scope_id,name,period,value) VALUES(?,?,?,1) ON CONFLICT(scope_id,name,period) DO UPDATE SET value=value+1 RETURNING value").bind(scopeId, name, period).first<{ value: number }>(); const value = Number(row?.value); if (!Number.isSafeInteger(value) || value < 1) throw new Error("D1 sequence allocation failed"); return value }
  /** Commits allocation and consumer statements in one D1 batch. Consumer SQL can read the allocated value from framework_sequences. */
  async nextWithStatements(scopeId: ExecutionScopeId, name: string, period: string, consumerStatements: readonly D1SequenceStatement[]): Promise<number> {
    if (!this.db.batch) throw new Error("D1 sequence batch allocation is unavailable")
    if (consumerStatements.length < 1) throw new Error("D1 sequence batch allocation requires a consumer statement")
    const allocation = this.db.prepare("INSERT INTO framework_sequences(scope_id,name,period,value) VALUES(?,?,?,1) ON CONFLICT(scope_id,name,period) DO UPDATE SET value=value+1 RETURNING value").bind(scopeId, name, period)
    await this.db.batch([allocation, ...consumerStatements])
    const row = await this.db.prepare("SELECT value FROM framework_sequences WHERE scope_id=? AND name=? AND period=?").bind(scopeId, name, period).first<{ value: number }>()
    const value = Number(row?.value)
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("D1 sequence batch allocation failed")
    return value
  }
}
export const D1_SEQUENCE_SCHEMA_SQL = "CREATE TABLE IF NOT EXISTS framework_sequences(scope_id TEXT NOT NULL,name TEXT NOT NULL,period TEXT NOT NULL,value INTEGER NOT NULL CHECK(value>0),PRIMARY KEY(scope_id,name,period));"
