import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain/errors"
import { boundJobErrorMessage, decodeJobPayload, dispatchDueJobs, MAX_JOB_ERROR_BYTES, MAX_STORED_JOB_PAYLOAD_BYTES } from "../dispatcher"
import { createJobRegistry } from "../jobRegistry"
import { InvalidJobPayloadError, MAX_TIMER_DELAY_MS, MalformedJobPayloadError } from "../types"
import { baseConfig, definition, fakeClock, makeStore, runOnce, storedJob } from "./executionMutationHarness"

describe("decodeJobPayload boundaries", () => {
  it("accepts a payload of exactly the maximum size and rejects one byte more", () => {
    expect(MAX_STORED_JOB_PAYLOAD_BYTES).toBe(1_048_576)
    const prefix = '{"a":"'
    const suffix = '"}'
    const exact = prefix + "x".repeat(MAX_STORED_JOB_PAYLOAD_BYTES - prefix.length - suffix.length) + suffix
    expect(new TextEncoder().encode(exact).byteLength).toBe(MAX_STORED_JOB_PAYLOAD_BYTES)
    const decoded = decodeJobPayload(exact)
    expect(Object.keys(decoded)).toEqual(["a"])
    expect(() => decodeJobPayload(exact + " ")).toThrow(new MalformedJobPayloadError("Job payload exceeds the maximum of 1048576 bytes"))
  })

  it("measures the size in UTF-8 bytes, not characters", () => {
    const prefix = '{"a":"'
    const suffix = '"}'
    const characters = (MAX_STORED_JOB_PAYLOAD_BYTES - prefix.length - suffix.length) / 2 + 1
    const wide = prefix + "é".repeat(characters) + suffix
    expect(wide.length).toBeLessThan(MAX_STORED_JOB_PAYLOAD_BYTES)
    expect(() => decodeJobPayload(wide)).toThrow("Job payload exceeds the maximum of 1048576 bytes")
  })

  it("rejects a payload that is not a string, with the size message", () => {
    expect(() => decodeJobPayload(123 as never)).toThrow(new MalformedJobPayloadError("Job payload exceeds the maximum of 1048576 bytes"))
    expect(() => decodeJobPayload(undefined as never)).toThrow(MalformedJobPayloadError)
  })

  it("reports invalid JSON with the parser error as the cause", () => {
    let thrown: unknown
    try { decodeJobPayload("{nope") } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(MalformedJobPayloadError)
    expect((thrown as MalformedJobPayloadError).message).toBe("Job payload is not valid JSON")
    expect((thrown as MalformedJobPayloadError).cause).toBeInstanceOf(SyntaxError)
  })

  it("requires a JSON object: null, numbers, strings, booleans and arrays are rejected", () => {
    for (const text of ["null", "5", '"text"', "true", "[]", "[{}]"]) {
      expect(() => decodeJobPayload(text)).toThrow(new MalformedJobPayloadError("Job payload must be a JSON object"))
    }
    expect(decodeJobPayload('{"k":[1]}')).toEqual({ k: [1] })
  })

  it("passes the parsed object to the decoder and returns its result", () => {
    const seen: unknown[] = []
    const out = decodeJobPayload('{"n":1}', (input) => { seen.push(input); return { decoded: true } })
    expect(out).toEqual({ decoded: true })
    expect(seen).toEqual([{ n: 1 }])
  })

  it("rethrows an InvalidJobPayloadError unchanged and wraps every other decoder failure", () => {
    const original = new InvalidJobPayloadError("bad field")
    let same: unknown
    try { decodeJobPayload("{}", () => { throw original }) } catch (error) { same = error }
    expect(same).toBe(original)

    const cause = new TypeError("schema says no")
    let wrapped: unknown
    try { decodeJobPayload("{}", () => { throw cause }) } catch (error) { wrapped = error }
    expect(wrapped).toBeInstanceOf(InvalidJobPayloadError)
    expect(wrapped).not.toBe(cause)
    expect((wrapped as InvalidJobPayloadError).message).toBe("schema says no")
    expect((wrapped as InvalidJobPayloadError).cause).toBe(cause)

    let nonError: unknown
    try { decodeJobPayload("{}", () => { throw "plain string" }) } catch (error) { nonError = error }
    expect(nonError).toBeInstanceOf(InvalidJobPayloadError)
    expect((nonError as InvalidJobPayloadError).message).toBe("Job payload failed schema validation")
    expect((nonError as InvalidJobPayloadError).cause).toBe("plain string")
  })
})

