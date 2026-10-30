import { afterEach, describe, expect, it, vi } from "vitest"
import type { JobPayloadUpcaster } from "../jobRegistry"
import type { JobDefinition } from "../types"
import { definition, fakeClock, NOW, runOnce, storedJob, type StoreMocks } from "./executionMutationHarness"

afterEach(() => { vi.useRealTimers() })

const SINCE_MARKER = (iso: string) => ` (unrunnable since ${iso})`
const NOW_ISO = NOW.toISOString()
const DAY_MS = 24 * 60 * 60 * 1000

describe("definition resolution across versions", () => {
  const upcasters: JobPayloadUpcaster[] = [
    { type: "job", from: 1, to: 2, upcast: (payload) => ({ ...(payload as Record<string, unknown>), step1: true }) },
    { type: "job", from: 2, to: 3, upcast: (payload) => ({ ...(payload as Record<string, unknown>), step2: true }) },
  ]

  function versions(ran: string[], order: number[]): JobDefinition[] {
    return order.map((version) => definition({ version, execute: async (execution) => { ran.push(`v${version}:${JSON.stringify(execution.payload)}`); return { success: true } } }))
  }

  it("runs the newest registered version of the type, upcasting the stored payload step by step", async () => {
    for (const order of [[2, 3], [3, 2]]) {
      const ran: string[] = []
      const run = await runOnce({
        noDefinition: true,
        job: { jobVersion: 1, payload: '{"n":1}' },
        extraDefinitions: [...versions(ran, order), definition({ type: "other", version: 9 })],
        upcasters,
      })
      expect(run.result).toMatchObject({ succeeded: 1, retried: 0 })
      expect(ran).toEqual(['v3:{"n":1,"step1":true,"step2":true}'])
    }
  })

  it("ignores newer versions of other types when picking the latest", async () => {
    const ran: string[] = []
    const run = await runOnce({
      noDefinition: true,
      job: { jobVersion: 1 },
      extraDefinitions: [definition({ type: "other", version: 9 }), ...versions(ran, [2])],
      upcasters: [upcasters[0] as JobPayloadUpcaster],
    })
    expect(run.result.succeeded).toBe(1)
    expect(ran).toEqual(['v2:{"step1":true}'])
  })

  it("prefers the exact stored version over a newer one", async () => {
    const ran: string[] = []
    await runOnce({ noDefinition: true, job: { jobVersion: 2 }, extraDefinitions: versions(ran, [2, 3]), upcasters })
    expect(ran).toEqual(["v2:{}"])
  })

  it("defers a job whose stored version has no upcaster path, naming the missing step", async () => {
    const ran: string[] = []
    const run = await runOnce({ noDefinition: true, job: { jobVersion: 1 }, extraDefinitions: versions(ran, [2]), upcasters: [] })
    expect(ran).toEqual([])
    expect(run.result.retried).toBe(1)
    const reason = `Missing job payload upcaster: job@1->2${SINCE_MARKER(NOW_ISO)}`
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: reason, action: "retry" }])
    expect(run.mocks.release.mock.calls[0]?.[0].reason).toBe(reason)
  })

  it("defers a job stored with a version newer than any registered one", async () => {
    const run = await runOnce({ job: { jobVersion: 5 } })
    expect(run.result.errors[0]?.error).toBe(`Unknown job definition: job@5${SINCE_MARKER(NOW_ISO)}`)
    expect(run.result.retried).toBe(1)
  })
})

