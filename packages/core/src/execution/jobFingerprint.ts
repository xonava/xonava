import type { NewJob } from "./types"
import type { JobExecutionScope } from "./types"
import { canonicalJsonString } from "../serialization/canonicalJson"

/**
 * 5: canonical JSON in RFC 8785 key order; an omitted `maxAttempts` (the job
 * uses its definition's budget) is encoded as `null`, distinct from any
 * explicit number.
 */
export const JOB_FINGERPRINT_VERSION = 5

export interface JobFingerprintInput {
  executionScope: JobExecutionScope
  jobType: string
  jobVersion: number
  payload: Record<string, unknown>
  runAt: Date
  /** `null` when the job omits it and so uses its definition's budget. */
  maxAttempts: number | null
  priority: number
  correlationId: string | null
  partitionKey: string | null
  metadata: Record<string, unknown> | null
}

export function buildJobFingerprintInput(job: NewJob, runAt: Date): JobFingerprintInput {
  return {
    executionScope: job.executionScope,
    jobType: job.jobType,
    jobVersion: job.jobVersion,
    payload: job.payload,
    runAt,
    maxAttempts: job.maxAttempts ?? null,
    priority: job.priority ?? 0,
    correlationId: job.correlationId ?? null,
    partitionKey: job.partitionKey ?? null,
    metadata: job.metadata ?? null,
  }
}

function fingerprintMaterial(input: JobFingerprintInput, version: number): { version: number; job: Omit<JobFingerprintInput, "runAt"> & { runAt: string } } {
  // Canonical JSON rejects Date values, so the run time is normalized to an
  // ISO string primitive before canonicalization to keep the digest durable.
  return { version, job: { ...input, runAt: input.runAt.toISOString() } }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function fingerprintJob(input: JobFingerprintInput): Promise<string> {
  return sha256Hex(canonicalJsonString(fingerprintMaterial(input, JOB_FINGERPRINT_VERSION)))
}

/** Whether a persisted fingerprint is exactly the current-version fingerprint of this job. */
export async function jobFingerprintMatches(stored: string, input: JobFingerprintInput): Promise<boolean> {
  if (typeof stored !== "string" || stored.length === 0) return false
  return stored === (await fingerprintJob(input))
}
