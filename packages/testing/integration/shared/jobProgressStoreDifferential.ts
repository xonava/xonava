import { expect, it } from "vitest"
import type { JobProgress, JobProgressPort } from "@xonava/core/execution"
import { forAllAsync, scaledRuns, type Rng } from "../../../core/src/__tests__/differential/harness.js"
import { TIMING_SCALE } from "../../../core/src/__tests__/timing.js"
import {
  CHECKPOINT_LIMIT, INVALID_PERCENTS, RefJobProgress, VALID_PERCENTS, checkpointOfSize, compareRaw, describeOps, generateOps, shrinkOps,
  type Claim, type Fence, type Op, type Outcome, type ProgressSpec, type RawProgress,
} from "./jobProgressStoreDifferentialModel.js"

export interface JobProgressStoreDifferentialDriver {
  /** Property-name suffix, e.g. "postgres". */
  label: string
  store: JobProgressPort
  /** Deletes every job and progress row. */
  reset(): Promise<void>
  /** Writes (or replaces) the job row that fences progress: the claim, with a lease one hour ahead or already expired. */
  claim(job: string, claim: Claim): Promise<void>
  /** Moves an existing job's lease an hour ahead or into the past. */
  setLease(job: string, live: boolean): Promise<void>
  /** Raw `job_progress` rows, read with SQL independent of the adapter. */
  dump(): Promise<RawProgress[]>
  /** Base run count of the sequential property. */
  lifecycleRuns?: number
  /** Base run count of the concurrency properties. */
  concurrencyRuns?: number
  /** Slow transports (Miniflare D1) use short sequences and compare the table only at the end of one. */
  light?: boolean
  /** Upper bound of concurrent workers (the connection pool size). */
  maxWorkers?: number
}

export const PROPERTY_TIMEOUT_MS = Math.ceil(300_000 * Math.max(1, scaledRuns(100) / 100) * TIMING_SCALE)

const ERRORS = ["ConfigurationError", "StaleClaimError", "ConflictError"] as const

function errorOutcome(error: unknown): Outcome {
  const name = error instanceof Error ? error.name : ""
  const known = ERRORS.find((candidate) => candidate === name)
  if (known === undefined) throw error
  return { error: known }
}

/** An adapter result as the model's outcome shape; `updatedAt` is checked separately because the database clock is not modelled. */
function view(progress: JobProgress | null): Outcome {
  if (progress === null) return { ok: null }
  return { ok: { jobId: progress.jobId, attempt: progress.attempt, sequence: progress.sequence, ...(progress.percent === undefined ? {} : { percent: progress.percent }), ...(progress.checkpoint === undefined ? {} : { checkpoint: progress.checkpoint }) } }
}

async function write(store: JobProgressPort, job: string, fence: Fence, expected: number, progress: ProgressSpec): Promise<{ outcome: Outcome; updatedAt?: string }> {
  try {
    const result = await store.write({ jobId: job, workerId: fence.worker, claimToken: fence.token, attempt: fence.attempt }, expected, progress)
    return { outcome: view(result), updatedAt: result.updatedAt }
  } catch (error) {
    return { outcome: errorOutcome(error) }
  }
}

function expectInstant(updatedAt: string | undefined, what: string): void {
  expect(updatedAt !== undefined && Number.isFinite(Date.parse(updatedAt)) && new Date(updatedAt).toISOString() === updatedAt, `${what}: updatedAt ${String(updatedAt)} is an ISO instant`).toBe(true)
}

async function expectTable(driver: JobProgressStoreDifferentialDriver, model: RefJobProgress, what: string): Promise<void> {
  expect((await driver.dump()).sort(compareRaw), what).toEqual(model.dump())
}

export async function runJobProgress(driver: JobProgressStoreDifferentialDriver, ops: Op[]): Promise<void> {
  await driver.reset()
  const model = new RefJobProgress()
  const written = new Map<string, string>()
  for (const [index, op] of ops.entries()) {
    const what = `step ${index} ${op.k}`
    if (op.k === "claim") {
      model.claim(op)
      await driver.claim(op.job, op)
    } else if (op.k === "lease") {
      model.lease(op)
      await driver.setLease(op.job, op.live)
    } else if (op.k === "write") {
      const expected = model.write(op)
      const actual = await write(driver.store, op.job, op.fence, op.expected, op.progress)
      expect(actual.outcome, what).toEqual(expected)
      if ("ok" in expected && expected.ok !== null) { expectInstant(actual.updatedAt, what); written.set(op.job, actual.updatedAt!) }
    } else {
      const expected = model.read(op.job)
      const actual = await driver.store.read(op.job)
      expect(view(actual), what).toEqual(expected)
      if (actual !== null) expect(actual.updatedAt, `${what}: read returns the instant of the last write`).toBe(written.get(op.job))
    }
    if (!driver.light) await expectTable(driver, model, `table after step ${index}`)
  }
  await expectTable(driver, model, "final table")
}

