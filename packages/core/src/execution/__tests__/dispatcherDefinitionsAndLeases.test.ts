import { describe, expect, it, vi } from "vitest"
import { dispatchDueJobs, type DispatcherClock, type DispatcherConfig } from "../dispatcher"
import { createJobRegistry, JobDefinitionUnavailableError, type JobPayloadUpcaster } from "../jobRegistry"
import { decodeStoredJobMaxAttempts, encodeStoredJobMaxAttempts, JOB_MAX_ATTEMPTS_FROM_DEFINITION } from "../types"
import type { JobDefinition, JobExecution, JobStore, StoredJob } from "../types"
import { buildJobFingerprintInput } from "../jobFingerprint"

const now = new Date("2026-10-01T00:00:00.000Z")

function storedJob(overrides: Partial<StoredJob> = {}): StoredJob {
  return { id: "j", jobType: "invoice", jobVersion: 1, tenantId: null, scope: "system", executionScope: { kind: "system", systemKey: "framework" }, payload: "{\"amount\":5}", status: "running", priority: 0, attemptsCompleted: 0, currentAttempt: 1, maxAttempts: 3, runAt: now, nextAttemptAt: null, leaseOwner: "w", leaseExpiresAt: new Date(now.getTime() + 1_000), claimToken: "claim-1", idempotencyKey: null, fingerprint: "fp", correlationId: null, lastError: null, resultPayload: null, metadata: null, partitionKey: null, createdAt: now, startedAt: now, completedAt: null, ...overrides }
}

function memoryStore(job: StoredJob) {
  const applied = { applied: true as const }
  return {
    enqueue: vi.fn(), getById: vi.fn(), getByCorrelationId: vi.fn(), getLatestPriorScheduleExecution: vi.fn(), getByIdempotencyKey: vi.fn(), cancel: vi.fn(), findPending: vi.fn(),
    claimDue: vi.fn(async () => [job]),
    renewLease: vi.fn(async () => true),
    markSucceeded: vi.fn(async () => applied),
    markRetrying: vi.fn(async () => applied),
    markFailed: vi.fn(async () => applied),
    release: vi.fn(async () => applied),
  } satisfies JobStore
}

function definition(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return { type: "invoice", version: 1, scope: "system", maxAttempts: 3, retryDelayMs: 10, retryBackoffMultiplier: 1, decodePayload: (input) => input as Record<string, unknown>, execute: async () => ({ success: true }), ...overrides }
}

const fixedClock = (at: Date = now): DispatcherClock => ({ now: () => new Date(at.getTime()), sleep: (_ms, signal) => new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })) })

function config(store: JobStore, registry: ReturnType<typeof createJobRegistry>, extra: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return { store, registry, workerId: "w", leaseDurationMs: 1_000, claimLimit: 1, requester: { scope: "system" }, clock: fixedClock(), ...extra }
}