describe("deferral of a job no definition can run", () => {
  const unknown = { noDefinition: true } as const

  it("hands the job back once, without consuming an attempt, one lease duration ahead", async () => {
    const run = await runOnce({ ...unknown })
    const reason = `Unknown job definition: job@1${SINCE_MARKER(NOW_ISO)}`
    expect(run.mocks.release.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", nextAttemptAt: new Date(NOW.getTime() + 900), reason }]])
    expect(run.mocks.markRetrying).not.toHaveBeenCalled()
    expect(run.mocks.markFailed).not.toHaveBeenCalled()
    expect(run.result).toMatchObject({ retried: 1, deadLettered: 0 })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: reason, action: "retry" }])
    expect(run.rec.find("Job released: unknown definition")).toEqual([{ severity: "warn", message: "Job released: unknown definition", jobId: "job-1", jobType: "job", jobVersion: 1 }])
  })

  it("carries the first-deferral marker forward and keeps the window anchored there", async () => {
    const since = new Date(NOW.getTime() - 3_600_000).toISOString()
    const run = await runOnce({ ...unknown, job: { lastError: `Unknown job definition: job@1${SINCE_MARKER(since)}` } })
    expect(run.mocks.release.mock.calls[0]?.[0].reason).toBe(`Unknown job definition: job@1${SINCE_MARKER(since)}`)
    expect(run.mocks.release.mock.calls[0]?.[0].nextAttemptAt).toEqual(new Date(NOW.getTime() + 900))
  })

  it("restarts the window on a missing, malformed or future marker", async () => {
    const future = new Date(NOW.getTime() + 1000).toISOString()
    for (const lastError of [null, "some other failure", "Unknown job definition: job@1 (unrunnable since not-a-date)", `x${SINCE_MARKER(future)}`, `x ${SINCE_MARKER(NOW_ISO)} trailing`]) {
      const run = await runOnce({ ...unknown, job: { lastError } })
      expect(run.mocks.release.mock.calls[0]?.[0].reason).toBe(`Unknown job definition: job@1${SINCE_MARKER(NOW_ISO)}`)
    }
    const equal = await runOnce({ ...unknown, job: { lastError: `x${SINCE_MARKER(NOW_ISO)}` } })
    expect(equal.mocks.release.mock.calls[0]?.[0].reason).toBe(`Unknown job definition: job@1${SINCE_MARKER(NOW_ISO)}`)
  })

  it("keeps deferring up to the default 24 hour window and dead-letters beyond it", async () => {
    const edge = new Date(NOW.getTime() - DAY_MS).toISOString()
    const within = await runOnce({ ...unknown, job: { lastError: `x${SINCE_MARKER(edge)}` } })
    expect(within.result).toMatchObject({ retried: 1, deadLettered: 0 })
    const past = new Date(NOW.getTime() - DAY_MS - 1).toISOString()
    const beyond = await runOnce({ ...unknown, job: { lastError: `x${SINCE_MARKER(past)}` } })
    expect(beyond.result).toMatchObject({ retried: 0, deadLettered: 1 })
  })

  it("honours a configured window and dead-letters with the unknown-definition code", async () => {
    const edge = new Date(NOW.getTime() - 1000).toISOString()
    const within = await runOnce({ ...unknown, job: { lastError: `x${SINCE_MARKER(edge)}` }, config: { unknownDefinitionMaxDeferralMs: 1000 } })
    expect(within.result.retried).toBe(1)
    const past = new Date(NOW.getTime() - 1001).toISOString()
    const beyond = await runOnce({ ...unknown, job: { currentAttempt: 2, lastError: `x${SINCE_MARKER(past)}` }, config: { unknownDefinitionMaxDeferralMs: 1000 } })
    const error = `UNKNOWN_JOB_DEFINITION: Unknown job definition: job@1; no worker could run the job within 1000ms of ${past}`
    expect(beyond.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error, action: "dead_letter" }])
    expect(beyond.mocks.markFailed.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", error, status: "dead_letter", attempt: 2 }]])
    expect(beyond.mocks.release).not.toHaveBeenCalled()
    expect(beyond.rec.find("Job dead-lettered: no runnable definition")).toEqual([{ severity: "error", message: "Job dead-lettered: no runnable definition", jobId: "job-1", jobType: "job", jobVersion: 1, maxDeferralMs: 1000 }])
  })

  it("reports a lost lease when the store refuses the unknown-definition dead-letter", async () => {
    const past = new Date(NOW.getTime() - 1001).toISOString()
    const run = await runOnce({ ...unknown, job: { lastError: `x${SINCE_MARKER(past)}` }, config: { unknownDefinitionMaxDeferralMs: 1000 }, prepare: (mocks) => mocks.markFailed.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }) })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
  })

  it("reports a lost lease when the release is not applied, without retrying it", async () => {
    const run = await runOnce({ ...unknown, prepare: (mocks) => mocks.release.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }) })
    expect(run.mocks.release).toHaveBeenCalledOnce()
    expect(run.mocks.markRetrying).not.toHaveBeenCalled()
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
    expect(run.rec.find("Job released: unknown definition")).toEqual([])
  })

  it("retries a failed release once, stamping the second call from a fresh clock reading", async () => {
    const clock = fakeClock({ step: 1000 })
    const run = await runOnce({ noTelemetry: true, ...unknown, config: { clock }, prepare: (mocks) => mocks.release.mockRejectedValueOnce(new Error("release boom")).mockResolvedValueOnce({ applied: true }) })
    // claimDue reads the clock first, so the deferral decision is the second reading.
    const decision = new Date(NOW.getTime() + 1000)
    const reason = `Unknown job definition: job@1${SINCE_MARKER(decision.toISOString())}`
    expect(run.mocks.release.mock.calls.map(([args]) => args.nextAttemptAt)).toEqual([new Date(decision.getTime() + 900), new Date(NOW.getTime() + 2000 + 900)])
    expect(run.mocks.release.mock.calls.map(([args]) => args.reason)).toEqual([reason, reason])
    expect(run.result).toMatchObject({ retried: 1 })
  })

  it("logs each failed release with its try number", async () => {
    const run = await runOnce({ ...unknown, prepare: (mocks) => mocks.release.mockRejectedValue(new Error("release boom")) })
    expect(run.rec.find("Job release failed")).toEqual([
      { severity: "warn", message: "Job release failed", jobId: "job-1", error: "release boom", tries: 1 },
      { severity: "warn", message: "Job release failed", jobId: "job-1", error: "release boom", tries: 2 },
    ])
    expect(run.mocks.release).toHaveBeenCalledTimes(2)
  })

  it("falls back to consuming an attempt when the release keeps failing, stamped from a fresh reading", async () => {
    const clock = fakeClock({ step: 1000 })
    const run = await runOnce({ noTelemetry: true, ...unknown, config: { clock }, prepare: (mocks) => mocks.release.mockRejectedValue(new Error("release boom")) })
    const reason = `Unknown job definition: job@1${SINCE_MARKER(new Date(NOW.getTime() + 1000).toISOString())}`
    expect(run.mocks.markRetrying.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", nextAttemptAt: new Date(NOW.getTime() + 3000 + 900), error: reason, attempt: 1 }]])
    expect(run.result).toMatchObject({ retried: 1 })
    expect(run.rec.find("Job deferred: unknown definition")).toEqual([])
  })

  it("uses markRetrying directly when the store cannot release, stamped from the decision reading", async () => {
    const clock = fakeClock({ step: 1000 })
    const run = await runOnce({ noTelemetry: true, ...unknown, withRelease: false, config: { clock } })
    const decision = new Date(NOW.getTime() + 1000)
    const reason = `Unknown job definition: job@1${SINCE_MARKER(decision.toISOString())}`
    expect(run.mocks.markRetrying.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", nextAttemptAt: new Date(decision.getTime() + 900), error: reason, attempt: 1 }]])
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: reason, action: "retry" }])
  })

  it("logs the deferral without trying a release when the store cannot release", async () => {
    const run = await runOnce({ ...unknown, withRelease: false })
    expect(run.rec.find("Job release failed")).toEqual([])
    expect(run.rec.find("Job deferred: unknown definition")).toEqual([{ severity: "warn", message: "Job deferred: unknown definition", jobId: "job-1", jobType: "job", jobVersion: 1, attempt: 1 }])
  })

  it("dead-letters when neither the release nor the retry transition is applied, and says why", async () => {
    const notApplied = await runOnce({ ...unknown, withRelease: false, prepare: (mocks) => mocks.markRetrying.mockResolvedValue({ applied: false }) })
    const reason = `Unknown job definition: job@1${SINCE_MARKER(NOW_ISO)}`
    expect(notApplied.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: reason, action: "dead_letter" }])
    expect(notApplied.mocks.markFailed.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", error: reason, status: "dead_letter", attempt: 1 }]])
    expect(notApplied.rec.find("Job deferral failed")).toEqual([])

    const thrown = await runOnce({ ...unknown, withRelease: false, prepare: (mocks) => mocks.markRetrying.mockRejectedValue(new Error("retry boom")) })
    expect(thrown.rec.find("Job deferral failed")).toEqual([{ severity: "warn", message: "Job deferral failed", jobId: "job-1", error: "retry boom" }])
    expect(thrown.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: reason, action: "dead_letter" }])

    const lost = await runOnce({ ...unknown, withRelease: false, prepare: (mocks: StoreMocks) => { mocks.markRetrying.mockResolvedValue({ applied: false }); mocks.markFailed.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }) } })
    expect(lost.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job lease was lost", action: "lease_lost" }])
  })

  it("bounds the stored reason of a deferral", async () => {
    const run = await runOnce({ ...unknown, job: { jobType: "t".repeat(40_000) } })
    const reason = run.mocks.release.mock.calls[0]?.[0].reason ?? ""
    expect(new TextEncoder().encode(reason).byteLength).toBe(16 * 1024)
    expect(reason.endsWith("... [truncated]")).toBe(true)
  })
})