describe("boundJobErrorMessage", () => {
  it("keeps a message of exactly the limit and truncates one byte more, marker included", () => {
    const exact = "a".repeat(MAX_JOB_ERROR_BYTES)
    expect(boundJobErrorMessage(exact)).toBe(exact)
    const bounded = boundJobErrorMessage(exact + "a")
    expect(new TextEncoder().encode(bounded).byteLength).toBe(MAX_JOB_ERROR_BYTES)
    expect(bounded.endsWith("... [truncated]")).toBe(true)
    expect(bounded).toBe("a".repeat(MAX_JOB_ERROR_BYTES - "... [truncated]".length) + "... [truncated]")
  })

  it("never splits a multi-byte character", () => {
    const marker = "... [truncated]".length
    // The cut position falls inside a 3-byte character, so it must back up to the character start.
    const text = "a".repeat(MAX_JOB_ERROR_BYTES - marker - 1) + "€".repeat(10)
    const bounded = boundJobErrorMessage(text)
    expect(bounded).toBe("a".repeat(MAX_JOB_ERROR_BYTES - marker - 1) + "... [truncated]")
    expect(bounded).not.toContain("�")
  })
})

describe("failure classification and unsuccessful results", () => {
  it("honours a permanent kind, a cancelled kind and an explicit retryable kind, and treats anything else as retryable", async () => {
    const permanent = await runOnce({ definition: { execute: async () => ({ success: false, error: Object.assign(new Error("nope"), { kind: "permanent" as const }) }) } })
    expect(permanent.result).toMatchObject({ deadLettered: 1, retried: 0, failed: 0 })
    expect(permanent.mocks.markFailed).toHaveBeenCalledOnce()
    expect(permanent.mocks.markRetrying).not.toHaveBeenCalled()

    const cancelled = await runOnce({ definition: { execute: async () => ({ success: false, error: Object.assign(new Error("stop"), { kind: "cancelled" as const }) }) } })
    expect(cancelled.result).toMatchObject({ failed: 1, deadLettered: 0, retried: 0 })
    expect(cancelled.mocks.markFailed).toHaveBeenCalledWith({ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", error: "stop", status: "cancelled", attempt: 1 })

    const explicit = await runOnce({ definition: { execute: async () => ({ success: false, error: Object.assign(new Error("again"), { kind: "retryable" as const }) }) } })
    expect(explicit.result).toMatchObject({ retried: 1, deadLettered: 0 })

    for (const kind of ["bogus", "", 7, null]) {
      const other = await runOnce({ definition: { execute: async () => ({ success: false, error: Object.assign(new Error("odd"), { kind }) as never }) } })
      expect(other.result).toMatchObject({ retried: 1, deadLettered: 0 })
    }

    const thrownObject = await runOnce({ definition: { execute: async () => { throw { kind: "permanent", message: "plain object" } } } })
    expect(thrownObject.result).toMatchObject({ deadLettered: 1 })
    const thrownNull = await runOnce({ definition: { execute: async () => { throw null } } })
    expect(thrownNull.result).toMatchObject({ retried: 1 })
    const thrownStringKind = await runOnce({ definition: { execute: async () => { throw "permanent" } } })
    expect(thrownStringKind.result).toMatchObject({ retried: 1 })
  })

  it("derives the failure text of an unsuccessful result from its error, its data or a default", async () => {
    const run = (execute: () => Promise<never>) => runOnce({ definition: { maxAttempts: 1, execute }, job: { maxAttempts: 1 } })
    const fromError = await run(async () => ({ success: false, error: new Error("from error"), data: { errorMessage: "ignored" } }) as never)
    expect(fromError.result.errors[0]?.error).toBe("from error")
    const fromData = await run(async () => ({ success: false, data: { errorMessage: "from data" } }) as never)
    expect(fromData.result.errors[0]?.error).toBe("from data")
    const noData = await run(async () => ({ success: false }) as never)
    expect(noData.result.errors[0]?.error).toBe("Job returned unsuccessful result")
    const wrongType = await run(async () => ({ success: false, data: { errorMessage: 42 } }) as never)
    expect(wrongType.result.errors[0]?.error).toBe("Job returned unsuccessful result")
    const emptyData = await run(async () => ({ success: false, data: {} }) as never)
    expect(emptyData.result.errors[0]?.error).toBe("Job returned unsuccessful result")
  })

  it("reports a thrown non-Error value by its string form", async () => {
    const run = await runOnce({ definition: { maxAttempts: 1, execute: async () => { throw 42 } }, job: { maxAttempts: 1 } })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "42", action: "dead_letter" }])
  })
})

