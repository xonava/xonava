import mysql from "mysql2/promise"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { afterAll, beforeAll, describe } from "vitest"
import { DrizzleMySqlJobProgressStore } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"
import {
  defineConcurrentReporters, defineJobProgressDifferential, defineJobProgressRegressions, defineSequenceRace, type JobProgressStoreDifferentialDriver,
} from "../shared/jobProgressStoreDifferential.js"

const DATABASE = "framework_df_job_progress"

function databaseUrl(): string {
  const url = new URL(mysqlCertificationUrl())
  url.pathname = `/${DATABASE}`
  return url.toString()
}

// Identifier columns are byte-exact (utf8mb4_0900_bin, as migration 0006 makes them).
const BIN = "CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin"

describe("MySQL job progress store differential", () => {
  // The pool connects lazily; the database is created in beforeAll before the first query.
  const pool: Pool = mysql.createPool({ uri: databaseUrl(), connectionLimit: 12 })
  const lease = (live: boolean): string => (live ? "DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)" : "DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 MINUTE)")
  const driver: JobProgressStoreDifferentialDriver = {
    label: "mysql",
    store: new DrizzleMySqlJobProgressStore(pool),
    maxWorkers: 10,
    reset: async () => { await pool.query("DELETE FROM job_progress"); await pool.query("DELETE FROM jobs") },
    claim: async (job, claim) => {
      await pool.query(
        `INSERT INTO jobs(id,worker_id,claim_token,attempt,lease_expires_at) VALUES(?,?,?,?,${lease(claim.live)})
         ON DUPLICATE KEY UPDATE worker_id=VALUES(worker_id),claim_token=VALUES(claim_token),attempt=VALUES(attempt),lease_expires_at=VALUES(lease_expires_at)`,
        [job, claim.worker, claim.token, claim.attempt])
    },
    setLease: async (job, live) => { await pool.query(`UPDATE jobs SET lease_expires_at=${lease(live)} WHERE id=?`, [job]) },
    dump: async () => ((await pool.query<RowDataPacket[]>("SELECT job_id, attempt, sequence, CAST(percent AS CHAR) AS percent, checkpoint FROM job_progress"))[0] as Record<string, unknown>[]).map((r) => ({
      jobId: r.job_id as string, attempt: Number(r.attempt), sequence: Number(r.sequence), percent: r.percent === null ? null : Number(r.percent),
      checkpoint: r.checkpoint === null ? null : (typeof r.checkpoint === "string" ? JSON.parse(r.checkpoint) : r.checkpoint) as Record<string, unknown>,
    })),
  }

  beforeAll(async () => {
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.query(`CREATE DATABASE \`${DATABASE}\``)
    await admin.end()
    await pool.query(`CREATE TABLE jobs (id VARCHAR(100) ${BIN} PRIMARY KEY, worker_id VARCHAR(100) ${BIN} NULL, claim_token VARCHAR(100) ${BIN} NULL, attempt INT NOT NULL DEFAULT 0, lease_expires_at DATETIME(3) NULL) ENGINE=InnoDB`)
    await pool.query(`CREATE TABLE job_progress (job_id VARCHAR(100) ${BIN} PRIMARY KEY, attempt INT NOT NULL, sequence BIGINT NOT NULL, percent DOUBLE NULL, checkpoint JSON NULL, updated_at DATETIME(3) NOT NULL) ENGINE=InnoDB`)
  })
  afterAll(async () => {
    await pool.end()
    const admin = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    await admin.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``)
    await admin.end()
  })

  defineJobProgressRegressions(driver)
  defineJobProgressDifferential(driver)
  defineConcurrentReporters(driver)
  defineSequenceRace(driver)
})
