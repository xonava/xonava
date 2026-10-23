import type { WorkflowInstance } from "@xonava/core/workflow"
import { signalLedgerViolations } from "../../core/src/__tests__/differential/workflowFixtures.js"
import type { DbReceipt } from "../integration/shared/workflowSignalBuffering.js"

/**
 * The soak's invariant checkers. They take plain rows read from the database (and the bookkeeping the handlers wrote), never
 * a connection, so tests/soakInvariants.test.ts can prove each one fires on a synthetic violation. Each returns one message
 * per violation; an empty array means the invariant holds.
 */
export const JOB_TERMINAL = ["succeeded", "failed", "dead_letter", "cancelled"] as const
export const EXECUTION_TERMINAL = ["succeeded", "failed", "dead_letter"] as const
export const WORKFLOW_TERMINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled", "compensation_failed"])
export const MINUTE = 60_000

export interface ViolationRow { readonly kind: string; readonly unit: string; readonly detail: string }
export interface InflightRow { readonly unit: string; readonly worker: string }
export interface JobRow { readonly id: string; readonly status: string; readonly attempts: number; readonly maxAttempts: number }
export interface RunRow { readonly unit: string; readonly attempt: number; readonly outcome: string | null }
export interface HistoryRow { readonly jobId: string; readonly terminalRows: number }
export interface ScheduleObservation {
  readonly id: string
  readonly nextRunAt: number | null
  /** The idempotency keys of every job stored for the schedule's correlation id. */
  readonly storedKeys: readonly string[]
}
export interface WorkflowObservation {
  readonly ids: readonly string[]
  readonly instances: readonly WorkflowInstance[]
  readonly receipts: readonly DbReceipt[]
  /** signal id -> number of different waits it was recorded as resuming. */
  readonly useCount: ReadonlyMap<string, number>
  readonly signalsPerWorkflow: number
}

export function recordedViolations(rows: readonly ViolationRow[], kind: "concurrent-execution" | "attempt-ran-twice"): string[] {
  return rows.filter((row) => row.kind === kind).map((row) => `${row.unit}: ${row.detail}`)
}

export function leftInFlight(rows: readonly InflightRow[]): string[] {
  return rows.map((row) => `${row.unit} still held by ${row.worker}`)
}

export function nonTerminalJobs(jobs: readonly JobRow[]): string[] {
  return jobs.filter((job) => !(JOB_TERMINAL as readonly string[]).includes(job.status)).map((job) => `job ${job.id} ended ${job.status}`)
}

/** Attempts within budget, handler runs within attempts, success recorded for every succeeded job, no scripted failure succeeded. */
export function jobConsistencyViolations(jobs: readonly JobRow[], runs: readonly RunRow[], scripts: ReadonlyMap<string, string>): string[] {
  const runsByJob = new Map<string, RunRow[]>()
  for (const run of runs) {
    const id = run.unit.slice("job:".length)
    runsByJob.set(id, [...(runsByJob.get(id) ?? []), run])
  }
  const found: string[] = []
  for (const job of jobs) {
    const budget = Math.min(job.maxAttempts, 3)
    const own = runsByJob.get(job.id) ?? []
    if (job.attempts > budget) found.push(`job ${job.id}: ${job.attempts} attempts exceed the budget of ${budget}`)
    if (own.some((run) => run.attempt > job.attempts)) found.push(`job ${job.id}: a handler ran attempt ${Math.max(...own.map((run) => run.attempt))} but the job records ${job.attempts}`)
    if (own.length > job.attempts) found.push(`job ${job.id}: ${own.length} handler runs for ${job.attempts} attempts`)
    if (job.status === "succeeded" && !own.some((run) => run.outcome === "success")) found.push(`job ${job.id} succeeded but no handler run reported success`)
    const script = scripts.get(job.id)
    if (job.status === "succeeded" && (script === "permanent" || script === "always-retry")) found.push(`job ${job.id} (${script}) succeeded`)
  }
  return found
}

export function historyViolations(rows: readonly HistoryRow[]): string[] {
  return rows.filter((row) => row.terminalRows > 1).map((row) => `job ${row.jobId} has ${row.terminalRows} terminal history rows`)
}

/** Exactly the minute occurrences from `firstRun` up to the one before next_run_at, each stored once, and next_run_at past the cutoff. */
export function scheduleViolations(schedules: readonly ScheduleObservation[], firstRun: number, cutoff: number): string[] {
  const found: string[] = []
  for (const { id, nextRunAt, storedKeys } of schedules) {
    if (nextRunAt === null) { found.push(`${id} has no next_run_at`); continue }
    if (nextRunAt <= cutoff) found.push(`${id} next_run_at ${new Date(nextRunAt).toISOString()} is not past the cutoff`)
    const seen = new Set(storedKeys)
    if (seen.size !== storedKeys.length) found.push(`${id}: an occurrence is stored more than once`)
    const wanted = new Set<string>()
    for (let at = firstRun; at < nextRunAt; at += MINUTE) wanted.add(`schedule:${id}:${new Date(at).toISOString()}`)
    for (const key of wanted) if (!seen.has(key)) found.push(`${id}: occurrence lost: ${key}`)
    for (const key of seen) if (!wanted.has(key)) found.push(`${id}: unexpected occurrence ${key}`)
  }
  return found
}

export function expectedOccurrences(nextRunAt: number, firstRun: number): number {
  return Math.max(0, Math.ceil((nextRunAt - firstRun) / MINUTE))
}

export function nonTerminalWorkflows(ids: readonly string[], instances: readonly WorkflowInstance[]): string[] {
  return ids.filter((id) => !instances.some((instance) => instance.id === id && WORKFLOW_TERMINAL.has(instance.status))).map((id) => `workflow ${id} is not terminal`)
}

/** The store's signal ledger, plus: a receipt resumes at most one wait, consumed receipts carry a revision, succeeded instances used every signal once. */
export function signalViolations(input: WorkflowObservation): string[] {
  const { receipts, instances, useCount } = input
  const consumed = new Set(receipts.filter((receipt) => receipt.consumed).map((receipt) => receipt.id))
  const found = signalLedgerViolations({ receipts, consumed, rows: instances })
  for (const [signalId, uses] of useCount) if (uses > 1) found.push(`receipt ${signalId} resumed ${uses} different waits`)
  for (const receipt of receipts) {
    if (!receipt.consumed && (useCount.get(receipt.id) ?? 0) > 0) found.push(`receipt ${receipt.id} resumed a wait but is not marked consumed`)
    if (receipt.consumed && receipt.consumedRevision === null) found.push(`receipt ${receipt.id} is consumed without a consuming revision`)
  }
  for (const instance of instances) {
    if (instance.status !== "succeeded") continue
    const own = receipts.filter((receipt) => receipt.instanceId === instance.id)
    if (Number(instance.variables.n) !== input.signalsPerWorkflow) found.push(`${instance.id} succeeded with n=${String(instance.variables.n)}`)
    if (own.length !== input.signalsPerWorkflow || own.some((receipt) => !receipt.consumed)) found.push(`${instance.id} succeeded with ${own.filter((receipt) => receipt.consumed).length}/${own.length} receipts consumed`)
    if (own.some((receipt) => useCount.get(receipt.id) !== 1)) found.push(`${instance.id}: a receipt was not used by exactly one wait`)
  }
  return found
}
