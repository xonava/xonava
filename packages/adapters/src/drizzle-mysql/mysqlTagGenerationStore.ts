import type {Pool,RowDataPacket,ResultSetHeader} from "mysql2/promise"
import { CacheAdapterError } from "core/cache"
import type {TagGenerationStore} from "../cache/dbTagGenerationStore"
import {resolveMySqlTables,type MySqlTableOptions} from "./mysqlIdentifiers"

/** Production table name for cache tag generations. */
export const MYSQL_TAG_GENERATION_TABLES=Object.freeze({cacheGenerations:"cache_generations"})
export type MySqlTagGenerationStoreOptions=MySqlTableOptions<keyof typeof MYSQL_TAG_GENERATION_TABLES>

export class MySqlTagGenerationStore implements TagGenerationStore{
  private readonly table:string
  /** @param tableOrOptions a table name (legacy) or `{database?, tables?: {cacheGenerations?}}`. */
  constructor(private readonly pool:Pick<Pool,"query"|"getConnection">,tableOrOptions:string|MySqlTagGenerationStoreOptions="cache_generations"){this.table=resolveMySqlTables(MYSQL_TAG_GENERATION_TABLES,typeof tableOrOptions==="string"?{tables:{cacheGenerations:tableOrOptions}}:tableOrOptions).cacheGenerations}
  async getTagGeneration(tag:string){const [rows]=await this.pool.query<(RowDataPacket&{generation:number|string})[]>(`SELECT generation FROM ${this.table} WHERE scope=?`,[tag]);return rows[0]?String(rows[0].generation):"0"}
  async advanceTagGeneration(tag:string){const connection=await this.pool.getConnection();try{await connection.beginTransaction();await connection.query<ResultSetHeader>(`INSERT INTO ${this.table}(scope,generation) VALUES(?,LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE generation=LAST_INSERT_ID(generation+1)`,[tag]);const [rows]=await connection.query<(RowDataPacket&{generation:number|string})[]>("SELECT LAST_INSERT_ID() generation");await connection.commit();return String(rows[0]!.generation)}catch(error){await connection.rollback();throw new CacheAdapterError("advanceTagGeneration",{cause:error})}finally{connection.release()}}
}
export const createMySqlTagGenerationStore=(pool:Pick<Pool,"query"|"getConnection">,tableOrOptions?:string|MySqlTagGenerationStoreOptions)=>new MySqlTagGenerationStore(pool,tableOrOptions)
