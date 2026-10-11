import { describe, expect, it } from "vitest"
import { JOB_FINGERPRINT_VERSION, buildJobFingerprintInput, fingerprintJob, type JobFingerprintInput } from "../jobFingerprint"
import type { NewJob } from "../types"

describe("job fingerprint conformance", () => {
  const base: JobFingerprintInput = {
    executionScope: { kind: "tenant", tenantId: "tenant-1" },
    jobType: "billing.reconcile",
    jobVersion: 2,
    payload: { z: 1, nested: { b: true, a: "x" } },
    runAt: new Date("2026-08-10T12:00:00.000Z"),
    maxAttempts: 3,
    priority: 0,
    correlationId: "corr-1",
    partitionKey: null,
    metadata: { source: "test" },
  }

  const newJob: NewJob = {
    executionScope: { kind: "tenant", tenantId: "tenant-1" },
    jobType: "billing.reconcile",
    jobVersion: 2,
    payload: { z: 1 },
    runAt: base.runAt,
    correlationId: "corr-1",
    partitionKey: "schedule:schedule-1",
  }

  it("carries the current versioned contract", () => {
    expect(JOB_FINGERPRINT_VERSION).toBe(5)
  })

  it("is stable across object key order and includes the versioned contract", async () => {
    const first = await fingerprintJob(base)
    const second = await fingerprintJob({ ...base, payload: { nested: { a: "x", b: true }, z: 1 } })
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it("is deterministic for an identical durable input", async () => {
    const runAt = new Date("2026-08-10T12:00:00.000Z")
    const input = { ...base, runAt, partitionKey: "schedule:schedule-1" }
    const first = await fingerprintJob(input)
    const second = await fingerprintJob({ ...input, runAt: new Date(runAt.getTime()) })
    expect(second).toBe(first)
  })

  it("changes when the partition key changes", async () => {
    const first = await fingerprintJob(base)
    const partitioned = await fingerprintJob({ ...base, partitionKey: "schedule:schedule-1" })
    expect(partitioned).not.toBe(first)
  })

  it.each<[string, Partial<JobFingerprintInput>]>([
    ["job type", { jobType: "billing.other" }],
    ["job version", { jobVersion: 3 }],
    ["scope", { executionScope: { kind: "platform", platformKey: "default" } }],
    ["run time", { runAt: new Date("2026-08-10T12:01:00.000Z") }],
    ["retry settings", { maxAttempts: 4 }],
    ["correlation", { correlationId: "corr-2" }],
    ["partition key", { partitionKey: "schedule:other" }],
    ["metadata", { metadata: { source: "other" } }],
  ])("changes when %s changes", async (_, change) => {
    const first = await fingerprintJob(base)
    const changed = await fingerprintJob({ ...base, ...change })
    expect(changed).not.toBe(first)
  })

  it("builds the exact persisted scope and partition key into the fingerprint input", () => {
    const input = buildJobFingerprintInput({ ...newJob, executionScope: { kind: "system", systemKey: "framework" } }, base.runAt)
    expect(input.executionScope).toEqual({ kind: "system", systemKey: "framework" })
    expect(input.partitionKey).toBe("schedule:schedule-1")
    const { partitionKey: _partitionKey, ...withoutPartition } = newJob
    expect(buildJobFingerprintInput(withoutPartition, base.runAt).partitionKey).toBeNull()
  })
})
