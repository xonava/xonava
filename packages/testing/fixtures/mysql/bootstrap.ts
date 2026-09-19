import {readFile} from "node:fs/promises"
import {dirname,join} from "node:path"
import {fileURLToPath} from "node:url"
import type {Pool} from "mysql2/promise"
export async function bootstrapMySqlFixture(pool:Pool):Promise<void>{const source=await readFile(join(dirname(fileURLToPath(import.meta.url)),"migrations/0001_framework.sql"),"utf8");for(const statement of source.split(";").map(value=>value.trim()).filter(Boolean))await pool.query(statement);const [columns]=await pool.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='temporal_heads'");const names=new Set((columns as {COLUMN_NAME:string}[]).map(row=>row.COLUMN_NAME));if(!names.has("occurred_at"))await pool.query("ALTER TABLE temporal_heads ADD occurred_at DATETIME(3) NOT NULL DEFAULT '1970-01-01 00:00:00.000'");if(!names.has("kind"))await pool.query("ALTER TABLE temporal_heads ADD kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'created'")}
