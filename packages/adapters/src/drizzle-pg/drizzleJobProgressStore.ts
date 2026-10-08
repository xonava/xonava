import { pgSchemaName } from "./pgSchemaName"
import type { Pool } from "pg"
import { ConfigurationError, ConflictError, StaleClaimError } from "core/domain"
import type { DrizzleColumnMap } from "../drizzle-shared/predicateCompiler"
import { decodeStoredJobCheckpoint, validateJobProgress, type JobProgress, type JobProgressFence, type JobProgressPort } from "core/execution"

/** Physical jobs-table columns that fence progress writes on the live claim. */
export interface JobProgressFenceColumns {
  id: string
  workerId: string
  claimToken: string
  attempt: string
  leaseExpiresAt: string
}

/** Defaults kept for the standalone progress schema (`worker_id`, `attempt`). */
const DEFAULT_FENCE_COLUMNS: JobProgressFenceColumns = { id: "id", workerId: "worker_id", claimToken: "claim_token", attempt: "attempt", leaseExpiresAt: "lease_expires_at" }

function quotedColumn(name: unknown, label: string): string {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new ConfigurationError(`Unsafe or missing PostgreSQL column name for job progress '${label}'`)
  return `"${name}"`
}

function columnName(columns: DrizzleColumnMap, key: string): string | undefined {
  return (columns[key] as unknown as { name?: string } | undefined)?.name
}

export class DrizzlePgJobProgressStore implements JobProgressPort {
  private readonly schema: string
  private readonly jobsTable: string
  private readonly fence: Record<keyof JobProgressFenceColumns, string>
  /**
   * @param options.schema PostgreSQL schema holding `job_progress` and the jobs table (default `public`).
   * @param options.jobsTable jobs table whose live claim fences progress writes (default `jobs`).
   * @param options.jobColumns the DrizzleJobStore's `columnMap.jobs`; the fence then uses the job
   *   store's own `id`, `leaseOwner`, `claimToken`, `attempts` and `leaseExpiresAt` columns.
   * @param options.fenceColumns explicit physical fence column names (overrides `jobColumns`).
   * Without either, the legacy `worker_id`/`attempt` names are used.
   */
  constructor(private readonly pool: Pick<Pool, "query">, options: { schema?: string; jobsTable?: string; jobColumns?: DrizzleColumnMap; fenceColumns?: Partial<JobProgressFenceColumns> } = {}) {
    this.schema = pgSchemaName(options.schema ?? "public")
    this.jobsTable = pgSchemaName(options.jobsTable ?? "jobs")
    const fromJobStore: Partial<JobProgressFenceColumns> = options.jobColumns ? {
      id: columnName(options.jobColumns, "id"), workerId: columnName(options.jobColumns, "leaseOwner"), claimToken: columnName(options.jobColumns, "claimToken"),
      attempt: columnName(options.jobColumns, "attempts"), leaseExpiresAt: columnName(options.jobColumns, "leaseExpiresAt"),
    } as Partial<JobProgressFenceColumns> : {}
    const merged = { ...DEFAULT_FENCE_COLUMNS, ...(options.jobColumns ? fromJobStore : {}), ...(options.fenceColumns ?? {}) }
    this.fence = {
      id: quotedColumn(merged.id, "id"), workerId: quotedColumn(merged.workerId, "workerId"), claimToken: quotedColumn(merged.claimToken, "claimToken"),
      attempt: quotedColumn(merged.attempt, "attempt"), leaseExpiresAt: quotedColumn(merged.leaseExpiresAt, "leaseExpiresAt"),
    }
  }
  private fenceWhere(): string {
    const fence = this.fence
    return `${fence.id}=$1 AND ${fence.workerId}=$2 AND ${fence.claimToken}=$3 AND ${fence.attempt}=$4 AND ${fence.leaseExpiresAt} > clock_timestamp()`
  }
  async read(jobId: string): Promise<JobProgress | null> {
    const row = (await this.pool.query(`SELECT job_id,attempt,sequence,percent,checkpoint,updated_at FROM ${this.schema}.job_progress WHERE job_id=$1`, [jobId])).rows[0]
    return row ? { jobId: row.job_id, attempt: row.attempt, sequence: Number(row.sequence), ...(row.percent === null ? {} : { percent: Number(row.percent) }), ...(row.checkpoint === null ? {} : { checkpoint: decodeStoredJobCheckpoint(row.checkpoint) }), updatedAt: new Date(row.updated_at).toISOString() } : null
  }
  async write(fence: JobProgressFence, expectedSequence: number, progress: { percent?: number; checkpoint?: Record<string, unknown> }): Promise<JobProgress> {
    validateJobProgress(progress)
    const result = await this.pool.query(`INSERT INTO ${this.schema}.job_progress(job_id,attempt,sequence,percent,checkpoint,updated_at) SELECT ${this.fence.id},${this.fence.attempt},$5,$6,$7::jsonb,clock_timestamp() FROM ${this.schema}.${this.jobsTable} WHERE ${this.fenceWhere()} ON CONFLICT(job_id) DO UPDATE SET attempt=EXCLUDED.attempt,sequence=EXCLUDED.sequence,percent=EXCLUDED.percent,checkpoint=EXCLUDED.checkpoint,updated_at=EXCLUDED.updated_at WHERE ${this.schema}.job_progress.sequence=$8 RETURNING job_id,attempt,sequence,percent,checkpoint,updated_at`, [fence.jobId, fence.workerId, fence.claimToken, fence.attempt, expectedSequence + 1, progress.percent ?? null, progress.checkpoint === undefined ? null : JSON.stringify(progress.checkpoint), expectedSequence])
    const row = result.rows[0]
    if (!row) {
      const owner = (await this.pool.query(`SELECT 1 FROM ${this.schema}.${this.jobsTable} WHERE ${this.fenceWhere()}`, [fence.jobId, fence.workerId, fence.claimToken, fence.attempt])).rowCount
      if (!owner) throw new StaleClaimError("Job progress ownership was lost")
      throw new ConflictError("Job progress sequence conflict")
    }
    return { jobId: row.job_id, attempt: row.attempt, sequence: Number(row.sequence), ...(row.percent === null ? {} : { percent: Number(row.percent) }), ...(row.checkpoint === null ? {} : { checkpoint: row.checkpoint }), updatedAt: new Date(row.updated_at).toISOString() }
  }
}