/** Registers the sequential store-vs-reference differential (fence, optimistic sequence, replace semantics, validation). */
export function defineJobProgressDifferential(driver: JobProgressStoreDifferentialDriver): void {
  it(`job progress matches the reference model (${driver.label})`, async () => {
    await forAllAsync(`job progress store lifecycle differential (${driver.label})`, (rng) => generateOps(rng, driver.light ? { min: 5, max: 12 } : {}), (ops) => runJobProgress(driver, ops), {
      runs: driver.lifecycleRuns ?? 60, shrink: shrinkOps, describe: describeOps, maxShrinkSteps: 100,
    })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Concurrency

const FENCE: Fence = { worker: "w1", token: "tok-1", attempt: 2 }
const JOB = "job-a"

/** Percent that a write producing `sequence` of `total` reports; it grows with the sequence, so any read can be validated. */
const percentAt = (sequence: number, total: number): number => Math.min(100, (sequence / total) * 100)

interface ReportersCase { reporters: number; rounds: number; intruders: number; readers: number }

/**
 * Several reporters share one live claim and report for one job, each repeating read-then-write until it has landed
 * `rounds` writes (a ConflictError means another reporter advanced first). Nothing may be lost: the landed writes
 * hold exactly the sequences 1..n with no duplicate, the stored row is the write holding sequence n, and percent never
 * regresses along the sequence. Readers running alongside see non-decreasing sequences and whole rows only. Intruders
 * hold a wrong claim token and must always lose with a StaleClaimError without disturbing anything.
 */
export function defineConcurrentReporters(driver: JobProgressStoreDifferentialDriver): void {
  it(`concurrent reporters lose no progress and never regress it (${driver.label})`, async () => {
    await forAllAsync(`job progress store concurrent reporters (${driver.label})`, (rng: Rng): ReportersCase => ({
      reporters: 2 + rng.int(Math.min(driver.maxWorkers ?? 8, 8) - 1), rounds: 2 + rng.int(driver.light ? 2 : 5), intruders: rng.int(3), readers: rng.int(driver.light ? 2 : 3),
    }), async (c) => {
      await driver.reset()
      await driver.claim(JOB, { ...FENCE, live: true })
      const total = c.reporters * c.rounds
      const landed: Array<{ reporter: number; sequence: number; percent: number; checkpoint: Record<string, unknown> }> = []
      let finished = false
      const reporter = async (id: number): Promise<void> => {
        let done = 0
        for (let guard = 0; done < c.rounds; guard++) {
          expect(guard, `reporter ${id} starved`).toBeLessThan(c.reporters * c.rounds + 10)
          const current = await driver.store.read(JOB)
          const expected = current?.sequence ?? 0
          const progress = { percent: percentAt(expected + 1, total), checkpoint: { reporter: id, round: done, after: expected } }
          const { outcome } = await write(driver.store, JOB, FENCE, expected, progress)
          if ("error" in outcome) { expect(outcome.error, `reporter ${id}`).toBe("ConflictError"); continue }
          const ok = outcome.ok!
          expect(ok.sequence, "a write advances the sequence it read by one").toBe(expected + 1)
          expect(ok.attempt).toBe(FENCE.attempt)
          expect({ percent: ok.percent, checkpoint: ok.checkpoint }).toEqual(progress)
          landed.push({ reporter: id, sequence: ok.sequence, percent: ok.percent!, checkpoint: ok.checkpoint! })
          done++
        }
      }
      const intruder = async (id: number): Promise<void> => {
        for (let i = 0; i < c.rounds; i++) {
          const { outcome } = await write(driver.store, JOB, { ...FENCE, token: `intruder-${id}` }, (await driver.store.read(JOB))?.sequence ?? 0, { percent: 100, checkpoint: { intruder: id } })
          expect(outcome, `intruder ${id}`).toEqual({ error: "StaleClaimError" })
        }
      }
      const reader = async (id: number): Promise<void> => {
        let last = 0
        let lastPercent = 0
        while (!finished) {
          await new Promise((resolve) => setTimeout(resolve, driver.light ? 10 : 2))
          const row = await driver.store.read(JOB)
          if (row === null) continue
          expect(row.sequence, `reader ${id} saw the sequence go backwards`).toBeGreaterThanOrEqual(last)
          expect(row.percent, `reader ${id}: percent of a whole row`).toBe(percentAt(row.sequence, total))
          expect(row.percent!, `reader ${id} saw percent regress`).toBeGreaterThanOrEqual(lastPercent)
          expect(row.checkpoint, `reader ${id}: checkpoint belongs to the row`).toMatchObject({ after: row.sequence - 1 })
          last = row.sequence
          lastPercent = row.percent!
        }
      }
      const readers = Promise.all(Array.from({ length: c.readers }, (_, id) => reader(id)))
      try {
        await Promise.all([...Array.from({ length: c.reporters }, (_, id) => reporter(id)), ...Array.from({ length: c.intruders }, (_, id) => intruder(id))])
      } finally { finished = true }
      await readers

      expect(landed.map((entry) => entry.sequence).sort((a, b) => a - b), "landed sequences").toEqual(Array.from({ length: total }, (_, i) => i + 1))
      const bySequence = [...landed].sort((a, b) => a.sequence - b.sequence)
      for (let i = 1; i < bySequence.length; i++) expect(bySequence[i]!.percent, "percent along the sequence").toBeGreaterThanOrEqual(bySequence[i - 1]!.percent)
      const rows = await driver.dump()
      expect(rows, "one row for the job").toHaveLength(1)
      const last = bySequence[bySequence.length - 1]!
      expect(rows[0], "stored row is the last landed write").toEqual({ jobId: JOB, attempt: FENCE.attempt, sequence: total, percent: last.percent, checkpoint: last.checkpoint })
    }, { runs: driver.concurrencyRuns ?? 50, describe: (c) => `${c.reporters} reporters x ${c.rounds} rounds, ${c.intruders} intruders, ${c.readers} readers` })
  }, PROPERTY_TIMEOUT_MS)
}

interface RaceCase { writers: number; start: number; stale: number; withRow: boolean }

/**
 * Every writer names the same expected sequence at once: exactly one wins with the next sequence and the rest lose
 * with a ConflictError (compare-and-set), writers with a stale claim lose with a StaleClaimError, and the row holds
 * exactly the winner's progress. Covers both the first write (no row yet) and an update.
 */
export function defineSequenceRace(driver: JobProgressStoreDifferentialDriver): void {
  it(`writers racing on one sequence: exactly one wins (${driver.label})`, async () => {
    await forAllAsync(`job progress store sequence race (${driver.label})`, (rng: Rng): RaceCase => {
      const withRow = rng.bool(0.6)
      return { writers: 2 + rng.int(Math.min(driver.maxWorkers ?? 8, 8) - 1), start: withRow ? 1 + rng.int(4) : 0, stale: rng.int(3), withRow }
    }, async (c) => {
      await driver.reset()
      await driver.claim(JOB, { ...FENCE, live: true })
      for (let i = 0; i < c.start; i++) expect(await write(driver.store, JOB, FENCE, i, { percent: i }), `seed ${i}`).toMatchObject({ outcome: { ok: { sequence: i + 1 } } })
      const results = await Promise.all([
        ...Array.from({ length: c.writers }, (_, id) => write(driver.store, JOB, FENCE, c.start, { percent: 10 + id, checkpoint: { writer: id } })),
        ...Array.from({ length: c.stale }, (_, id) => write(driver.store, JOB, { ...FENCE, attempt: 1 }, c.start, { percent: 99, checkpoint: { stale: id } })),
      ])
      const winners = results.slice(0, c.writers).flatMap((result, id) => ("ok" in result.outcome ? [{ id, ok: result.outcome.ok! }] : []))
      expect(winners, "exactly one winner").toHaveLength(1)
      for (const result of results.slice(0, c.writers)) if ("error" in result.outcome) expect(result.outcome).toEqual({ error: "ConflictError" })
      for (const result of results.slice(c.writers)) expect(result.outcome).toEqual({ error: "StaleClaimError" })
      const winner = winners[0]!
      expect(winner.ok.sequence).toBe(c.start + 1)
      expect(await driver.dump()).toEqual([{ jobId: JOB, attempt: FENCE.attempt, sequence: c.start + 1, percent: 10 + winner.id, checkpoint: { writer: winner.id } }])
    }, { runs: driver.concurrencyRuns ?? 50, describe: (c) => `${c.writers} writers at sequence ${c.start} (row ${c.withRow}), ${c.stale} stale` })
  }, PROPERTY_TIMEOUT_MS)
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic regressions

/** Deterministic cases at the contract's edges, beyond what the generators reach reliably. */
export function defineJobProgressRegressions(driver: JobProgressStoreDifferentialDriver): void {
  const setup = async (): Promise<void> => { await driver.reset(); await driver.claim(JOB, { ...FENCE, live: true }) }

  it(`the first write must name sequence 0 and a fresh row starts at 1 (${driver.label})`, async () => {
    await setup()
    for (const expected of [1, 5, -1]) {
      expect((await write(driver.store, JOB, FENCE, expected, { percent: 10 })).outcome, `expected ${expected}`).toEqual({ error: "ConflictError" })
      expect(await driver.dump(), `no row after expected ${expected}`).toEqual([])
    }
    expect((await write(driver.store, JOB, FENCE, 0, { percent: 10 })).outcome).toMatchObject({ ok: { sequence: 1, attempt: 2, percent: 10 } })
  })

  it(`a write replaces percent and checkpoint wholesale: omitted parts are cleared (${driver.label})`, async () => {
    await setup()
    await write(driver.store, JOB, FENCE, 0, { percent: 40, checkpoint: { cursor: 1 } })
    expect((await write(driver.store, JOB, FENCE, 1, { percent: 41 })).outcome).toEqual({ ok: { jobId: JOB, attempt: 2, sequence: 2, percent: 41 } })
    expect((await write(driver.store, JOB, FENCE, 2, { checkpoint: { cursor: 3 } })).outcome).toEqual({ ok: { jobId: JOB, attempt: 2, sequence: 3, checkpoint: { cursor: 3 } } })
    expect((await write(driver.store, JOB, FENCE, 3, {})).outcome).toEqual({ ok: { jobId: JOB, attempt: 2, sequence: 4 } })
    expect(await driver.dump()).toEqual([{ jobId: JOB, attempt: 2, sequence: 4, percent: null, checkpoint: null }])
  })

  it(`percent may go backwards: the store keeps the last report, only the sequence is monotonic (${driver.label})`, async () => {
    await setup()
    await write(driver.store, JOB, FENCE, 0, { percent: 80 })
    expect((await write(driver.store, JOB, FENCE, 1, { percent: 20 })).outcome).toMatchObject({ ok: { sequence: 2, percent: 20 } })
    expect(await driver.store.read(JOB)).toMatchObject({ sequence: 2, percent: 20 })
  })

  it(`percent boundaries: 0 and 100 are stored exactly, anything outside is rejected untouched (${driver.label})`, async () => {
    await setup()
    let sequence = 0
    for (const percent of VALID_PERCENTS) {
      expect((await write(driver.store, JOB, FENCE, sequence, { percent })).outcome, `percent ${percent}`).toMatchObject({ ok: { sequence: sequence + 1, percent } })
      sequence++
    }
    for (const percent of INVALID_PERCENTS) {
      expect((await write(driver.store, JOB, FENCE, sequence, { percent })).outcome, `percent ${percent}`).toEqual({ error: "ConfigurationError" })
      expect(await driver.store.read(JOB), `row after rejected ${percent}`).toMatchObject({ sequence, percent: VALID_PERCENTS[VALID_PERCENTS.length - 1] })
    }
  })

  it(`a checkpoint of exactly the byte bound is stored and read back; one byte more is rejected (${driver.label})`, async () => {
    await setup()
    const atLimit = checkpointOfSize(0)
    const first = await write(driver.store, JOB, FENCE, 0, { checkpoint: atLimit })
    expect(first.outcome).toMatchObject({ ok: { sequence: 1, checkpoint: atLimit } })
    expect(await driver.store.read(JOB)).toMatchObject({ sequence: 1, checkpoint: atLimit })
    expect((await write(driver.store, JOB, FENCE, 1, { checkpoint: checkpointOfSize(1) })).outcome).toEqual({ error: "ConfigurationError" })
    // Multi-byte characters count as bytes: this one is under the limit in characters and over it in bytes.
    expect((await write(driver.store, JOB, FENCE, 1, { checkpoint: { k: "€".repeat(CHECKPOINT_LIMIT / 3) } })).outcome).toEqual({ error: "ConfigurationError" })
    expect(await driver.store.read(JOB)).toMatchObject({ sequence: 1 })
  })

  it(`a new claim keeps the sequence and moves the row to the new attempt; the old claim is stale (${driver.label})`, async () => {
    await setup()
    await write(driver.store, JOB, FENCE, 0, { percent: 10, checkpoint: { cursor: 1 } })
    const next: Fence = { worker: "w2", token: "tok-2", attempt: 3 }
    await driver.claim(JOB, { ...next, live: true })
    expect((await write(driver.store, JOB, FENCE, 1, { percent: 20 })).outcome).toEqual({ error: "StaleClaimError" })
    expect((await write(driver.store, JOB, next, 1, { percent: 30 })).outcome).toMatchObject({ ok: { sequence: 2, attempt: 3, percent: 30 } })
    expect(await driver.dump()).toEqual([{ jobId: JOB, attempt: 3, sequence: 2, percent: 30, checkpoint: null }])
  })

  it(`an expired lease is stale even for the claim holder, and the claim works again once renewed (${driver.label})`, async () => {
    await setup()
    await driver.setLease(JOB, false)
    expect((await write(driver.store, JOB, FENCE, 0, { percent: 10 })).outcome).toEqual({ error: "StaleClaimError" })
    expect(await driver.dump()).toEqual([])
    await driver.setLease(JOB, true)
    expect((await write(driver.store, JOB, FENCE, 0, { percent: 10 })).outcome).toMatchObject({ ok: { sequence: 1 } })
  })

  it(`the stale claim wins over a sequence conflict, and unknown jobs are stale (${driver.label})`, async () => {
    await setup()
    await write(driver.store, JOB, FENCE, 0, { percent: 10 })
    expect((await write(driver.store, JOB, { ...FENCE, token: "other" }, 0, { percent: 20 })).outcome).toEqual({ error: "StaleClaimError" })
    expect((await write(driver.store, "no-such-job", FENCE, 0, { percent: 20 })).outcome).toEqual({ error: "StaleClaimError" })
    expect(await driver.store.read("no-such-job")).toBeNull()
  })

  it(`job ids, workers and tokens are compared byte-for-byte: case, trailing space and non-ASCII differ (${driver.label})`, async () => {
    await driver.reset()
    await driver.claim("job-a", { worker: "w1", token: "tok-1", attempt: 1, live: true })
    for (const fence of [{ worker: "W1", token: "tok-1" }, { worker: "w1 ", token: "tok-1" }, { worker: "w1", token: "TOK-1" }, { worker: "w1", token: "tok-1 " }, { worker: "wé", token: "tok-1" }]) {
      expect((await write(driver.store, "job-a", { ...fence, attempt: 1 }, 0, { percent: 1 })).outcome, JSON.stringify(fence)).toEqual({ error: "StaleClaimError" })
    }
    for (const job of ["Job-a", "job-a ", "jöb"]) expect((await write(driver.store, job, { worker: "w1", token: "tok-1", attempt: 1 }, 0, { percent: 1 })).outcome, JSON.stringify(job)).toEqual({ error: "StaleClaimError" })
    expect(await driver.dump()).toEqual([])
    await driver.claim("Job-a", { worker: "w1", token: "tok-1", attempt: 1, live: true })
    await driver.claim("job-a ", { worker: "w1", token: "tok-1", attempt: 1, live: true })
    for (const job of ["job-a", "Job-a", "job-a "]) expect((await write(driver.store, job, { worker: "w1", token: "tok-1", attempt: 1 }, 0, { percent: 5 })).outcome, JSON.stringify(job)).toMatchObject({ ok: { jobId: job, sequence: 1 } })
    expect((await driver.dump()).map((row) => row.jobId).sort()).toEqual(["Job-a", "job-a", "job-a "])
  })
}
