import { ConflictError, StaleClaimError } from "@xonava/core/domain"
import { decodeStoredJobCheckpoint, validateJobProgress, type JobProgress, type JobProgressFence, type JobProgressPort } from "@xonava/core/execution"
import type { D1AtomicDatabase } from "./d1AtomicRecordBackend"

interface StoredRow { job_id: string; attempt: number; sequence: number; percent: number | null; checkpoint: string | null; updated_at_ms: number }

function toProgress(row: StoredRow): JobProgress {
  return { jobId: row.job_id, attempt: row.attempt, sequence: row.sequence, ...(row.percent === null ? {} : { percent: row.percent }), ...(row.checkpoint === null ? {} : { checkpoint: decodeStoredJobCheckpoint(row.checkpoint) }), updatedAt: new Date(row.updated_at_ms).toISOString() }
}

export class DrizzleD1JobProgressStore implements JobProgressPort {
  constructor(private readonly database: D1AtomicDatabase) {}
  async read(jobId: string): Promise<JobProgress | null> {
    const row = await this.database.prepare("SELECT job_id,attempt,sequence,percent,checkpoint,updated_at_ms FROM framework_job_progress WHERE job_id=?").bind(jobId).first<StoredRow>()
    return row ? toProgress(row) : null
  }
  async write(fence: JobProgressFence, expectedSequence: number, progress: { percent?: number; checkpoint?: Record<string, unknown> }): Promise<JobProgress> {
    validateJobProgress(progress)
    const row = await this.database.prepare("INSERT INTO framework_job_progress(job_id,attempt,sequence,percent,checkpoint,updated_at_ms) SELECT id,attempt,?,?,?,CAST(unixepoch('subsec')*1000 AS INTEGER) FROM framework_j1_jobs WHERE id=? AND worker_id=? AND claim_token=? AND attempt=? AND lease_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER) AND (?=0 OR EXISTS(SELECT 1 FROM framework_job_progress WHERE job_id=?)) ON CONFLICT(job_id) DO UPDATE SET attempt=excluded.attempt,sequence=excluded.sequence,percent=excluded.percent,checkpoint=excluded.checkpoint,updated_at_ms=excluded.updated_at_ms WHERE framework_job_progress.sequence=? RETURNING job_id,attempt,sequence,percent,checkpoint,updated_at_ms").bind(expectedSequence + 1, progress.percent ?? null, progress.checkpoint === undefined ? null : JSON.stringify(progress.checkpoint), fence.jobId, fence.workerId, fence.claimToken, fence.attempt, expectedSequence, fence.jobId, expectedSequence).first<StoredRow>()
    if (!row) {
      const owner = await this.database.prepare("SELECT 1 AS ok FROM framework_j1_jobs WHERE id=? AND worker_id=? AND claim_token=? AND attempt=? AND lease_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)").bind(fence.jobId, fence.workerId, fence.claimToken, fence.attempt).first()
      if (!owner) throw new StaleClaimError("Job progress ownership was lost")
      throw new ConflictError("Job progress sequence conflict")
    }
    return toProgress(row)
  }
}
