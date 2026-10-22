import type { Rng } from "../../../core/src/__tests__/differential/harness.js"

/**
 * Pure reference model of durable job progress (the `JobProgressPort` contract), independent of the stores. A progress
 * row is fenced on the job's live claim (worker, claim token, attempt, unexpired lease) and written with optimistic
 * concurrency: a write names the sequence it read and succeeds only when the stored sequence is still that one, then
 * replaces percent and checkpoint wholesale and advances the sequence by one. The row takes the claim's attempt.
 *
 * Check order, as the core port documents it: invalid progress is a ConfigurationError before the store is touched, a lost
 * claim (including a job that does not exist) is a StaleClaimError, and only a live claim can see a ConflictError.
 */

/** The checkpoint bound in canonical UTF-8 bytes (MAX_JOB_CHECKPOINT_BYTES), written out from the spec. */
export const CHECKPOINT_LIMIT = 64 * 1024

export const JOBS = ["job-a", "job-B", "Job-a", "jöb", "job-a "] as const
export const WORKERS = ["w1", "w2", "W1", "wé", "w1 "] as const
export const TOKENS = ["tok-1", "tok-2", "TOK-1", "tök", "tok-1 ", "\u{1F600}"] as const

export interface Fence { worker: string; token: string; attempt: number }
export interface Claim extends Fence { live: boolean }
export interface ProgressSpec { percent?: number; checkpoint?: Record<string, unknown> }
export interface ProgressRow { attempt: number; sequence: number; percent?: number; checkpoint?: Record<string, unknown> }

export type Op =
  /** Writes (or replaces) the job row: a new claim, live or already expired. */
  | ({ k: "claim"; job: string } & Claim)
  /** Moves the lease of an existing job into the future or into the past. */
  | { k: "lease"; job: string; live: boolean }
  | { k: "write"; job: string; fence: Fence; expected: number; progress: ProgressSpec }
  | { k: "read"; job: string }

export type Outcome =
  | { ok: { jobId: string; attempt: number; sequence: number; percent?: number; checkpoint?: Record<string, unknown> } }
  | { ok: null }
  | { error: "ConfigurationError" | "StaleClaimError" | "ConflictError" }

export type RawProgress = { jobId: string; attempt: number; sequence: number; percent: number | null; checkpoint: Record<string, unknown> | null }

/** Key-sorted JSON (the canonical form for the plain values this model generates). */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value)
}

const utf8 = (text: string): number => new TextEncoder().encode(text).byteLength

/** A string or key containing U+0000, or an integer outside the safe range (canonical JSON refuses it). */
function unrepresentable(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000")
  if (typeof value === "number") return Number.isInteger(value) && !Number.isSafeInteger(value)
  if (Array.isArray(value)) return value.some(unrepresentable)
  if (value !== null && typeof value === "object") return Object.entries(value).some(([key, nested]) => key.includes("\u0000") || unrepresentable(nested))
  return false
}

export function invalidProgress(progress: ProgressSpec): boolean {
  if (progress.percent !== undefined && !(Number.isFinite(progress.percent) && progress.percent >= 0 && progress.percent <= 100)) return true
  if (progress.checkpoint === undefined) return false
  return utf8(canonical(progress.checkpoint)) > CHECKPOINT_LIMIT || unrepresentable(progress.checkpoint)
}

export class RefJobProgress {
  private readonly jobs = new Map<string, Claim>()
  private readonly rows = new Map<string, ProgressRow>()

  claim(op: { job: string } & Claim): void { this.jobs.set(op.job, { worker: op.worker, token: op.token, attempt: op.attempt, live: op.live }) }
  lease(op: { job: string; live: boolean }): void { const job = this.jobs.get(op.job); if (job) job.live = op.live }
  currentClaim(job: string): Claim | undefined { return this.jobs.get(job) }
  sequenceOf(job: string): number | undefined { return this.rows.get(job)?.sequence }

  read(job: string): Outcome {
    const row = this.rows.get(job)
    return row === undefined ? { ok: null } : { ok: this.view(job, row) }
  }