describe("markFailed fallbacks when the store does not apply the dead-letter", () => {
  const mismatch = { definition: { scope: "tenant" as const } }

  it("reports the lost lease when the store refuses the transition", async () => {
    const run = await runOnce({ ...mismatch, prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }) })
    expect(run.result.leaseLost).toBe(1)
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
  })

  it("reports the history error of a refused transition, or the generic history text without one", async () => {
    const withText = await runOnce({ ...mismatch, prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "HISTORY_FAILED", historyError: "history store down" }) })
    expect(withText.result.errors[0]).toMatchObject({ error: "history store down", action: "lease_lost" })
    const without = await runOnce({ ...mismatch, prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "HISTORY_FAILED" }) })
    expect(without.result.errors[0]).toMatchObject({ error: "Required execution history could not be persisted", action: "lease_lost" })
    const emptyText = await runOnce({ ...mismatch, prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "HISTORY_FAILED", historyError: "" }) })
    expect(emptyText.result.leaseLost).toBe(1)
    expect(emptyText.result.errors).toEqual([])
  })

  it("reports the store failure message when markFailed throws", async () => {
    const run = await runOnce({ ...mismatch, prepare: (mocks) => mocks.markFailed.mockRejectedValue(new Error("db down")) })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "db down", action: "lease_lost" }])
  })

  it("dead-letters a scope mismatch with the mismatch message when the store applies it", async () => {
    const run = await runOnce(mismatch)
    expect(run.result).toMatchObject({ deadLettered: 1, leaseLost: 0 })
    expect(run.result.errors).toHaveLength(1)
    expect(run.result.errors[0]).toMatchObject({ action: "dead_letter" })
    expect(run.mocks.markFailed).toHaveBeenCalledWith({ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", error: run.result.errors[0]!.error, status: "dead_letter", attempt: 1 })
  })

  it("covers the invalid retry policy, exhausted attempts and undecodable payload dead-letters the same way", async () => {
    const policy = await runOnce({ job: { maxAttempts: 0 } })
    expect(policy.result.errors[0]).toMatchObject({ action: "dead_letter", error: "Invalid retry policy: maxAttempts must be a finite integer >= 1" })
    const policyLost = await runOnce({ job: { maxAttempts: 0 }, prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }) })
    expect(policyLost.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])

    const exceeded = await runOnce({ job: { currentAttempt: 4, maxAttempts: 3 } })
    expect(exceeded.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job attempt 4 exceeds maxAttempts 3", action: "dead_letter" }])
    const exceededLost = await runOnce({ job: { currentAttempt: 4, maxAttempts: 3 }, prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }) })
    expect(exceededLost.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
    // The attempt equal to the budget still runs.
    const boundary = await runOnce({ job: { currentAttempt: 3, maxAttempts: 3 } })
    expect(boundary.result).toMatchObject({ succeeded: 1, deadLettered: 0 })

    const bad = await runOnce({ job: { payload: "[1]" } })
    expect(bad.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job payload must be a JSON object", action: "dead_letter" }])
    const badLost = await runOnce({ job: { payload: "[1]" }, prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }) })
    expect(badLost.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
  })

  it("takes the attempt budget from the job when it has one and from the definition otherwise", async () => {
    const perJob = await runOnce({ definition: { maxAttempts: 10 }, job: { currentAttempt: 2, maxAttempts: 1 } })
    expect(perJob.result.errors[0]?.error).toBe("Job attempt 2 exceeds maxAttempts 1")
    const fromDefinition = await runOnce({ definition: { maxAttempts: 1 }, job: { currentAttempt: 2, maxAttempts: undefined } })
    expect(fromDefinition.result.errors[0]?.error).toBe("Job attempt 2 exceeds maxAttempts 1")
  })
})

