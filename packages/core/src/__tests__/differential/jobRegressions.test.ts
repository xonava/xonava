import { describe, expect, it, vi } from "vitest"
import { DEFAULT_UNKNOWN_DEFINITION_MAX_DEFERRAL_MS, MAX_JOB_ERROR_BYTES, boundJobErrorMessage, dispatchDueJobs } from "../../execution/dispatcher"
import { buildJobFingerprintInput, fingerprintJob, jobFingerprintMatches } from "../../execution/jobFingerprint"
import { canonicalJsonString } from "../../serialization/canonicalJson"
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

describe("unknown-definition deferral survives a transient release failure", () => {
  const ghost = () => claimed({ jobType: "ghost", maxAttempts: 1, lastError: null })

  it("retries the release once instead of consuming the attempt budget through markRetrying", async () => {
    const { store, dispatch } = setup(async () => ({ success: true }), ghost())
    store.release.mockRejectedValueOnce(new Error("connection reset"))
    const result = await dispatch()
    // Before the fix a single failed release fell through to markRetrying (which spends an attempt) and then to markFailed.
    expect(store.release).toHaveBeenCalledTimes(2)
    expect(store.markRetrying).not.toHaveBeenCalled()
    expect(store.markFailed).not.toHaveBeenCalled()
    expect(result).toMatchObject({ retried: 1, deadLettered: 0, leaseLost: 0 })
  })

  it("does not retry a release that was answered (not applied): the lease is lost", async () => {
    const { store, dispatch } = setup(async () => ({ success: true }), ghost())
    store.release.mockResolvedValue({ applied: false as never })
    expect(await dispatch()).toMatchObject({ leaseLost: 1, retried: 0 })
    expect(store.release).toHaveBeenCalledTimes(1)
  })

  it("still falls back to markRetrying when the release keeps failing", async () => {
    const { store, dispatch } = setup(async () => ({ success: true }), ghost())
    store.release.mockRejectedValue(new Error("store down"))
    expect(await dispatch()).toMatchObject({ retried: 1 })
    expect(store.release).toHaveBeenCalledTimes(2)
    expect(store.markRetrying).toHaveBeenCalledTimes(1)
  })
})

describe("hand-back time is stamped from the clock when each store call is issued", () => {
  // Found by job dispatcher "random interleavings" (seed 4259685034, run 1229): a release failed after store latency while the
  // worker's clock skew moved by -9 ms, so the retried release carried max(previous, now + lease) = +61 ms instead of +60 ms.
  const ghost = () => claimed({ jobType: "ghost", maxAttempts: 1, lastError: null })

  function skewedSetup(job: StoredJob) {
    let reading = NOW.getTime()
    const skewedClock = { now: () => new Date(reading), sleep: async () => undefined }
    const store = {
      claimDue: vi.fn(async () => [job]),
      renewLease: vi.fn(async () => true),
      markSucceeded: vi.fn(async () => ({ applied: true as const })),
      markRetrying: vi.fn(async () => ({ applied: true as const })),
      markFailed: vi.fn(async () => ({ applied: true as const })),
      release: vi.fn(async () => ({ applied: true as const })),
    }
    const dispatch = () => dispatchDueJobs({ store: store as unknown as JobStore, registry: createJobRegistry(), workerId: "w", leaseDurationMs: 60, claimLimit: 1, requester: { scope: "system" }, clock: skewedClock })
    return { store, dispatch, move: (deltaMs: number) => { reading += deltaMs } }
  }

  const nextAttemptsOf = (mock: { mock: { calls: unknown[][] } }): number[] => mock.mock.calls.map((call) => (call[0] as { nextAttemptAt: Date }).nextAttemptAt.getTime())

  it("stamps the retried release with the clock reading at the retry, even when the clock moved backwards during the failed call", async () => {
    const { store, dispatch, move } = skewedSetup(ghost())
    // The first release takes 8 ms to fail, and the worker's clock skew changes by -9 ms meanwhile: the clock reads 1 ms earlier.
    store.release.mockImplementationOnce(async () => { move(8 - 9); throw new Error("store unavailable") })
    expect(await dispatch()).toMatchObject({ retried: 1, leaseLost: 0, deadLettered: 0 })
    // Before the fix the second call was clamped to the first call's stamp: [NOW + 60, NOW + 60] instead of [NOW + 60, NOW - 1 + 60].
    expect(nextAttemptsOf(store.release)).toEqual([NOW.getTime() + 60, NOW.getTime() - 1 + 60])
  })

  it("stamps the retried release with a later reading when the failed call was slow", async () => {
    const { store, dispatch, move } = skewedSetup(ghost())
    store.release.mockImplementationOnce(async () => { move(36); throw new Error("store unavailable") })
    expect(await dispatch()).toMatchObject({ retried: 1 })
    expect(nextAttemptsOf(store.release)).toEqual([NOW.getTime() + 60, NOW.getTime() + 36 + 60])
  })

  it("stamps the markRetrying fallback with the clock reading when it is issued", async () => {
    const { store, dispatch, move } = skewedSetup(ghost())
    store.release.mockImplementation(async () => { move(5); throw new Error("store down") })
    expect(await dispatch()).toMatchObject({ retried: 1 })
    expect(nextAttemptsOf(store.release)).toEqual([NOW.getTime() + 60, NOW.getTime() + 5 + 60])
    expect(nextAttemptsOf(store.markRetrying)).toEqual([NOW.getTime() + 10 + 60])
  })
})

