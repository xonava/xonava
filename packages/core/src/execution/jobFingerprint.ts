import type { NewJob } from "./types"
import type { JobExecutionScope } from "./types"
import { canonicalJsonString, legacyJavaScriptOrderJsonString } from "../serialization/canonicalJson"

/**
 * 4: canonical JSON in RFC 8785 key order. 3 serialized integer-like object
 * keys in JavaScript property order; stored version-3 fingerprints are still
 * recognised by {@link jobFingerprintMatches}.
 */
export const JOB_FINGERPRINT_VERSION = 4
/** The previous version, accepted (never written) by {@link jobFingerprintMatches}. */
const LEGACY_JOB_FINGERPRINT_VERSION = 3

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

/**
 * Whether a persisted fingerprint identifies this job: the current version, or
 * a version-3 fingerprint written before the RFC 8785 key-order fix (so an
 * idempotent re-enqueue across that deploy replays instead of conflicting).
 */
export async function jobFingerprintMatches(stored: string, input: JobFingerprintInput): Promise<boolean> {
  if (typeof stored !== "string" || stored.length === 0) return false
  if (stored === (await fingerprintJob(input))) return true
  return stored === (await sha256Hex(legacyJavaScriptOrderJsonString(fingerprintMaterial(input, LEGACY_JOB_FINGERPRINT_VERSION))))
}