describe("job dispatcher resolves definitions through registry upcasters", () => {
  const upcasters: JobPayloadUpcaster[] = [{ type: "invoice", from: 1, to: 2, upcast: (payload) => ({ amountCents: (payload as { amount: number }).amount * 100 }) }]

  it("runs an old-version job on the latest definition with its upcast payload", async () => {
    const seen: unknown[] = []
    const registry = createJobRegistry({ upcasters })
    registry.register(definition({ version: 2, execute: async (execution) => { seen.push(execution.payload); return { success: true } } }))
    const store = memoryStore(storedJob())
    const result = await dispatchDueJobs(config(store, registry))
    expect(result).toMatchObject({ succeeded: 1, retried: 0 })
    expect(seen).toEqual([{ amountCents: 500 }])
    expect(store.release).not.toHaveBeenCalled()
  })

  it("releases a job whose version this worker cannot run (newer version or missing upcaster) for another worker", async () => {
    for (const [job, registered] of [[storedJob({ jobVersion: 3 }), 2], [storedJob({ jobVersion: 1 }), 2]] as const) {
      const registry = createJobRegistry() // no upcasters
      registry.register(definition({ version: registered }))
      const store = memoryStore(job)
      await expect(dispatchDueJobs(config(store, registry))).resolves.toMatchObject({ retried: 1, deadLettered: 0 })
      expect(store.release).toHaveBeenCalledTimes(1)
      expect(store.markFailed).not.toHaveBeenCalled()
    }
  })

  it("measures the deferral window from the first deferral, not from when the job became due", async () => {
    const registry = createJobRegistry()
    registry.register(definition({ type: "other" }))
    // Due for two days (backlog / long retry chain), first touched by a worker lacking its definition.
    const longDue = new Date(now.getTime() - 48 * 3_600_000)
    const store = memoryStore(storedJob({ jobType: "retired", runAt: longDue, createdAt: longDue, lastError: "earlier failure" }))
    await expect(dispatchDueJobs(config(store, registry))).resolves.toMatchObject({ retried: 1, deadLettered: 0 })
    expect(store.markFailed).not.toHaveBeenCalled()
    expect(store.release).toHaveBeenCalledWith(expect.objectContaining({ reason: `Unknown job definition: retired@1 (unrunnable since ${now.toISOString()})` }))
  })

  it("keeps the first-deferral marker across releases and dead-letters once the window has passed", async () => {
    const registry = createJobRegistry()
    registry.register(definition({ type: "other" }))
    const firstDeferral = new Date(now.getTime() - 3_600_000)
    const marker = `Unknown job definition: retired@1 (unrunnable since ${firstDeferral.toISOString()})`
    const within = memoryStore(storedJob({ jobType: "retired", lastError: marker }))
    await expect(dispatchDueJobs(config(within, registry))).resolves.toMatchObject({ retried: 1 })
    expect(within.release).toHaveBeenCalledWith(expect.objectContaining({ reason: marker }))

    const expired = memoryStore(storedJob({ jobType: "retired", maxAttempts: undefined, lastError: marker }))
    const result = await dispatchDueJobs(config(expired, registry, { unknownDefinitionMaxDeferralMs: 3_599_999 }))
    expect(result).toMatchObject({ deadLettered: 1, retried: 0 })
    expect(expired.release).not.toHaveBeenCalled()
    expect(expired.markFailed).toHaveBeenCalledWith(expect.objectContaining({ status: "dead_letter", attempt: 1, error: expect.stringContaining("UNKNOWN_JOB_DEFINITION") }))
  })

  it("ignores a malformed or future first-deferral marker", async () => {
    const registry = createJobRegistry()
    registry.register(definition({ type: "other" }))
    for (const lastError of ["x (unrunnable since not-a-date)", `x (unrunnable since ${new Date(now.getTime() + 86_400_000).toISOString()})`]) {
      const store = memoryStore(storedJob({ jobType: "retired", lastError }))
      await expect(dispatchDueJobs(config(store, registry, { unknownDefinitionMaxDeferralMs: 0 }))).resolves.toMatchObject({ retried: 1 })
    }
  })

  it("dead-letters invalid upcast payloads rather than releasing them", async () => {
    const registry = createJobRegistry({ upcasters: [{ type: "invoice", from: 1, to: 2, upcast: () => { throw new Error("cannot upcast") } }] })
    registry.register(definition({ version: 2 }))
    const store = memoryStore(storedJob())
    await expect(dispatchDueJobs(config(store, registry))).resolves.toMatchObject({ deadLettered: 1 })
    expect(store.release).not.toHaveBeenCalled()
  })

  it("registry resolution failures are typed", () => {
    const registry = createJobRegistry()
    registry.register(definition({ version: 2 }))
    expect(() => registry.decode("invoice", 1, {})).toThrow(JobDefinitionUnavailableError)
    expect(() => registry.decode("invoice", 3, {})).toThrow(JobDefinitionUnavailableError)
    expect(() => registry.decode("nope", 1, {})).toThrow(JobDefinitionUnavailableError)
  })
})

