import { randomUUID } from "node:crypto"
import { createJobRegistry, type JobDefinition, type JobRegistry, type JobResult } from "@xonava/core/execution"
import { createWorkflowRegistry, type WorkflowDefinition, type WorkflowRegistry } from "@xonava/core/workflow"
import type { SoakSql } from "./backends.js"

/**
 * The work the soak workers run, and the exact bookkeeping the invariants are checked from. The bookkeeping lives in the
 * same database as the framework tables but is written by the handlers themselves, outside the framework's own state:
 *
 *  - soak_inflight: one row per unit of work being executed right now (PRIMARY KEY unit). A second worker entering a
 *    unit that is already in flight is a concurrent execution; it is recorded in soak_violations. The orchestrator
 *    removes the rows of a worker it killed (the killed handler can no longer be running).
 *  - soak_runs: one row per (unit, attempt) handler start. A second start of the same attempt is recorded as a violation.
 *  - soak_signal_uses: which signal receipt resumed which wait (PRIMARY KEY signal_id + n_after). A receipt that
 *    resumed two different waits has two rows.
 */
export const JOB_TYPE = "soak.job"
export const WORKFLOW_TYPE = "soak.flow"
export const SIGNAL_NAME = "tick"

export type JobScript = "ok" | "retry-then-ok" | "permanent" | "always-retry" | "slow"
export interface SoakJobPayload extends Record<string, unknown> {
  script: JobScript
  /** How long the handler works, in milliseconds. */
  ms: number
  partition?: string
}

export interface WorkloadContext {
  readonly sql: SoakSql
  readonly workerId: string
}

export async function recordViolation(ctx: WorkloadContext, kind: string, unit: string, detail: string): Promise<void> {
  await ctx.sql.insertIgnore(ctx.sql.table("soak_violations"), { id: randomUUID(), kind, unit, detail: detail.slice(0, 500), worker: ctx.workerId, at_ms: Date.now() })
}

/** Marks `unit` in flight; reports a concurrent execution when it already is. Returns whether this worker now holds it. */
async function enter(ctx: WorkloadContext, unit: string, held: string[]): Promise<void> {
  const inserted = await ctx.sql.insertIgnore(ctx.sql.table("soak_inflight"), { unit, worker: ctx.workerId, started_ms: Date.now() })
  if (inserted) held.push(unit)
  else await recordViolation(ctx, "concurrent-execution", unit, `${ctx.workerId} started ${unit} while it was already in flight`)
}

async function leave(ctx: WorkloadContext, held: readonly string[]): Promise<void> {
  for (const unit of held) await ctx.sql.run(`DELETE FROM ${ctx.sql.table("soak_inflight")} WHERE unit = ? AND worker = ?`, [unit, ctx.workerId])
}

async function recordRun(ctx: WorkloadContext, unit: string, attempt: number): Promise<void> {
  const fresh = await ctx.sql.insertIgnore(ctx.sql.table("soak_runs"), { unit, attempt, worker: ctx.workerId, started_ms: Date.now(), outcome: null })
  if (!fresh) await recordViolation(ctx, "attempt-ran-twice", unit, `${ctx.workerId} started attempt ${attempt} of ${unit}, which already started once`)
}

function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = (): void => { clearTimeout(handle); resolve() }
    const handle = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export function createSoakJobDefinition(ctx: WorkloadContext): JobDefinition {
  return {
    type: JOB_TYPE, version: 1, scope: "system", maxAttempts: 3, retryDelayMs: 200, retryBackoffMultiplier: 1,
    decodePayload: (input) => input as Record<string, unknown>,
    execute: async (execution): Promise<JobResult> => {
      const payload = execution.payload as SoakJobPayload
      const unit = `job:${execution.jobId}`
      const held: string[] = []
      try {
        await enter(ctx, unit, held)
        if (payload.partition !== undefined) await enter(ctx, `partition:${payload.partition}`, held)
        await recordRun(ctx, unit, execution.attempt)
        await sleepUnlessAborted(payload.ms, execution.signal)
        let result: JobResult
        let outcome: string
        if (payload.script === "ok" || payload.script === "slow" || (payload.script === "retry-then-ok" && execution.attempt > 1)) { result = { success: true }; outcome = "success" }
        else if (payload.script === "permanent") { result = { success: false, error: Object.assign(new Error("permanent"), { kind: "permanent" as const }) }; outcome = "permanent" }
        else { result = { success: false, error: Object.assign(new Error("retry"), { kind: "retryable" as const }) }; outcome = "retry" }
        await ctx.sql.run(`UPDATE ${ctx.sql.table("soak_runs")} SET outcome = ? WHERE unit = ? AND attempt = ?`, [outcome, unit, execution.attempt])
        return result
      } finally { await leave(ctx, held) }
    },
  }
}

export function createSoakJobRegistry(ctx: WorkloadContext): JobRegistry {
  const registry = createJobRegistry()
  registry.register(createSoakJobDefinition(ctx))
  return registry
}

const STEP_RETRY = { maxAttempts: 12, initialDelayMs: 100, backoffMultiplier: 1, maxDelayMs: 100, jitter: "none" } as const

/**
 * begin -> gate. `gate` waits for SIGNAL_NAME `target` times: every time it runs it is either entered fresh (no signal:
 * wait) or resumed by exactly one receipt (n advances and the receipt is recorded against the new n). The instance
 * succeeds when n reaches target.
 */
export function createSoakWorkflowDefinition(ctx: WorkloadContext): WorkflowDefinition {
  const count = (variables: Readonly<Record<string, unknown>>, key: "n" | "target"): number => Number(variables[key] ?? 0)
  return {
    type: WORKFLOW_TYPE, version: 1, initialStep: "begin",
    decodeVariables: (value) => value as Readonly<Record<string, unknown>>,
    steps: {
      begin: {
        name: "begin", datasource: "main", retry: STEP_RETRY, idempotent: true,
        execute: async (step) => ({ kind: "next", step: "gate", variables: { ...step.variables, n: 0 } }),
      },
      gate: {
        name: "gate", datasource: "main", retry: STEP_RETRY, idempotent: true,
        execute: async (step) => {
          const held: string[] = []
          try {
            await enter(ctx, `wf:${step.instanceId}`, held)
            const n = count(step.variables, "n")
            await recordRun(ctx, `wf:${step.instanceId}:gate:${n}:${step.signal?.id ?? "fresh"}`, step.attempt)
            if (step.signal === undefined) return { kind: "wait", signal: SIGNAL_NAME, variables: step.variables }
            const next = n + 1
            await ctx.sql.insertIgnore(ctx.sql.table("soak_signal_uses"), { signal_id: step.signal.id, n_after: next })
            const variables = { ...step.variables, n: next }
            return next >= count(step.variables, "target") ? { kind: "complete", variables } : { kind: "wait", signal: SIGNAL_NAME, variables }
          } finally { await leave(ctx, held) }
        },
      },
    },
  }
}

export function createSoakWorkflowRegistry(ctx: WorkloadContext): WorkflowRegistry {
  const registry = createWorkflowRegistry()
  registry.register(createSoakWorkflowDefinition(ctx))
  return registry
}
