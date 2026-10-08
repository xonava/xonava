import type { ExecutionScopeId } from "core/domain"
import type { SequenceStore } from "core/sequence"
import { resolveMySqlTables, type MySqlTableOptions } from "./mysqlIdentifiers"
interface MySqlResult { insertId?: number }
export interface MySqlSequenceConnection { query(sql: string, values?: unknown[]): Promise<[unknown, unknown]> }
/** Production table names; override per deployment through the store options. */
export const MYSQL_SEQUENCE_STORE_TABLES = Object.freeze({ sequences: "sequences" })
export type DrizzleMySqlSequenceStoreOptions = MySqlTableOptions<keyof typeof MYSQL_SEQUENCE_STORE_TABLES>
export class DrizzleMySqlSequenceStore implements SequenceStore {
  private readonly t: Readonly<Record<keyof typeof MYSQL_SEQUENCE_STORE_TABLES, string>>
  constructor(private readonly connection: MySqlSequenceConnection, options: DrizzleMySqlSequenceStoreOptions = {}) { this.t = resolveMySqlTables(MYSQL_SEQUENCE_STORE_TABLES, options) }
  async next(scopeId: ExecutionScopeId, name: string, period: string): Promise<number> { const [result] = await this.connection.query(`INSERT INTO ${this.t.sequences}(scope_id,name,period,value) VALUES(?,?,?,LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE value=LAST_INSERT_ID(value+1)`, [scopeId, name, period]); const value = Number((result as MySqlResult).insertId); if (!Number.isSafeInteger(value) || value < 1) throw new Error("MySQL sequence allocation failed"); return value }
}
/** DDL for this store, honouring the same database/table options as the store. */
export function mysqlSequenceSchemaSql(options: DrizzleMySqlSequenceStoreOptions = {}): string { const t = resolveMySqlTables(MYSQL_SEQUENCE_STORE_TABLES, options); return MYSQL_SEQUENCE_SCHEMA_SQL.replace("EXISTS sequences(", `EXISTS ${t.sequences}(`) }
export const MYSQL_SEQUENCE_SCHEMA_SQL = "CREATE TABLE IF NOT EXISTS sequences(scope_id VARCHAR(1024) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,period VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,value BIGINT UNSIGNED NOT NULL,PRIMARY KEY(scope_id,name,period),CHECK(value>0)) ENGINE=InnoDB;"
