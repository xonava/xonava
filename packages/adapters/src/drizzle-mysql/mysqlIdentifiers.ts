import {sql,type SQL} from "drizzle-orm"
import {ConfigurationError} from "@xonava/core/domain"

/** MySQL identifiers accepted for database (schema) and table names: an ASCII word of at most 64 characters. */
export const MYSQL_IDENTIFIER_PATTERN=/^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * Validates a MySQL database or table identifier before it is interpolated into SQL.
 * The rejected value is never echoed, so hostile configuration cannot leak into logs.
 */
export function mysqlIdentifier(value:unknown,label="identifier"):string{
  if(typeof value!=="string"||!MYSQL_IDENTIFIER_PATTERN.test(value))throw new ConfigurationError(`Unsafe MySQL ${label}`)
  return value
}

/** Renders a validated, optionally database-qualified table reference: `db`.`table` or `table`. */
export function mysqlQualifiedTable(table:string,database?:string):string{
  const name=`\`${mysqlIdentifier(table,"table name")}\``
  return database===undefined?name:`\`${mysqlIdentifier(database,"database name")}\`.${name}`
}

/** Drizzle form of {@link mysqlQualifiedTable}; `sql.raw` only ever sees validated identifiers. */
export function mysqlQualifiedTableSql(table:string,database?:string):SQL{return sql.raw(mysqlQualifiedTable(table,database))}

/** Common store option: the MySQL database (schema) qualifier and per-table name overrides. */
export interface MySqlTableOptions<TTables extends string>{
  /** Database (MySQL schema) holding the tables; omitted means the connection's current database. */
  readonly database?:string
  /** Per-table physical name overrides; omitted entries keep the production default. */
  readonly tables?:Partial<Record<TTables,string>>
}

/** Validates store options and returns the raw (unquoted) database and table names, rejecting unknown table keys. */
export function resolveMySqlTableNames<TTables extends string>(defaults:Readonly<Record<TTables,string>>,options:MySqlTableOptions<TTables>|undefined):{readonly database?:string;readonly tables:Readonly<Record<TTables,string>>}{
  if(options!==undefined&&(options===null||typeof options!=="object"))throw new ConfigurationError("MySQL store options must be an object")
  const database=options?.database===undefined?undefined:mysqlIdentifier(options.database,"database name")
  const overrides=options?.tables??{}
  if(overrides===null||typeof overrides!=="object")throw new ConfigurationError("MySQL table overrides must be an object")
  for(const key of Object.keys(overrides))if(!Object.prototype.hasOwnProperty.call(defaults,key))throw new ConfigurationError(`Unknown MySQL table override "${key.replace(/[^A-Za-z0-9_]/g,"").slice(0,64)}"`)
  const tables={} as Record<TTables,string>
  for(const key of Object.keys(defaults) as TTables[]){const override=(overrides as Partial<Record<TTables,string>>)[key];tables[key]=mysqlIdentifier(override===undefined?defaults[key]:override,"table name")}
  return database===undefined?{tables:Object.freeze(tables)}:{database,tables:Object.freeze(tables)}
}

/** Resolves store table references: validated, backtick-quoted and optionally database-qualified (`db`.`table`). */
export function resolveMySqlTables<TTables extends string>(defaults:Readonly<Record<TTables,string>>,options:MySqlTableOptions<TTables>|undefined):Readonly<Record<TTables,string>>{
  const {database,tables}=resolveMySqlTableNames(defaults,options)
  const resolved={} as Record<TTables,string>
  for(const key of Object.keys(tables) as TTables[])resolved[key]=mysqlQualifiedTable(tables[key],database)
  return Object.freeze(resolved)
}
