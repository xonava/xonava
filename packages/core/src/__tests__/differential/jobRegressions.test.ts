import { describe, expect, it, vi } from "vitest"
import { DEFAULT_UNKNOWN_DEFINITION_MAX_DEFERRAL_MS, MAX_JOB_ERROR_BYTES, boundJobErrorMessage, dispatchDueJobs } from "../../execution/dispatcher"
import { buildJobFingerprintInput, fingerprintJob } from "../../execution/jobFingerprint"
import { createJobRegistry } from "../../execution/jobRegistry"
import type { JobDefinition, JobStore, NewJob, StoredJob } from "../../execution/types"

/** Minimal deterministic regressions found by the job lifecycle differential suites (jobLifecycle / jobRetry / jobFingerprint). */

const NOW = new Date("2030-01-01T00:00:00.000Z")
const clock = { now: () => NOW, sleep: async () => undefined }

function claimed(overrides: Partial<StoredJob> = {}): StoredJob {
  return {
    id: "job-1", jobType: "job", jobVersion: 1, tenantId: null, scope: "system", executionScope: { kind: "system", systemKey: "framework" }, payload: "{}", status: "running", priority: 0,
    attemptsCompleted: 0, currentAttempt: 1, runAt: NOW, nextAttemptAt: null, leaseOwner: "w", leaseExpiresAt: new Date(NOW.getTime() + 60_000), claimToken: "tok-1",
    idempotencyKey: null, fingerprint: "fp", correlationId: null, lastError: null, resultPayload: null, metadata: null, partitionKey: null, createdAt: NOW, startedAt: NOW, completedAt: null, ...overrides,
  }
}

/** A store that, like the SQL adapters, serializes the result and rejects over-long error text before touching the row. */
function setup(execute: JobDefinition["execute"], job: StoredJob = claimed(), definition: Partial<JobDefinition> = {}) {
  const store = {
    claimDue: vi.fn(async () => [job]),
    renewLease: vi.fn(async () => true),
    markSucceeded: vi.fn(async (args: { result?: Record<string, unknown> }) => { if (args.result) JSON.stringify(args.result); return { applied: true as const } }),
    markRetrying: vi.fn(async (args: { error: string }) => { if (new TextEncoder().encode(args.error).byteLength > 65_535) throw new Error("Data too long for column 'last_error'"); return { applied: true as const } }),
    markFailed: vi.fn(async (args: { error: string }) => { if (new TextEncoder().encode(args.error).byteLength > 65_535) throw new Error("Data too long for column 'last_error'"); return { applied: true as const } }),
    release: vi.fn(async () => ({ applied: true as const })),
  }
  const registry = createJobRegistry()
  registry.register({ type: "job", version: 1, scope: "system", maxAttempts: 3, retryDelayMs: 10, retryBackoffMultiplier: 2, decodePayload: (input) => input as Record<string, unknown>, execute, ...definition })
  const dispatch = (extra: { unknownDefinitionMaxDeferralMs?: number } = {}) =>
    dispatchDueJobs({ store: store as unknown as JobStore, registry, workerId: "w", leaseDurationMs: 60_000, claimLimit: 1, requester: { scope: "system" }, clock, ...extra })
  return { store, dispatch, execute }
}

describe("job result persistence", () => {
  it.each([
    ["bigint", () => ({ big: 10n })],
    ["circular reference", () => { const data: Record<string, unknown> = {}; data.self = data; return data }],
    ["throwing toJSON", () => ({ value: { toJSON: () => { throw new Error("nope") } } })],
  ])("dead-letters once, without re-running the handler, when the result (%s) cannot be serialized", async (_name, build) => {
    const execute = vi.fn(async () => ({ success: true as const, data: build() }))
    const { store, dispatch } = setup(execute)
    const result = await dispatch()
    expect(execute).toHaveBeenCalledTimes(1)
    // Before the fix markSucceeded threw, the dispatcher reported lease_lost and left the job running, so the handler ran
    // again on every later attempt until the attempts were exhausted.
    expect(store.markSucceeded).not.toHaveBeenCalled()
    expect(store.markFailed).toHaveBeenCalledWith(expect.objectContaining({ status: "dead_letter", attempt: 1, error: expect.stringContaining("not JSON-serializable") as string }))
    expect(result).toMatchObject({ claimed: 1, deadLettered: 1, leaseLost: 0, succeeded: 0 })
  })

  it("still completes jobs whose result is plain JSON", async () => {
    const { store, dispatch } = setup(async () => ({ success: true, data: { total: 3, nested: { ok: [1, "two", null] } } }))
    expect(await dispatch()).toMatchObject({ succeeded: 1 })
    expect(store.markSucceeded).toHaveBeenCalledWith(expect.objectContaining({ result: { total: 3, nested: { ok: [1, "two", null] } } }))
  })
})