describe("a claimed job whose execution setup fails", () => {
  const failingIds = () => ({ idGenerator: () => { throw new Error("id boom") } })

  it("is released without running its handler, and the failure is logged", async () => {
    const execute = vi.fn(async () => ({ success: true as const }))
    const run = await runOnce({ definition: { execute }, config: failingIds() })
    const error = "Job execution failed before the handler ran: id boom"
    expect(execute).not.toHaveBeenCalled()
    expect(run.mocks.release.mock.calls).toStrictEqual([[{ jobId: "job-1", workerId: "w1", claimToken: "claim-secret", nextAttemptAt: new Date(NOW.getTime() + 900), reason: error }]])
    expect(run.result).toMatchObject({ retried: 1 })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error, action: "retry" }])
    expect(run.rec.find("Job execution setup failed")).toEqual([{ severity: "error", message: "Job execution setup failed", jobId: "job-1", jobType: "job", error: "id boom" }])
    expect(run.rec.find("Job released: setup failed")).toEqual([{ severity: "warn", message: "Job released: setup failed", jobId: "job-1", jobType: "job", error }])
  })

  it("does not stop the other claimed jobs of the batch", async () => {
    let calls = 0
    const run = await runOnce({
      jobs: [storedJob(), storedJob({ id: "job-2" })],
      config: { idGenerator: () => { calls += 1; if (calls === 1) throw new Error("id boom"); return "exec-2" } },
    })
    expect(run.result).toMatchObject({ claimed: 2, retried: 1, succeeded: 1 })
  })

  it("reports a lost lease when the store cannot release, without trying to", async () => {
    const run = await runOnce({ withRelease: false, config: failingIds() })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job execution failed before the handler ran: id boom", action: "lease_lost" }])
    expect(run.rec.find("Job release after setup failure failed")).toEqual([])
    expect(run.mocks.markRetrying).not.toHaveBeenCalled()
  })

  it("reports a lost lease when the release throws, and logs it", async () => {
    const run = await runOnce({ config: failingIds(), prepare: (mocks) => mocks.release.mockRejectedValue(new Error("release boom")) })
    expect(run.result.errors).toEqual([{ jobId: "job-1", jobType: "job", error: "Job execution failed before the handler ran: id boom", action: "lease_lost" }])
    expect(run.rec.find("Job release after setup failure failed")).toEqual([{ severity: "warn", message: "Job release after setup failure failed", jobId: "job-1", error: "release boom" }])
    expect(run.rec.find("Job released: setup failed")).toEqual([])
  })

  it("reports a lost lease when the release is not applied", async () => {
    const run = await runOnce({ config: failingIds(), prepare: (mocks) => mocks.release.mockResolvedValue({ applied: false, reason: "LEASE_LOST" }) })
    expect(run.result).toMatchObject({ leaseLost: 1, retried: 0 })
    expect(run.rec.find("Job released: setup failed")).toEqual([])
  })

  it("stamps the release from a fresh clock reading", async () => {
    const clock = fakeClock({ step: 5000 })
    const run = await runOnce({ noTelemetry: true, config: { ...failingIds(), clock } })
    // Reads: claimDue, execution start, then the hand-back reading.
    expect(run.mocks.release.mock.calls[0]?.[0].nextAttemptAt).toEqual(new Date(NOW.getTime() + 10_000 + 900))
  })

  it("falls back to the system clock when the dispatcher clock returns an invalid date or throws", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const system = new Date("2031-01-01T00:00:00.000Z")
    vi.setSystemTime(system)
    let reads = 0
    const invalid = { ...fakeClock(), now: () => { reads += 1; return reads >= 3 ? new Date(Number.NaN) : NOW } }
    const withInvalid = await runOnce({ noTelemetry: true, config: { ...failingIds(), clock: invalid } })
    expect(withInvalid.mocks.release.mock.calls[0]?.[0].nextAttemptAt).toEqual(new Date(system.getTime() + 900))
    reads = 0
    const throwing = { ...fakeClock(), now: () => { reads += 1; if (reads >= 3) throw new Error("clock broke"); return NOW } }
    const withThrow = await runOnce({ noTelemetry: true, config: { ...failingIds(), clock: throwing } })
    expect(withThrow.mocks.release.mock.calls[0]?.[0].nextAttemptAt).toEqual(new Date(system.getTime() + 900))
  })

  it("falls back to the system clock when the dispatcher clock returns something that is not a date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const system = new Date("2031-01-01T00:00:00.000Z")
    vi.setSystemTime(system)
    let reads = 0
    const odd = { ...fakeClock(), now: () => { reads += 1; return reads >= 3 ? ({ getTime: () => 0 } as unknown as Date) : NOW } }
    const run = await runOnce({ noTelemetry: true, config: { ...failingIds(), clock: odd } })
    expect(run.mocks.release.mock.calls[0]?.[0].nextAttemptAt).toEqual(new Date(system.getTime() + 900))
  })
})