describe("dispatcher configuration validation", () => {
  const empty = () => {
    const { store } = makeStore([])
    return { store, registry: createJobRegistry() }
  }
  const call = (over: Parameters<typeof baseConfig>[2]) => {
    const { store, registry } = empty()
    return dispatchDueJobs(baseConfig(store, registry, over))
  }

  it("enforces the claim limit at the exact bounds with the exact messages", async () => {
    await expect(call({ claimLimit: 0 })).rejects.toThrow(new ConfigurationError("claimLimit must be a positive integer"))
    await expect(call({ claimLimit: 1.5 })).rejects.toThrow("claimLimit must be a positive integer")
    await expect(call({ claimLimit: 101 })).rejects.toThrow(new ConfigurationError("Claim limit 101 exceeds maximum 100"))
    await expect(call({ claimLimit: 100 })).resolves.toMatchObject({ claimed: 0 })
    await expect(call({ claimLimit: 1 })).resolves.toMatchObject({ claimed: 0 })
  })

  it("validates the worker id and the lease duration", async () => {
    await expect(call({ workerId: "  " })).rejects.toThrow(new ConfigurationError("workerId must be a non-empty string"))
    await expect(call({ workerId: 5 as never })).rejects.toThrow("workerId must be a non-empty string")
    await expect(call({ leaseDurationMs: 0 })).rejects.toThrow(new ConfigurationError("leaseDurationMs must be positive"))
    await expect(call({ leaseDurationMs: Number.NaN })).rejects.toThrow("leaseDurationMs must be positive")
    await expect(call({ leaseDurationMs: Number.POSITIVE_INFINITY })).rejects.toThrow("leaseDurationMs must be positive")
    await expect(call({ leaseDurationMs: MAX_TIMER_DELAY_MS + 1 })).rejects.toThrow(/leaseDurationMs/)
    await expect(call({ leaseDurationMs: MAX_TIMER_DELAY_MS })).resolves.toMatchObject({ claimed: 0 })
    await expect(call({ leaseDurationMs: 1 })).resolves.toMatchObject({ claimed: 0 })
  })

  it("validates the timeout policy field by field", async () => {
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: -1 } })).rejects.toThrow(new ConfigurationError("cancellationGraceMs must be finite and non-negative"))
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: Number.NaN } })).rejects.toThrow("cancellationGraceMs must be finite and non-negative")
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: MAX_TIMER_DELAY_MS + 1 } })).rejects.toThrow(/cancellationGraceMs/)
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 0 } })).resolves.toMatchObject({ claimed: 0 })
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: MAX_TIMER_DELAY_MS } })).resolves.toMatchObject({ claimed: 0 })
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 0, timeoutMs: 0 } })).rejects.toThrow(new ConfigurationError("timeoutMs must be finite and positive"))
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 0, timeoutMs: Number.POSITIVE_INFINITY } })).rejects.toThrow("timeoutMs must be finite and positive")
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 0, timeoutMs: MAX_TIMER_DELAY_MS + 1 } })).rejects.toThrow(/timeoutMs/)
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 0, timeoutMs: 1 } })).resolves.toMatchObject({ claimed: 0 })
    await expect(call({ timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 0, timeoutMs: MAX_TIMER_DELAY_MS } })).resolves.toMatchObject({ claimed: 0 })
  })

  it("validates the unknown-definition deferral window", async () => {
    const message = "unknownDefinitionMaxDeferralMs must be finite and non-negative"
    await expect(call({ unknownDefinitionMaxDeferralMs: -1 })).rejects.toThrow(new ConfigurationError(message))
    await expect(call({ unknownDefinitionMaxDeferralMs: Number.NaN })).rejects.toThrow(message)
    await expect(call({ unknownDefinitionMaxDeferralMs: Number.POSITIVE_INFINITY })).rejects.toThrow(message)
    await expect(call({ unknownDefinitionMaxDeferralMs: 0 })).resolves.toMatchObject({ claimed: 0 })
  })

  it("does not touch the store when the configuration is invalid", async () => {
    const { store, mocks } = makeStore([storedJob()])
    await expect(dispatchDueJobs(baseConfig(store, createJobRegistry(), { claimLimit: 0 }))).rejects.toThrow()
    expect(mocks.claimDue).not.toHaveBeenCalled()
  })

  it("runs a job without an explicit timeout policy and without a timeoutMs in the policy", async () => {
    const run = await runOnce({ config: { timeoutPolicy: { mode: "cooperative", cancellationGraceMs: 5 } } })
    expect(run.result.succeeded).toBe(1)
  })

  it("hands claimDue the claim limit, worker, lease, requester and the clock reading", async () => {
    const { store, mocks } = makeStore([])
    const clock = fakeClock()
    await dispatchDueJobs(baseConfig(store, createJobRegistry(), { clock, claimLimit: 7, leaseDurationMs: 1234, workerId: "worker-x", requester: { scope: "platform", actorId: "actor-1" } }))
    expect(mocks.claimDue).toHaveBeenCalledOnce()
    expect(mocks.claimDue).toHaveBeenCalledWith({ limit: 7, workerId: "worker-x", leaseDurationMs: 1234, requester: { scope: "platform", actorId: "actor-1" }, now: new Date("2026-03-10T12:00:00.000Z") })
  })
})

describe("registered definition used by the helper", () => {
  it("is valid", () => {
    const registry = createJobRegistry()
    registry.register(definition())
    expect(registry.has("job", 1)).toBe(true)
  })
})
