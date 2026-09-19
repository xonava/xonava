import type {Pool,RowDataPacket,ResultSetHeader} from "mysql2/promise"
import { CacheAdapterError } from "core/cache"
import type {TagGenerationStore} from "../cache/dbTagGenerationStore"

export class MySqlTagGenerationStore implements TagGenerationStore{
  constructor(private readonly pool:Pick<Pool,"query"|"getConnection">,private readonly table="cache_generations"){if(!/^[a-z_][a-z0-9_]*$/.test(table))throw new TypeError("Unsafe MySQL generation table name")}
  async getTagGeneration(tag:string){const [rows]=await this.pool.query<(RowDataPacket&{generation:number|string})[]>(`SELECT generation FROM \`${this.table}\` WHERE scope=?`,[tag]);return rows[0]?String(rows[0].generation):"0"}
  async advanceTagGeneration(tag:string){const connection=await this.pool.getConnection();try{await connection.beginTransaction();await connection.query<ResultSetHeader>(`INSERT INTO \`${this.table}\`(scope,generation) VALUES(?,LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE generation=LAST_INSERT_ID(generation+1)`,[tag]);const [rows]=await connection.query<(RowDataPacket&{generation:number|string})[]>("SELECT LAST_INSERT_ID() generation");await connection.commit();return String(rows[0]!.generation)}catch(error){await connection.rollback();throw new CacheAdapterError("advanceTagGeneration",{cause:error})}finally{connection.release()}}
}
export const createMySqlTagGenerationStore=(pool:Pick<Pool,"query"|"getConnection">,table?:string)=>new MySqlTagGenerationStore(pool,table)
