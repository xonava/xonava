import type { NewJob } from "./types"
import type { JobExecutionScope } from "./types"
import { canonicalJsonString } from "../serialization/canonicalJson"

export const JOB_FINGERPRINT_VERSION = 3

export interface JobFingerprintInput {
  executionScope: JobExecutionScope
  jobType: string
  jobVersion: number
  payload: Record<string, unknown>
  runAt: Date
  maxAttempts: number
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
    maxAttempts: job.maxAttempts ?? 3,
    priority: job.priority ?? 0,
    correlationId: job.correlationId ?? null,
    partitionKey: job.partitionKey ?? null,
    metadata: job.metadata ?? null,
  }
}

export async function fingerprintJob(input: JobFingerprintInput): Promise<string> {
  // Canonical JSON rejects Date values, so the run time is normalized to an
  // ISO string primitive before canonicalization to keep the digest durable.
  const canonical = canonicalJsonString({
    version: JOB_FINGERPRINT_VERSION,
    job: { ...input, runAt: input.runAt.toISOString() },
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
