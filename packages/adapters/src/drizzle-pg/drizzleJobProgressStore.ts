import { pgSchemaName } from "./pgSchemaName"
import type { Pool } from "pg"
import { ConflictError, StaleClaimError } from "core/domain"
import { decodeStoredJobCheckpoint, validateJobProgress, type JobProgress, type JobProgressFence, type JobProgressPort } from "core/execution"

export class DrizzlePgJobProgressStore implements JobProgressPort {
  private readonly schema: string
  private readonly jobsTable: string
  /**
   * @param options.schema PostgreSQL schema holding `job_progress` and the jobs table (default `public`).
   * @param options.jobsTable jobs table whose live claim fences progress writes (default `jobs`).
   */
  constructor(private readonly pool: Pick<Pool, "query">, options: { schema?: string; jobsTable?: string } = {}) {
    this.schema = pgSchemaName(options.schema ?? "public")
    this.jobsTable = pgSchemaName(options.jobsTable ?? "jobs")
  }
  async read(jobId: string): Promise<JobProgress | null> {
    const row = (await this.pool.query(`SELECT job_id,attempt,sequence,percent,checkpoint,updated_at FROM ${this.schema}.job_progress WHERE job_id=$1`, [jobId])).rows[0]
    return row ? { jobId: row.job_id, attempt: row.attempt, sequence: Number(row.sequence), ...(row.percent === null ? {} : { percent: Number(row.percent) }), ...(row.checkpoint === null ? {} : { checkpoint: decodeStoredJobCheckpoint(row.checkpoint) }), updatedAt: new Date(row.updated_at).toISOString() } : null
  }
  async write(fence: JobProgressFence, expectedSequence: number, progress: { percent?: number; checkpoint?: Record<string, unknown> }): Promise<JobProgress> {
    validateJobProgress(progress)
    const result = await this.pool.query(`INSERT INTO ${this.schema}.job_progress(job_id,attempt,sequence,percent,checkpoint,updated_at) SELECT id,attempt,$5,$6,$7::jsonb,clock_timestamp() FROM ${this.schema}.${this.jobsTable} WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND attempt=$4 AND lease_expires_at > clock_timestamp() ON CONFLICT(job_id) DO UPDATE SET attempt=EXCLUDED.attempt,sequence=EXCLUDED.sequence,percent=EXCLUDED.percent,checkpoint=EXCLUDED.checkpoint,updated_at=EXCLUDED.updated_at WHERE ${this.schema}.job_progress.sequence=$8 RETURNING job_id,attempt,sequence,percent,checkpoint,updated_at`, [fence.jobId, fence.workerId, fence.claimToken, fence.attempt, expectedSequence + 1, progress.percent ?? null, progress.checkpoint === undefined ? null : JSON.stringify(progress.checkpoint), expectedSequence])
    const row = result.rows[0]
    if (!row) {
      const owner = (await this.pool.query(`SELECT 1 FROM ${this.schema}.${this.jobsTable} WHERE id=$1 AND worker_id=$2 AND claim_token=$3 AND attempt=$4 AND lease_expires_at > clock_timestamp()`, [fence.jobId, fence.workerId, fence.claimToken, fence.attempt])).rowCount
      if (!owner) throw new StaleClaimError("Job progress ownership was lost")
      throw new ConflictError("Job progress sequence conflict")
    }
    return { jobId: row.job_id, attempt: row.attempt, sequence: Number(row.sequence), ...(row.percent === null ? {} : { percent: Number(row.percent) }), ...(row.checkpoint === null ? {} : { checkpoint: row.checkpoint }), updatedAt: new Date(row.updated_at).toISOString() }
  }
}