  write(op: { job: string; fence: Fence; expected: number; progress: ProgressSpec }): Outcome {
    if (invalidProgress(op.progress)) return { error: "ConfigurationError" }
    const job = this.jobs.get(op.job)
    if (job === undefined || !job.live || job.worker !== op.fence.worker || job.token !== op.fence.token || job.attempt !== op.fence.attempt) return { error: "StaleClaimError" }
    const existing = this.rows.get(op.job)
    if (existing === undefined ? op.expected !== 0 : existing.sequence !== op.expected) return { error: "ConflictError" }
    const row: ProgressRow = {
      attempt: job.attempt, sequence: op.expected + 1,
      // -0 is stored as 0, as every store (and canonical JSON) does; `+ 0` maps negative zero to positive zero.
      ...(op.progress.percent === undefined ? {} : { percent: op.progress.percent + 0 }),
      ...(op.progress.checkpoint === undefined ? {} : { checkpoint: op.progress.checkpoint }),
    }
    this.rows.set(op.job, row)
    return { ok: this.view(op.job, row) }
  }

  dump(): RawProgress[] {
    return [...this.rows].map(([jobId, row]) => ({ jobId, attempt: row.attempt, sequence: row.sequence, percent: row.percent ?? null, checkpoint: row.checkpoint ?? null })).sort(compareRaw)
  }

  private view(jobId: string, row: ProgressRow): Extract<Outcome, { ok: { jobId: string } }>["ok"] {
    return { jobId, attempt: row.attempt, sequence: row.sequence, ...(row.percent === undefined ? {} : { percent: row.percent }), ...(row.checkpoint === undefined ? {} : { checkpoint: row.checkpoint }) }
  }
}

export function compareRaw(a: RawProgress, b: RawProgress): number { return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0 }

// ---------------------------------------------------------------------------------------------------------------
// Generation

/** Finite percents at and around the bounds, a denormal, and values a decimal round trip could disturb. */
export const VALID_PERCENTS: readonly number[] = [0, -0, 100, 50, 0.5, 33.3333, 99.99999999999999, 1e-7, 12.345678901234567, Number.MIN_VALUE, 1]
export const INVALID_PERCENTS: readonly number[] = [-1, 101, 100.0000001, -0.0000001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE]

const CHECKPOINTS: ReadonlyArray<Record<string, unknown>> = [
  {}, { cursor: 4 }, { cursor: "page-2", done: false }, { nested: { list: [1, 2, { b: null }], empty: {} } }, { "é": "\u{1F600}", "€": "€" },
  { n: [0.1, -1.5e-7, 4.5e-9, 123456789.125, 2 ** 53 - 1, -3] }, { quote: "a\"b\\c\nd\te", slash: "/", html: "<&>" }, { z: 1, a: 2, m: { y: 1, b: 2 } },
  { flag: true, none: null, text: "" }, { "": "empty key", " ": "space key" },
]

/** Checkpoints the store must refuse with a ConfigurationError: U+0000 in a string or key, and integers beyond the safe range. */
export const INVALID_CHECKPOINTS: ReadonlyArray<Record<string, unknown>> = [
  { nul: "a\u0000b" }, { "k\u0000": 1 }, { list: ["ok", { deep: "\u0000" }] }, { big: 2 ** 53 }, { nested: { n: -(2 ** 60) } },
]

/** A checkpoint whose canonical size is the bound plus `delta` bytes (ASCII filler). */
export function checkpointOfSize(delta: number): Record<string, unknown> {
  const overhead = utf8(canonical({ k: "" }))
  return { k: "x".repeat(CHECKPOINT_LIMIT + delta - overhead) }
}

function generateProgress(rng: Rng): ProgressSpec {
  const progress: { percent?: number; checkpoint?: Record<string, unknown> } = {}
  const r = rng.int(100)
  if (r < 6) progress.percent = rng.pick(INVALID_PERCENTS)
  else if (r < 70) progress.percent = rng.pick(VALID_PERCENTS)
  const c = rng.int(100)
  if (c < 3) progress.checkpoint = checkpointOfSize(rng.pick([0, 1, -1, 5]))
  else if (c < 65) progress.checkpoint = rng.pick(CHECKPOINTS)
  else if (c < 70) progress.checkpoint = rng.pick(INVALID_CHECKPOINTS)
  return progress
}

