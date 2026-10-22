import type { Release, ReleaseOps } from "./releases.js"
import { sha256Hex } from "./releases.js"

/**
 * Inputs shared by the upgrade suites, with the digests the previous release (0.1.0) produced for them. The pinned
 * digests are golden values: a format that drifts identically in both releases' code under test still fails here.
 */
export const RUN_AT = new Date("2030-06-01T00:00:00.000Z")

/** A job whose payload has integer-like keys ("10", "2"): RFC 8785 order and JavaScript property order disagree on them. */
export const fingerprintJobBase = {
  executionScope: { kind: "tenant", tenantId: "tenant-1" },
  jobType: "report.generate",
  jobVersion: 2,
  payload: { b: 1, "10": "x", "2": [1, { z: null, a: true }], a: "é" },
  runAt: RUN_AT,
  priority: 0,
  correlationId: "corr-1",
  metadata: { source: "upgrade" },
}

export const GOLDEN = {
  jobExplicitAttempts5: "7f87bcdac427dd6637c79c455e368fe0b27af406840585db9be40dd0d4ef3af2",
  jobOmittedAttempts: "0462d83cfe57fcb1ca24cb4faa6adac2a4991b64aa031e5187cdd9d81d41dcea",
  fingerprintJson: "593064ae40ccd8e03a39314d85d6d09292af7221902c8996cabc3447d9b004c3",
  legacyFingerprintJson: "b4f601ba3ae66ecda82538ca714abf9e7c9b9d59a973bbd1cdbe06aa38d2bff1",
  outbox: "v3:268ce5b6bd7b9b7653818a6807cfebf570839aeda1c69e78c12e0ce52a86e7dc",
  cursor: "v1.eyJkaXJlY3Rpb24iOiJhZnRlciIsImZvcm1hdCI6ImZyYW1ld29yay5jdXJzb3IiLCJxdWVyeUhhc2giOiJxdWVyeS1oIiwicm91dGVIYXNoIjoicm91dGUtaCIsInNjb3BlSGFzaCI6InNjb3BlLWgiLCJzb3J0SGFzaCI6InNvcnQtaCIsInZhbHVlcyI6WyJyLTEwMCIsNDIsdHJ1ZSxudWxsXSwidmVyc2lvbiI6MX0.jVwDsD8jhT5VEtnBxZ8eMr0PEZrloA9-6foI4PJg02E",
} as const

export const CURSOR_SECRET = "upgrade-compat-cursor-key"
export const cursorPayload = { format: "framework.cursor", version: 1, direction: "after", values: ["r-100", 42, true, null], routeHash: "route-h", queryHash: "query-h", scopeHash: "scope-h", sortHash: "sort-h" } as const

/** Request material with integer-like keys, as the write handler fingerprints it. */
export const idempotencyMaterial = { b: 1, "10": "x", "2": [1, { z: null, a: true }], a: "é", nested: { y: 2, x: [3, 2, 1] } }

export const outboxScope = { kind: "tenant", tenantId: "tenant-1" } as const

export function outboxRecord(ops: ReleaseOps, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type: "order.created",
    version: 1,
    tenantId: "tenant-1",
    scope: outboxScope,
    scopeId: ops.encodeExecutionScopeId(outboxScope),
    aggregateType: "order",
    aggregateId: "o-1",
    payload: idempotencyMaterial,
    idempotencyKey: "evt-key-1",
    occurredAt: RUN_AT,
    ...overrides,
  }
}

/**
 * The fingerprint a job stored by a release before 0.1.0 carries. Versions 4 and 3 encoded an omitted `maxAttempts` as 3;
 * version 4 already used RFC 8785 order, version 3 used JavaScript property order. `ops` supplies the serializers, so the
 * legacy digest is what the named release's canonicalizer produces for the legacy material.
 */
export async function legacyJobFingerprint(ops: ReleaseOps, version: 4 | 3, job: Record<string, unknown>): Promise<string> {
  const input = ops.buildJobFingerprintInput(job, job.runAt as Date)
  const material = { version, job: { ...input, maxAttempts: input.maxAttempts ?? 3, runAt: (input.runAt as Date).toISOString() } }
  return sha256Hex(version === 4 ? ops.canonicalJsonString(material) : ops.legacyJavaScriptOrderJsonString(material))
}

/** The `v2:` outbox fingerprint written before the RFC 8785 key-order fix. */
export async function legacyOutboxFingerprint(ops: ReleaseOps, record: Record<string, unknown>): Promise<string> {
  const material = { type: record.type, version: record.version, scopeId: record.scopeId, aggregateType: record.aggregateType, aggregateId: record.aggregateId, payload: record.payload }
  return `v2:${await sha256Hex(ops.legacyJavaScriptOrderJsonString(material))}`
}

export const releaseLabel = (release: Release): string => (release === "0.1.0" ? "0.1.0" : "current")
