import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DrizzleMySqlJobStore } from "adapters/drizzle-mysql"
import { applyMySqlJobPartitionHeadIndexMigration, readMySqlMigrationStatements } from "../../fixtures/mysql/bootstrap.js"
import { mysqlCertificationUrl } from "./database.js"

/**
 * The partition-head subquery of the claim (`NOT EXISTS (SELECT 1 FROM jobs ahead WHERE ahead.partition_key = j.partition_key ...)`)
 * needs an index on the partition columns: with only jobs_due_idx(status, ...) EXPLAIN scanned the table for every candidate.
 * The statement under test is the one the store really issues (captured from the claim), explained on a populated table in an own database.
 */
const DATABASE = `framework_df_headidx_${process.pid}`

describe("MySQL job partition-head index", () => {
  let admin: Pool
  let pool: Pool
  const captured: Array<{ sql: string; params: unknown[] }> = []
  beforeAll(async () => {
    admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    const url = new URL(mysqlCertificationUrl())
    url.pathname = `/${DATABASE}`
    pool = mysql.createPool({ uri: url.toString(), connectionLimit: 4 })
    // 0001 creates the jobs table without the index; only the tables the claim touches are needed here.
    for (const statement of await readMySqlMigrationStatements("0001_framework.sql")) if (/\b(jobs|job_executions)\b/.test(statement.split("(")[0]!)) await pool.query(statement)
    // 20 000 rows: mostly finished, 1 500 due in partitions of ~2 rows, 1 500 running (one per partition, as the unique key demands).
    const rows: string[] = []
    for (let i = 0; i < 20_000; i++) {
      const status = i % 20 === 1 ? "running" : i % 20 === 2 || i % 20 === 3 ? "pending" : "succeeded"
      const partition = status === "running" ? `r${i}` : i % 3 === 0 ? null : `p${i % 1500}`
      rows.push(`('j${i}','t',1,${i % 2 ? "'t1'" : "NULL"},'tenant','{}','${status}',${i % 5},0,3,NOW(3),'fp','sc',${partition === null ? "NULL" : `'${partition}'`},${status === "running" ? "TIMESTAMPADD(HOUR,1,NOW(3))" : "NULL"})`)
    }
    await pool.query(`INSERT INTO jobs(id,job_type,job_version,tenant_id,scope,payload,status,priority,attempt,max_attempts,run_at,fingerprint,idempotency_scope,partition_key,lease_expires_at) VALUES ${rows.join(",")}`)
  }, 60_000)
  afterAll(async () => { await pool?.end(); await admin?.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``).catch(() => undefined); await admin?.end() })

  const capturingPool = (): Pick<Pool, "query" | "getConnection"> => ({
    query: pool.query.bind(pool) as Pool["query"],
    getConnection: async () => {
      const connection = await pool.getConnection()
      const original = connection.query.bind(connection) as (...args: unknown[]) => unknown
      ;(connection as unknown as { query: (...args: unknown[]) => unknown }).query = (sql: unknown, params?: unknown) => {
        if (typeof sql === "string" && sql.includes(" ahead ")) captured.push({ sql, params: params as unknown[] })
        return original(sql, params)
      }
      return connection
    },
  })
  const explainClaim = async (): Promise<RowDataPacket[]> => {
    captured.length = 0
    await new DrizzleMySqlJobStore(capturingPool()).claimDue({ workerId: "w", limit: 10, leaseDurationMs: 60_000, requester: { scope: "tenant", tenantId: "t1", actorId: "actor" } })
    expect(captured.length).toBeGreaterThan(0)
    const [plan] = await pool.query<RowDataPacket[]>(`EXPLAIN ${captured[0]!.sql}`, captured[0]!.params)
    return plan
  }

  it("migration 0004 adds the partition index, a re-run is a no-op, and the claim's ahead subquery uses it", async () => {
    const before = await explainClaim()
    const aheadBefore = before.find((row) => row.table === "ahead")
    expect(aheadBefore, JSON.stringify(before)).toBeDefined()
    expect(aheadBefore!.key).not.toBe("jobs_partition_head_idx")
    // Without it the subquery can only range-scan jobs_due_idx by status (or the table), never look a partition up.
    expect(aheadBefore!.type).not.toBe("ref")

    expect(await applyMySqlJobPartitionHeadIndexMigration(pool)).toBe(true)
    expect(await applyMySqlJobPartitionHeadIndexMigration(pool)).toBe(false)
    await pool.query("ANALYZE TABLE jobs")
    const [columns] = await pool.query<RowDataPacket[]>("SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='jobs' AND INDEX_NAME='jobs_partition_head_idx' ORDER BY SEQ_IN_INDEX")
    expect(columns.map((row) => row.COLUMN_NAME)).toEqual(["partition_key", "scope", "tenant_id", "status"])

    const after = await explainClaim()
    const aheadAfter = after.find((row) => row.table === "ahead")
    expect(aheadAfter, JSON.stringify(after)).toBeDefined()
    expect(aheadAfter!.key).toBe("jobs_partition_head_idx")
    expect(aheadAfter!.type).toBe("ref")
  }, 60_000)
})
