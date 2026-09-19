import type { ExecutionScopeId } from "core/domain"
import type { SequenceStore } from "core/sequence"
import type { PgTemporalClient } from "./drizzleTemporalHistoryStore.js"
export class DrizzlePgSequenceStore implements SequenceStore {
  constructor(private readonly db: PgTemporalClient, private readonly schema = "framework_test") { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("Unsafe sequence schema") }
  async next(scopeId: ExecutionScopeId, name: string, period: string): Promise<number> { const result = await this.db.query(`INSERT INTO ${this.schema}.sequences(scope_id,name,period,value) VALUES($1,$2,$3,1) ON CONFLICT(scope_id,name,period) DO UPDATE SET value=${this.schema}.sequences.value+1 RETURNING value`, [scopeId, name, period]); const value = Number(result.rows[0]?.value); if (!Number.isSafeInteger(value) || value < 1) throw new Error("PostgreSQL sequence allocation failed"); return value }
}
export const POSTGRES_SEQUENCE_SCHEMA_SQL = "CREATE TABLE IF NOT EXISTS framework_test.sequences(scope_id text NOT NULL,name text NOT NULL,period text NOT NULL,value bigint NOT NULL CHECK(value>0),PRIMARY KEY(scope_id,name,period));"
