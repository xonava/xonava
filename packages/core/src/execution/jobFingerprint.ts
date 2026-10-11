import type { NewJob } from "./types"
import type { JobExecutionScope } from "./types"
import { canonicalJsonString, legacyJavaScriptOrderJsonString } from "../serialization/canonicalJson"

/**
 * 5: an omitted `maxAttempts` (the job uses its definition's budget) is encoded
 * as `null`, distinct from any explicit number. 4 canonicalised an omitted
 * value to 3 (so it replayed jobs with an explicit budget of 3, and the
 * reverse) but already used canonical JSON in RFC 8785 key order. 3 serialized
 * integer-like object keys in JavaScript property order and also mapped an
 * omitted budget to 3. Stored version-4 and version-3 fingerprints are still
 * recognised by {@link jobFingerprintMatches} through their exact legacy
 * constructions.
 */
export const JOB_FINGERPRINT_VERSION = 5
/** Versions accepted (never written) by {@link jobFingerprintMatches}. */
const V4_JOB_FINGERPRINT_VERSION = 4
const V3_JOB_FINGERPRINT_VERSION = 3
/** The attempt budget versions 3 and 4 assumed when `maxAttempts` was omitted. */
const LEGACY_OMITTED_MAX_ATTEMPTS = 3

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

/** Versions 3 and 4 had no encoding for an omitted budget and wrote 3 for it. */
function legacyMaterial(input: JobFingerprintInput, version: number): ReturnType<typeof fingerprintMaterial> {
  return fingerprintMaterial({ ...input, maxAttempts: input.maxAttempts ?? LEGACY_OMITTED_MAX_ATTEMPTS }, version)
}

/**
 * Whether a persisted fingerprint identifies this job: the current version, a
 * version-4 fingerprint (written before an omitted maxAttempts was encoded
 * distinctly), or a version-3 fingerprint written before the RFC 8785 key-order
 * fix, so an idempotent re-enqueue across those deploys replays instead of
 * conflicting. Legacy digests cannot tell an omitted budget from an explicit 3,
 * so both match them.
 */
export async function jobFingerprintMatches(stored: string, input: JobFingerprintInput): Promise<boolean> {
  if (typeof stored !== "string" || stored.length === 0) return false
  if (stored === (await fingerprintJob(input))) return true
  if (stored === (await sha256Hex(canonicalJsonString(legacyMaterial(input, V4_JOB_FINGERPRINT_VERSION))))) return true
  return stored === (await sha256Hex(legacyJavaScriptOrderJsonString(legacyMaterial(input, V3_JOB_FINGERPRINT_VERSION))))
}