describe("job definition maxAttempts", () => {
  it("applies the definition's maxAttempts to a job stored without an explicit budget", async () => {
    const registry = createJobRegistry()
    registry.register(definition({ maxAttempts: 5, execute: async () => ({ success: false }) }))
    const store = memoryStore(storedJob({ maxAttempts: undefined, currentAttempt: 3, attemptsCompleted: 2 }))
    await expect(dispatchDueJobs(config(store, registry))).resolves.toMatchObject({ retried: 1, deadLettered: 0 })
    const fewer = createJobRegistry()
    fewer.register(definition({ maxAttempts: 2 }))
    const exhausted = memoryStore(storedJob({ maxAttempts: undefined, currentAttempt: 3, attemptsCompleted: 2 }))
    await expect(dispatchDueJobs(config(exhausted, fewer))).resolves.toMatchObject({ deadLettered: 1 })
  })

  it("stores an omitted budget as the definition sentinel and keeps fingerprints stable", () => {
    expect(encodeStoredJobMaxAttempts(undefined)).toBe(JOB_MAX_ATTEMPTS_FROM_DEFINITION)
    expect(encodeStoredJobMaxAttempts(4)).toBe(4)
    expect(decodeStoredJobMaxAttempts(JOB_MAX_ATTEMPTS_FROM_DEFINITION)).toBeUndefined()
    expect(decodeStoredJobMaxAttempts(4)).toBe(4)
    expect(decodeStoredJobMaxAttempts("7")).toBe(7)
    // Fingerprint v5 keeps an omitted budget distinct from every explicit number (v3/v4 treated it as 3).
    expect(buildJobFingerprintInput({ executionScope: { kind: "system", systemKey: "framework" }, jobType: "x", jobVersion: 1, payload: {} }, now).maxAttempts).toBeNull()
  })
})

describe("job dispatcher lease fencing after the claim ends", () => {
  it("rejects fenced effects and stops renewing once a stalled job is abandoned", async () => {
    let context!: JobExecution
    const registry = createJobRegistry()
    registry.register(definition({ execute: (execution) => { context = execution; return new Promise(() => undefined) } }))
    const store = memoryStore(storedJob())
    const result = await dispatchDueJobs(config(store, registry, { leaseDurationMs: 60, timeoutPolicy: { mode: "cooperative", timeoutMs: 5, cancellationGraceMs: 5 } }))
    expect(result.stalled).toBe(1)
    const renewals = store.renewLease.mock.calls.length
    const effect = vi.fn(async () => "done")
    await expect(context.fencedEffect.execute({ effectName: "charge", idempotencyKey: "k", fn: effect })).rejects.toThrow(/lease/i)
    expect(effect).not.toHaveBeenCalled()
    expect(store.renewLease.mock.calls.length).toBe(renewals)
  })

  it("keeps the lease heartbeat alive until the retry transition commits", async () => {
    const wakeHeartbeat: (() => void)[] = []
    const clock: DispatcherClock = { now: () => new Date(now), sleep: (_ms, signal) => new Promise<void>((resolve) => { wakeHeartbeat.push(resolve); signal?.addEventListener("abort", () => resolve(), { once: true }) }) }
    const registry = createJobRegistry()
    registry.register(definition({ execute: async () => ({ success: false }) }))
    const store = memoryStore(storedJob())
    let finishRetry!: () => void
    let retryStarted!: () => void
    const started = new Promise<void>((resolve) => { retryStarted = resolve })
    store.markRetrying.mockImplementation(async () => { retryStarted(); await new Promise<void>((resolve) => { finishRetry = resolve }); return { applied: true } })
    const run = dispatchDueJobs(config(store, registry, { clock }))
    await started
    const before = store.renewLease.mock.calls.length
    wakeHeartbeat.at(-1)!()
    await vi.waitFor(() => expect(store.renewLease.mock.calls.length).toBe(before + 1))
    finishRetry()
    await expect(run).resolves.toMatchObject({ retried: 1 })
  })
})
