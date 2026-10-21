import {readFile} from "node:fs/promises"
import {dirname,join} from "node:path"
import {fileURLToPath} from "node:url"
import mysql from "mysql2/promise"
import type {Pool} from "mysql2/promise"
import {mysqlCertificationUrl} from "./database.js"
import {readMySqlMigrationStatements} from "../../fixtures/mysql/bootstrap.js"

/** Tables re-created under renamed names in the alternate database. */
export const ALT_TABLES=["jobs","job_executions","job_progress","schedules","workflows","workflow_signals","sequences","temporal_heads","temporal_revisions","temporal_snapshots","atomic_records","leases","cache_generations"] as const
export type AltTable=(typeof ALT_TABLES)[number]
export const altName=(table:AltTable)=>`alt_${table}`

/**
 * Creates a throwaway database (framework_alt_<pid>) holding every store table under an `alt_` prefix, built from the
 * fixture migration DDL. The returned pool is connected to the regular test database, so the stores must qualify
 * their SQL with the alternate database to reach the renamed tables.
 */
export async function openAltDatabase():Promise<{pool:Pool;database:string;drop:()=>Promise<void>}>{
  const database=`framework_alt_${process.pid}`
  const pool=mysql.createPool({uri:mysqlCertificationUrl(),connectionLimit:8})
  await pool.query(`DROP DATABASE IF EXISTS \`${database}\``)
  await pool.query(`CREATE DATABASE \`${database}\``)
  const source=await readFile(join(dirname(fileURLToPath(import.meta.url)),"../../fixtures/mysql/migrations/0001_framework.sql"),"utf8")
  const wanted=new Set<string>(ALT_TABLES)
  for(const statement of source.split(";").map(value=>value.trim()).filter(Boolean)){
    const match=/^CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/.exec(statement)
    if(!match||!wanted.has(match[1]!))continue
    await pool.query(statement.replace(match[0],`CREATE TABLE \`${database}\`.\`${altName(match[1] as AltTable)}\``))
  }
  // Later fixture migrations alter the tables created above; re-target their statements at the renamed copies.
  for(const statement of await readMySqlMigrationStatements("0002_workflow_signal_buffering.sql"))await pool.query(statement.replace(/\b(workflows|workflow_signals)\b/g,name=>`\`${database}\`.\`${altName(name as AltTable)}\``))
  for(const statement of await readMySqlMigrationStatements("0003_schedule_next_run_nullable.sql"))await pool.query(statement.replace(/\bschedules\b/g,`\`${database}\`.\`${altName("schedules")}\``))
  for(const statement of await readMySqlMigrationStatements("0004_job_partition_head_index.sql"))await pool.query(statement.replace(/\bjobs\b/g,`\`${database}\`.\`${altName("jobs")}\``))
  for(const statement of await readMySqlMigrationStatements("0005_job_scope_key.sql"))await pool.query(statement.replace(/\b(jobs|schedules)\b/g,name=>`\`${database}\`.\`${altName(name as AltTable)}\``))
  const [failure]=await pool.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME='failure'",[database,altName("workflows")])
  if((failure as unknown[]).length===0)await pool.query(`ALTER TABLE \`${database}\`.\`${altName("workflows")}\` ADD failure JSON NULL`)
  return {pool,database,drop:async()=>{try{await pool.query(`DROP DATABASE IF EXISTS \`${database}\``)}finally{await pool.end()}}}
}

export async function clearAltDatabase(pool:Pool,database:string):Promise<void>{for(const table of ALT_TABLES)await pool.query(`DELETE FROM \`${database}\`.\`${altName(table)}\``)}
