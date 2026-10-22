import { ConfigurationError, StaleClaimError } from "../domain"
import { canonicalJsonString } from "../serialization/canonicalJson"

export const MAX_JOB_CHECKPOINT_BYTES = 64 * 1024
export interface JobProgress { readonly jobId: string; readonly attempt: number; readonly sequence: number; readonly percent?: number; readonly checkpoint?: Record<string, unknown>; readonly updatedAt: string }
export interface JobProgressFence { readonly jobId: string; readonly workerId: string; readonly claimToken: string; readonly attempt: number }
export interface JobProgressPort { read(jobId: string): Promise<JobProgress | null>; write(fence: JobProgressFence, expectedSequence: number, progress: { percent?: number; checkpoint?: Record<string, unknown> }): Promise<JobProgress> }

export function validateJobProgress(progress: { percent?: number; checkpoint?: Record<string, unknown> }): void {
  if (progress.percent !== undefined && (!Number.isFinite(progress.percent) || progress.percent < 0 || progress.percent > 100)) throw new ConfigurationError("Job progress percent must be between 0 and 100")
  if (progress.checkpoint === undefined) return
  assertCheckpointWithinBounds(progress.checkpoint)
  if (containsNul(progress.checkpoint)) throw new ConfigurationError("Job checkpoint must not contain U+0000 (PostgreSQL jsonb cannot store it)")
}

function assertCheckpointWithinBounds(checkpoint: Record<string, unknown>): void {
  const bytes = new TextEncoder().encode(canonicalCheckpointJson(checkpoint)).byteLength
  if (bytes > MAX_JOB_CHECKPOINT_BYTES) throw new ConfigurationError(`Job checkpoint exceeds ${MAX_JOB_CHECKPOINT_BYTES} bytes`)
}

/** Canonical JSON rejects values the bound cannot represent (e.g. integers beyond the safe range); report them as configuration errors. */
function canonicalCheckpointJson(checkpoint: Record<string, unknown>): string {
  try {
    return canonicalJsonString(checkpoint)
  } catch (error) {
    throw new ConfigurationError(`Job checkpoint is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000")
  if (Array.isArray(value)) return value.some(containsNul)
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, nested]) => key.includes("\u0000") || containsNul(nested))
  return false
}

/** Decode persisted checkpoint state under the same durable bounds as writes. */
export function decodeStoredJobCheckpoint(raw: unknown): Record<string, unknown> {
  let decoded = raw
  if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).byteLength > MAX_JOB_CHECKPOINT_BYTES) {
      throw new ConfigurationError(`Stored job checkpoint exceeds ${MAX_JOB_CHECKPOINT_BYTES} bytes`)
    }
    try {
      decoded = JSON.parse(raw)
    } catch {
      throw new ConfigurationError("Stored job checkpoint is not valid JSON")
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new ConfigurationError("Stored job checkpoint must be a JSON object")
  }
  // U+0000 is refused on write only: checkpoints MySQL or D1 stored before
  // that rule still decode, so their jobs can resume.
  assertCheckpointWithinBounds(decoded as Record<string, unknown>)
  return decoded as Record<string, unknown>
}
export function assertJobProgressFence(current: JobProgressFence, supplied: JobProgressFence): void { if (current.jobId !== supplied.jobId || current.workerId !== supplied.workerId || current.claimToken !== supplied.claimToken || current.attempt !== supplied.attempt) throw new StaleClaimError("Job progress ownership was lost") }