export function generateOps(rng: Rng, options: { min?: number; max?: number } = {}): Op[] {
  const model = new RefJobProgress()
  const count = (options.min ?? 8) + rng.int((options.max ?? 24) - (options.min ?? 8) + 1)
  const ops: Op[] = []
  const claim = (): Op => ({ k: "claim", job: rng.pick(JOBS), worker: rng.pick(WORKERS), token: rng.pick(TOKENS), attempt: rng.pick([1, 2, 3, 0]), live: rng.bool(0.85) })
  for (let i = 0; i < count; i++) {
    const roll = rng.int(100)
    let op: Op
    if (i === 0 || roll < 12) op = claim()
    else if (roll < 20) op = { k: "lease", job: rng.pick(JOBS), live: rng.bool(0.5) }
    else if (roll < 30) op = { k: "read", job: rng.pick(JOBS) }
    else {
      const job = rng.pick(JOBS)
      const current = model.currentClaim(job)
      let fence: Fence
      if (current !== undefined && rng.bool(0.7)) {
        fence = { worker: current.worker, token: current.token, attempt: current.attempt }
        // One field off: every part of the fence has to match.
        const spoil = rng.int(10)
        if (spoil === 0) fence.worker = rng.pick(WORKERS.filter((w) => w !== fence.worker))
        else if (spoil === 1) fence.token = rng.pick(TOKENS.filter((t) => t !== fence.token))
        else if (spoil === 2) fence.attempt = current.attempt + rng.pick([1, -1, 2])
      } else fence = { worker: rng.pick(WORKERS), token: rng.pick(TOKENS), attempt: rng.pick([1, 2, 3, 0]) }
      const sequence = model.sequenceOf(job) ?? 0
      const expected = rng.bool(0.7) ? sequence : rng.pick([0, sequence + 1, Math.max(0, sequence - 1), 5, sequence + 3])
      op = { k: "write", job, fence, expected, progress: generateProgress(rng) }
    }
    if (op.k === "claim") model.claim(op)
    else if (op.k === "lease") model.lease(op)
    else if (op.k === "write") model.write(op)
    ops.push(op)
  }
  return ops
}

export function* shrinkOps(ops: Op[]): Iterable<Op[]> {
  for (let i = 0; i < ops.length; i++) yield [...ops.slice(0, i), ...ops.slice(i + 1)]
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.k !== "write") continue
    const { checkpoint, percent } = op.progress
    if (checkpoint !== undefined) yield [...ops.slice(0, i), { ...op, progress: percent === undefined ? {} : { percent } }, ...ops.slice(i + 1)]
    if (percent !== undefined) yield [...ops.slice(0, i), { ...op, progress: checkpoint === undefined ? {} : { checkpoint } }, ...ops.slice(i + 1)]
  }
}

const brief = (value: unknown): string => { const text = canonical(value); return text.length > 70 ? `${text.slice(0, 60)}...(${utf8(text)} bytes)` : text }
const fenceText = (fence: Fence): string => `${JSON.stringify(fence.worker)}/${JSON.stringify(fence.token)}/attempt ${fence.attempt}`

export function describeProgress(progress: ProgressSpec): string {
  return `percent=${progress.percent === undefined ? "-" : String(progress.percent)} checkpoint=${progress.checkpoint === undefined ? "-" : brief(progress.checkpoint)}`
}

export function describeOps(ops: Op[]): string {
  return ops.map((op, index) => {
    switch (op.k) {
      case "claim": return `${index}: claim ${JSON.stringify(op.job)} by ${fenceText(op)} ${op.live ? "live" : "expired"}`
      case "lease": return `${index}: lease ${JSON.stringify(op.job)} ${op.live ? "live" : "expired"}`
      case "read": return `${index}: read ${JSON.stringify(op.job)}`
      case "write": return `${index}: write ${JSON.stringify(op.job)} fence ${fenceText(op.fence)} expected=${op.expected} ${describeProgress(op.progress)}`
    }
  }).join("\n")
}