describe("job fingerprint and the attempt budget", () => {
  const job: NewJob = { executionScope: { kind: "system", systemKey: "framework" }, jobType: "job", jobVersion: 1, payload: { a: 1 }, runAt: NOW, idempotencyKey: "k" }

  // buildJobFingerprintInput used to map an omitted maxAttempts to 3, but the stores persist it as
  // JOB_MAX_ATTEMPTS_FROM_DEFINITION ("use the definition's budget"), so an idempotent re-enqueue that explicitly
  // asked for 3 attempts replayed a job whose real budget was the definition's, and the reverse. Fingerprint
  // version 5 encodes an omitted budget as null; version-4 digests are no longer recognised.
  it("distinguishes an omitted maxAttempts (definition budget) from an explicit maxAttempts of 3", async () => {
    const omitted = await fingerprintJob(buildJobFingerprintInput(job, NOW))
    const explicit = await fingerprintJob(buildJobFingerprintInput({ ...job, maxAttempts: 3 }, NOW))
    expect(explicit).not.toBe(omitted)
    expect(buildJobFingerprintInput(job, NOW).maxAttempts).toBeNull()
    await expect(jobFingerprintMatches(omitted, buildJobFingerprintInput({ ...job, maxAttempts: 3 }, NOW))).resolves.toBe(false)
    await expect(jobFingerprintMatches(explicit, buildJobFingerprintInput(job, NOW))).resolves.toBe(false)
  })

  it("no longer recognises a stored version-4 digest (which wrote 3 for an omitted budget)", async () => {
    const v4 = async (maxAttempts: number): Promise<string> => {
      const { runAt, ...rest } = buildJobFingerprintInput(job, NOW)
      const text = canonicalJsonString({ version: 4, job: { ...rest, maxAttempts, runAt: runAt.toISOString() } })
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("")
    }
    await expect(jobFingerprintMatches(await v4(3), buildJobFingerprintInput(job, NOW))).resolves.toBe(false)
    await expect(jobFingerprintMatches(await v4(3), buildJobFingerprintInput({ ...job, maxAttempts: 3 }, NOW))).resolves.toBe(false)
    await expect(jobFingerprintMatches(await v4(4), buildJobFingerprintInput({ ...job, maxAttempts: 4 }, NOW))).resolves.toBe(false)
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

describe("one claimed job's setup failure stays with that job", () => {
  function batch(extra: Partial<Parameters<typeof dispatchDueJobs>[0]>, clockOverride = clock) {
    const jobs = [claimed({ id: "job-1", claimToken: "tok-1" }), claimed({ id: "job-2", claimToken: "tok-2" })]
    const store = {
      claimDue: vi.fn(async () => jobs),
      renewLease: vi.fn(async () => true),
      markSucceeded: vi.fn(async () => ({ applied: true as const })),
      markRetrying: vi.fn(async () => ({ applied: true as const })),
      markFailed: vi.fn(async () => ({ applied: true as const })),
      release: vi.fn(async () => ({ applied: true as const })),
    }
    const ran: string[] = []
    const registry = createJobRegistry()
    registry.register({ type: "job", version: 1, scope: "system", maxAttempts: 3, retryDelayMs: 10, retryBackoffMultiplier: 2, decodePayload: (input) => input as Record<string, unknown>, execute: async (ctx) => { ran.push(ctx.jobId); return { success: true as const } } })
    const dispatch = () => dispatchDueJobs({ store: store as unknown as JobStore, registry, workerId: "w", leaseDurationMs: 60_000, claimLimit: 2, requester: { scope: "system" }, clock: clockOverride, ...extra })
    return { store, dispatch, ran }
  }

  it("still runs the remaining claimed jobs when the idGenerator throws for one of them", async () => {
    let calls = 0
    const { store, dispatch, ran } = batch({ idGenerator: () => { if (++calls === 1) throw new Error("id source down"); return `exec-${calls}` } })
    // Before the fix the throw rejected dispatchDueJobs, so job-2 was never run and stayed claimed until its lease lapsed.
    const result = await dispatch()
    expect(ran).toEqual(["job-2"])
    expect(result).toMatchObject({ claimed: 2, succeeded: 1, retried: 1, leaseLost: 0 })
    expect(result.errors).toEqual([expect.objectContaining({ jobId: "job-1", action: "retry", error: expect.stringContaining("id source down") as string })])
    expect(store.markSucceeded).toHaveBeenCalledTimes(1)
  })

  it("releases the job whose setup failed, without consuming an attempt, instead of leaving it claimed until its lease lapses", async () => {
    let calls = 0
    const { store, dispatch } = batch({ idGenerator: () => { if (++calls === 1) throw new Error("id source down"); return `exec-${calls}` } })
    await dispatch()
    // Before the fix the job was reported lease_lost and never released: it waited out its whole lease.
    expect(store.release).toHaveBeenCalledTimes(1)
    expect(store.release).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", workerId: "w", claimToken: "tok-1", nextAttemptAt: new Date(NOW.getTime() + 60_000), reason: expect.stringContaining("id source down") as string }))
    expect(store.markRetrying).not.toHaveBeenCalled()
    expect(store.markFailed).not.toHaveBeenCalled()
  })

  it("reports lease_lost when the store cannot release (not applied, throws, or no release primitive) and still runs the rest", async () => {
    const failures: Array<(store: ReturnType<typeof batch>["store"]) => void> = [
      (store) => store.release.mockResolvedValue({ applied: false as never }),
      (store) => store.release.mockRejectedValue(new Error("store down")),
      (store) => { delete (store as { release?: unknown }).release },
    ]
    for (const breakRelease of failures) {
      let calls = 0
      const { store, dispatch, ran } = batch({ idGenerator: () => { if (++calls === 1) throw new Error("id source down"); return `exec-${calls}` } })
      breakRelease(store)
      const result = await dispatch()
      expect(ran).toEqual(["job-2"])
      expect(result).toMatchObject({ claimed: 2, succeeded: 1, retried: 0, leaseLost: 1 })
      expect(result.errors).toEqual([expect.objectContaining({ jobId: "job-1", action: "lease_lost" })])
    }
  })

  it("releases with a fallback run time when the configured clock keeps throwing", async () => {
    let throwing = false
    const brokenClock = { now: () => { if (throwing) throw new Error("clock unavailable"); return NOW }, sleep: async () => undefined }
    const { store, dispatch, ran } = batch({}, brokenClock)
    store.renewLease.mockImplementationOnce(async () => { throwing = true; return true })
    // The clock breaks for job-1's setup (and its release), then recovers for job-2.
    store.release.mockImplementationOnce(async () => { throwing = false; return { applied: true as const } })
    const before = Date.now()
    const result = await dispatch()
    expect(ran).toEqual(["job-2"])
    expect(result).toMatchObject({ claimed: 2, succeeded: 1, retried: 1 })
    const nextAttemptAt = (store.release.mock.calls as unknown as Array<[{ nextAttemptAt: Date }]>)[0]![0].nextAttemptAt
    expect(nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 60_000)
  })

  it("still runs the remaining claimed jobs when the clock throws while one job starts", async () => {
    let armed = false
    let thrown = 0
    const throwingClock = { now: () => { if (armed) { armed = false; thrown++; throw new Error("clock unavailable") } return NOW }, sleep: async () => undefined }
    const { store, dispatch, ran } = batch({}, throwingClock)
    // Arm the clock when job-1 is re-fenced: the next clock read (while building its execution) throws once.
    store.renewLease.mockImplementationOnce(async () => { armed = true; return true })
    const result = await dispatch()
    expect(thrown).toBe(1)
    expect(ran).toContain("job-2")
    expect(result.claimed).toBe(2)
    expect(result.succeeded + result.leaseLost + result.retried + result.deadLettered).toBe(2)
    expect(store.release).toHaveBeenCalledTimes(1)
  })
})

describe("job failure text is bounded on every store write", () => {
  const LONG = 200_000
  const over = (text: string | undefined) => new TextEncoder().encode(text ?? "").byteLength > 65_535
  const reject = (what: string) => new Error(`Data too long for column '${what}'`)
  function strictSetup(job: StoredJob, definition: Partial<JobDefinition> = {}) {
    const s = setup(async () => ({ success: true }), job, definition)
    const release = s.store.release as unknown as { mockImplementation: (fn: (args: { reason?: string }) => Promise<{ applied: true }>) => void }
    release.mockImplementation(async (args) => { if (over(args.reason)) throw reject("reason"); return { applied: true as const } })
    return s
  }
  const stored = (text: string) => expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_JOB_ERROR_BYTES)

  it("dead-letters a payload that fails to decode with an oversized message instead of leaving the job running", async () => {
    const { store, dispatch } = strictSetup(claimed(), { decodePayload: () => { throw new Error(`invalid payload: ${"x".repeat(LONG)}`) } })
    // Before the fix markFailed received the raw 200 KB message, the store rejected it and the outcome was lease_lost.
    expect(await dispatch()).toMatchObject({ deadLettered: 1, leaseLost: 0 })
    stored(store.markFailed.mock.calls[0]![0].error)
  })

  it("dead-letters a scope mismatch whose validation error is oversized", async () => {
    const scope = { kind: "system", get systemKey(): string { throw new Error(`corrupt scope: ${"x".repeat(LONG)}`) } } as unknown as StoredJob["executionScope"]
    const { store, dispatch } = strictSetup(claimed({ executionScope: scope }))
    expect(await dispatch()).toMatchObject({ deadLettered: 1, leaseLost: 0 })
    stored(store.markFailed.mock.calls[0]![0].error)
  })

  it("dead-letters an expired unknown definition whose job type is oversized", async () => {
    const { store, dispatch } = strictSetup(claimed({ jobType: "g".repeat(LONG), lastError: `Unknown job definition: g@1 (unrunnable since ${new Date(NOW.getTime() - DEFAULT_UNKNOWN_DEFINITION_MAX_DEFERRAL_MS - 1).toISOString()})` }))
    expect(await dispatch()).toMatchObject({ deadLettered: 1, leaseLost: 0 })
    stored(store.markFailed.mock.calls[0]![0].error)
  })

  it("bounds the release reason and the markRetrying fallback of a deferred unknown definition", async () => {
    const released = strictSetup(claimed({ jobType: "g".repeat(LONG), lastError: null }))
    expect(await released.dispatch()).toMatchObject({ retried: 1, leaseLost: 0 })
    stored((released.store.release.mock.calls as unknown as Array<[{ reason: string }]>)[0]![0].reason)

    const retrying = strictSetup(claimed({ jobType: "g".repeat(LONG), lastError: null }))
    retrying.store.release.mockRejectedValue(new Error("down"))
    expect(await retrying.dispatch()).toMatchObject({ retried: 1, leaseLost: 0 })
    stored(retrying.store.markRetrying.mock.calls[0]![0].error)
  })
})