describe("job failure text", () => {
  it("bounds a handler's error text before it reaches the store", async () => {
    const message = `upstream said: ${"€".repeat(40_000)}`
    const { store, dispatch } = setup(async () => { throw new Error(message) })
    const result = await dispatch()
    // Before the fix the store rejected the 120 KB text (MySQL TEXT), the job stayed running and the handler re-ran after the lease lapsed.
    expect(result).toMatchObject({ retried: 1, leaseLost: 0 })
    const stored = store.markRetrying.mock.calls[0]![0].error
    expect(new TextEncoder().encode(stored).byteLength).toBeLessThanOrEqual(MAX_JOB_ERROR_BYTES)
    expect(stored.startsWith("upstream said: ")).toBe(true)
    expect(stored.endsWith("[truncated]")).toBe(true)
    expect(stored).not.toContain("�")
  })

  it("keeps short messages untouched and never splits a multi-byte character", () => {
    expect(boundJobErrorMessage("plain")).toBe("plain")
    const exact = "a".repeat(MAX_JOB_ERROR_BYTES)
    expect(boundJobErrorMessage(exact)).toBe(exact)
    for (const unit of ["é", "€", "\u{1F600}"]) {
      for (let prefix = 0; prefix < 4; prefix++) {
        const bounded = boundJobErrorMessage(`${"x".repeat(prefix)}${unit.repeat(MAX_JOB_ERROR_BYTES)}`)
        expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(MAX_JOB_ERROR_BYTES)
        expect(bounded).not.toContain("�")
      }
    }
  })
})

describe("unknown-definition deferral window", () => {
  const ghost = (since: Date) => claimed({ jobType: "ghost", lastError: `Unknown job definition: ghost@1 (unrunnable since ${since.toISOString()})` })

  it("uses a 24 hour default window: still deferred at exactly 24h, dead-lettered one millisecond later", async () => {
    expect(DEFAULT_UNKNOWN_DEFINITION_MAX_DEFERRAL_MS).toBe(24 * 60 * 60 * 1000)
    const atLimit = setup(async () => ({ success: true }), ghost(new Date(NOW.getTime() - DEFAULT_UNKNOWN_DEFINITION_MAX_DEFERRAL_MS)))
    expect(await atLimit.dispatch()).toMatchObject({ retried: 1, deadLettered: 0 })
    expect(atLimit.store.release).toHaveBeenCalledOnce()

    const past = setup(async () => ({ success: true }), ghost(new Date(NOW.getTime() - DEFAULT_UNKNOWN_DEFINITION_MAX_DEFERRAL_MS - 1)))
    expect(await past.dispatch()).toMatchObject({ retried: 0, deadLettered: 1 })
    expect(past.store.markFailed).toHaveBeenCalledWith(expect.objectContaining({ status: "dead_letter", error: expect.stringMatching(/^UNKNOWN_JOB_DEFINITION: /) as string }))
  })

  it("honours a custom window and restarts it when the marker lies in the future", async () => {
    const custom = setup(async () => ({ success: true }), ghost(new Date(NOW.getTime() - 101)))
    expect(await custom.dispatch({ unknownDefinitionMaxDeferralMs: 100 })).toMatchObject({ deadLettered: 1 })
    const future = setup(async () => ({ success: true }), ghost(new Date(NOW.getTime() + 10_000)))
    expect(await future.dispatch({ unknownDefinitionMaxDeferralMs: 100 })).toMatchObject({ retried: 1, deadLettered: 0 })
    expect(future.store.release).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining(`unrunnable since ${NOW.toISOString()}`) as string, nextAttemptAt: new Date(NOW.getTime() + 60_000) }))
  })
})

describe("job fingerprint and the attempt budget", () => {
  const job: NewJob = { executionScope: { kind: "system", systemKey: "framework" }, jobType: "job", jobVersion: 1, payload: { a: 1 }, runAt: NOW, idempotencyKey: "k" }

  // NOT FIXED (needs a decision): buildJobFingerprintInput maps an omitted maxAttempts to 3, but the stores persist an
  // omitted maxAttempts as JOB_MAX_ATTEMPTS_FROM_DEFINITION, i.e. "use the definition's budget". An idempotent re-enqueue
  // that explicitly asks for 3 attempts therefore matches (and replays) a job whose real budget is the definition's, and
  // the reverse. Fixing it means a fingerprint version bump plus a compatibility match for stored version-4 values; the
  // encoding suite (encodingIdentity.test.ts, "documented defaults") currently asserts the old equivalence.
  it.fails("distinguishes an omitted maxAttempts (definition budget) from an explicit maxAttempts of 3", async () => {
    const omitted = await fingerprintJob(buildJobFingerprintInput(job, NOW))
    const explicit = await fingerprintJob(buildJobFingerprintInput({ ...job, maxAttempts: 3 }, NOW))
    expect(explicit).not.toBe(omitted)
  })
})

describe("lease loss while a synchronous handler failure is being recorded", () => {
  it("does not leave an unhandled rejection behind", async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => { unhandled.push(reason) }
    process.on("unhandledRejection", listener)
    try {
      // execute() throws before the dispatcher starts racing the handler against its lease-lost signal.
      const { store, dispatch } = setup((() => { throw new Error("sync failure") }) as JobDefinition["execute"], claimed(), { maxAttempts: 3 })
      // The re-fence succeeds; the heartbeat renewal then reports the lease as lost while markRetrying is still in flight.
      store.renewLease.mockResolvedValueOnce(true).mockResolvedValue(false)
      store.markRetrying.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { applied: true as const } })
      const result = await dispatch()
      expect(result.claimed).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", listener)
    }
  })
})
