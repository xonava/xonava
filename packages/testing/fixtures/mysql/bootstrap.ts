import {readFile} from "node:fs/promises"
import {dirname,join} from "node:path"
import {fileURLToPath} from "node:url"
import type {Pool} from "mysql2/promise"

export const MYSQL_FIXTURE_MIGRATIONS=["0001_framework.sql","0002_workflow_signal_buffering.sql","0003_schedule_next_run_nullable.sql","0004_job_partition_head_index.sql"] as const

/** The statements of one fixture migration (`;`-separated, comment lines dropped). */
export async function readMySqlMigrationStatements(name:(typeof MYSQL_FIXTURE_MIGRATIONS)[number]):Promise<string[]>{
  const source=await readFile(join(dirname(fileURLToPath(import.meta.url)),"migrations",name),"utf8")
  return source.split("\n").filter(line=>!line.trim().startsWith("--")).join("\n").split(";").map(value=>value.trim()).filter(Boolean)
}

export async function bootstrapMySqlFixture(pool:Pool):Promise<void>{for(const statement of await readMySqlMigrationStatements("0001_framework.sql"))await pool.query(statement);const [columns]=await pool.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='temporal_heads'");const names=new Set((columns as {COLUMN_NAME:string}[]).map(row=>row.COLUMN_NAME));if(!names.has("occurred_at"))await pool.query("ALTER TABLE temporal_heads ADD occurred_at DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000'");if(!names.has("kind"))await pool.query("ALTER TABLE temporal_heads ADD kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'created'");const [workflowColumns]=await pool.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='workflows' AND COLUMN_NAME='failure'");if((workflowColumns as unknown[]).length===0)await pool.query("ALTER TABLE workflows ADD failure JSON NULL");await applyMySqlSignalBufferingMigration(pool);await applyMySqlScheduleNextRunNullableMigration(pool);await applyMySqlJobPartitionHeadIndexMigration(pool)}

/** Applies 0002 once: MySQL cannot guard ADD COLUMN, so the migration runs only while `workflow_signals.seq` is missing. */
export async function applyMySqlSignalBufferingMigration(pool:Pool):Promise<boolean>{
  const [seq]=await pool.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='workflow_signals' AND COLUMN_NAME='seq'")
  if((seq as unknown[]).length>0)return false
  for(const statement of await readMySqlMigrationStatements("0002_workflow_signal_buffering.sql"))await pool.query(statement)
  return true
}

/** Applies 0003 (schedules.next_run_at becomes nullable). `MODIFY` restates the column, so re-applying is harmless. */
export async function applyMySqlScheduleNextRunNullableMigration(pool:Pool):Promise<void>{
  for(const statement of await readMySqlMigrationStatements("0003_schedule_next_run_nullable.sql"))await pool.query(statement)
}

/** Applies 0004 once: MySQL cannot guard ADD KEY, so the migration runs only while `jobs_partition_head_idx` is missing. */
export async function applyMySqlJobPartitionHeadIndexMigration(pool:Pool):Promise<boolean>{
  const [existing]=await pool.query("SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='jobs' AND INDEX_NAME='jobs_partition_head_idx'")
  if((existing as unknown[]).length>0)return false
  for(const statement of await readMySqlMigrationStatements("0004_job_partition_head_index.sql"))await pool.query(statement)
  return true
}
