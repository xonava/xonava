import pg from "pg"
import { afterAll, beforeAll, describe } from "vitest"
import { DrizzlePgJobProgressStore } from "@xonava/adapters/drizzle-pg"
import { pgCertificationUrl } from "./database.js"
import {
  defineConcurrentReporters, defineJobProgressDifferential, defineJobProgressRegressions, defineSequenceRace, type JobProgressStoreDifferentialDriver,
} from "../shared/jobProgressStoreDifferential.js"

const SCHEMA = "df_job_progress"

describe("PostgreSQL job progress store differential", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 12 })
  const driver: JobProgressStoreDifferentialDriver = {
    label: "postgres",
    store: new DrizzlePgJobProgressStore(pool, { schema: SCHEMA, jobsTable: "jobs" }),
    maxWorkers: 10,
    reset: async () => { await pool.query(`TRUNCATE ${SCHEMA}.job_progress, ${SCHEMA}.jobs CASCADE`) },
    claim: async (job, claim) => {
      await pool.query(
        `INSERT INTO ${SCHEMA}.jobs(id,worker_id,claim_token,attempt,lease_expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+($5||' minutes')::interval)
         ON CONFLICT(id) DO UPDATE SET worker_id=EXCLUDED.worker_id,claim_token=EXCLUDED.claim_token,attempt=EXCLUDED.attempt,lease_expires_at=EXCLUDED.lease_expires_at`,
        [job, claim.worker, claim.token, claim.attempt, claim.live ? "60" : "-1"])
    },
    setLease: async (job, live) => { await pool.query(`UPDATE ${SCHEMA}.jobs SET lease_expires_at=clock_timestamp()+($2||' minutes')::interval WHERE id=$1`, [job, live ? "60" : "-1"]) },
    dump: async () => (await pool.query(`SELECT job_id, attempt, sequence, percent, checkpoint FROM ${SCHEMA}.job_progress`)).rows.map((r) => ({
      jobId: r.job_id as string, attempt: r.attempt as number, sequence: Number(r.sequence), percent: r.percent === null ? null : Number(r.percent), checkpoint: r.checkpoint as Record<string, unknown> | null,
    })),
  }

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.jobs (id text PRIMARY KEY, worker_id text NOT NULL, claim_token text NOT NULL, attempt integer NOT NULL, lease_expires_at timestamptz NOT NULL);
      CREATE TABLE ${SCHEMA}.job_progress (job_id text PRIMARY KEY REFERENCES ${SCHEMA}.jobs(id) ON DELETE CASCADE, attempt integer NOT NULL, sequence bigint NOT NULL, percent double precision, checkpoint jsonb, updated_at timestamptz NOT NULL);`)
  })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  defineJobProgressRegressions(driver)
  defineJobProgressDifferential(driver)
  defineConcurrentReporters(driver)
  defineSequenceRace(driver)
})
