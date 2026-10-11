/**
 * Deterministic fixtures for the workflow dispatcher differentials: a manual
 * clock, an in-memory WorkflowStore that follows the SQL stores' semantics
 * (drizzle-pg/drizzleWorkflowStore.ts), and a driver that runs a dispatch to
 * completion by firing fake timers in order.
 */
import type { TimerClock } from "../../kernel/clock"
import type { StartWorkflowInput, WorkflowFence, WorkflowStore } from "../../workflow/store"
import type { WorkflowClaim, WorkflowInstance, WorkflowSignal } from "../../workflow/types"

export const EPOCH = Date.UTC(2026, 9, 1)

export class ManualClock implements TimerClock {
  readonly timers = new Map<number, { at: number; callback: () => void }>()
  #id = 0
  current = EPOCH
  now(): Date { return new Date(this.current) }
  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.#id
    this.timers.set(id, { at: this.current + Math.max(0, ms), callback })
    return id
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number) }
  /** Fires the earliest pending timer (ties in creation order), moving time forward to it. Returns false when none is pending. */
  fireNext(): boolean {
    let best: number | undefined
    for (const [id, timer] of this.timers) if (best === undefined || timer.at < this.timers.get(best)!.at) best = id
    if (best === undefined) return false
    const timer = this.timers.get(best)!
    this.timers.delete(best)
    this.current = Math.max(this.current, timer.at)
    timer.callback()
    return true
  }
  /** Moves time to `target` (possibly backwards) and fires every timer that is due, in order. */
  async jumpTo(target: number): Promise<void> {
    this.current = target
    for (;;) {
      let due: number | undefined
      for (const [id, timer] of this.timers) if (timer.at <= this.current && (due === undefined || timer.at < this.timers.get(due)!.at)) due = id
      if (due === undefined) return
      const timer = this.timers.get(due)!
      this.timers.delete(due)
      timer.callback()
      await flush()
    }
  }
}

/**
 * Lets every promise continuation settle. `setImmediate` runs only after the
 * microtask queue has drained completely, so this is deterministic and takes no
 * real time into account.
 */
export function flush(): Promise<void> { return new Promise((resolve) => { setImmediate(resolve) }) }

/** Runs `work` to completion, firing fake timers in time order whenever everything is idle. */
export async function drive<T>(work: Promise<T>, clock: ManualClock, options: { maxTimers?: number } = {}): Promise<T> {
  const box: { result?: { ok: true; value: T } | { ok: false; error: unknown } } = {}
  work.then((value) => { box.result = { ok: true, value } }, (error: unknown) => { box.result = { ok: false, error } })
  const limit = options.maxTimers ?? 500
  const outcome = (): T | undefined => {
    if (box.result === undefined) return undefined
    if (box.result.ok) return box.result.value
    throw box.result.error
  }
  for (let fired = 0; fired <= limit; fired++) {
    await flush()
    if (box.result !== undefined) return outcome() as T
    if (!clock.fireNext()) {
      await flush()
      if (box.result !== undefined) return outcome() as T
      throw new Error("deadlock: the dispatch is waiting but no timer is pending")
    }
  }
  throw new Error(`the dispatch did not finish after ${limit} timers`)
}

export interface CommitRecord { readonly instanceId: string; readonly claimToken: string; readonly workerId: string; readonly fenceRevision: number; readonly accepted: boolean }

/** In-memory store following the SQL stores: the store counts attempts at claim, owns revisions, and records signal receipts. */
export class MemoryWorkflowStore implements WorkflowStore {
  readonly rows = new Map<string, WorkflowInstance>()
  readonly receipts: WorkflowSignal[] = []
  readonly commits: CommitRecord[] = []
  /** Every claim ever handed out, in order. */
  readonly claims: Array<{ instanceId: string; claimToken: string; workerId: string; attempt: number; revision: number }> = []
  #token = 0
  constructor(private readonly clock: ManualClock) {}

  get now(): number { return this.clock.current }

  async start(input: StartWorkflowInput): Promise<WorkflowInstance> {
    const at = this.clock.now()
    const row: WorkflowInstance = {
      id: input.id, workflowType: input.workflowType, workflowVersion: input.workflowVersion, executionScope: input.executionScope, status: "pending",
      currentStep: input.initialStep, variables: input.variables, stepAttempt: 0, compensationStack: [], waitingSignal: null, wakeAt: null, outcome: null,
      revision: 0, failure: null, leaseOwner: null, claimToken: null, leaseExpiresAt: null, createdAt: at, updatedAt: at,
    }
    this.rows.set(row.id, row)
    return row
  }
  async get(instanceId: string): Promise<WorkflowInstance | null> { return this.rows.get(instanceId) ?? null }

  async claimDue(args: { workerId: string; limit: number; leaseDurationMs: number }): Promise<readonly WorkflowClaim[]> {
    const now = this.clock.current
    const due = [...this.rows.values()]
      .filter((row) => (row.status === "pending" || (row.status === "compensating" && (row.wakeAt === null || row.wakeAt.getTime() <= now)) || (row.status === "waiting" && row.wakeAt !== null && row.wakeAt.getTime() <= now)) &&
        (row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() <= now))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .slice(0, args.limit)
    return due.map((row) => {
      const claimToken = `token-${++this.#token}`
      const claimed: WorkflowInstance = {
        ...row, status: row.status === "waiting" ? "pending" : row.status, leaseOwner: args.workerId, claimToken, leaseExpiresAt: new Date(now + args.leaseDurationMs),
        stepAttempt: row.stepAttempt + 1, revision: row.revision + 1, updatedAt: new Date(now),
      }
      this.rows.set(row.id, claimed)
      this.claims.push({ instanceId: row.id, claimToken, workerId: args.workerId, attempt: claimed.stepAttempt, revision: claimed.revision })
      return { instance: claimed, workerId: args.workerId, claimToken }
    })
  }

  #current(fence: WorkflowFence): WorkflowInstance | undefined {
    const row = this.rows.get(fence.instanceId)
    return row && row.leaseOwner === fence.workerId && row.claimToken === fence.claimToken && row.revision === fence.revision && row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > this.clock.current ? row : undefined
  }
  async assertLease(fence: WorkflowFence): Promise<boolean> { return this.#current(fence) !== undefined }
  async renewLease(fence: WorkflowFence, extendByMs: number): Promise<boolean> {
    const row = this.#current(fence)
    if (!row) return false
    this.rows.set(row.id, { ...row, leaseExpiresAt: new Date(Math.max(row.leaseExpiresAt!.getTime(), this.clock.current + extendByMs)) })
    return true
  }
  async commit(fence: WorkflowFence, next: WorkflowInstance): Promise<boolean> {
    const row = this.#current(fence)
    this.commits.push({ instanceId: fence.instanceId, claimToken: fence.claimToken, workerId: fence.workerId, fenceRevision: fence.revision, accepted: row !== undefined })
    if (!row) return false
    this.rows.set(row.id, {
      ...row, workflowVersion: next.workflowVersion, status: next.status, currentStep: next.currentStep, variables: next.variables, stepAttempt: next.stepAttempt,
      compensationStack: next.compensationStack, waitingSignal: next.waitingSignal, wakeAt: next.wakeAt, outcome: next.outcome, failure: next.failure ?? null,
      revision: row.revision + 1, leaseOwner: null, claimToken: null, leaseExpiresAt: null, updatedAt: new Date(this.clock.current),
    })
    return true
  }
  async deliverSignal(signal: Omit<WorkflowSignal, "deliveredAt">): Promise<{ delivered: boolean; duplicate: boolean }> {
    const row = this.rows.get(signal.instanceId)
    if (!row) return { delivered: false, duplicate: false }
    if (this.receipts.some((receipt) => receipt.id === signal.id)) return { delivered: false, duplicate: true }
    this.receipts.push({ ...signal, deliveredAt: new Date(this.clock.current) })
    if (row.status === "waiting" && row.wakeAt === null && row.waitingSignal === signal.name) {
      this.rows.set(row.id, { ...row, status: "pending", wakeAt: null, stepAttempt: 0, revision: row.revision + 1, updatedAt: new Date(this.clock.current) })
    }
    return { delivered: true, duplicate: false }
  }
  async cancel(instanceId: string): Promise<boolean> {
    const row = this.rows.get(instanceId)
    if (!row || ["succeeded", "failed", "cancelled", "compensation_failed", "compensating"].includes(row.status)) return false
    const compensate = row.compensationStack.length > 0
    this.rows.set(row.id, {
      ...row, status: compensate ? "compensating" : "cancelled", outcome: compensate ? null : "cancelled",
      failure: { code: "CANCELLED", message: "Workflow was cancelled", step: row.currentStep, phase: "execute", attempt: row.stepAttempt, at: new Date(this.clock.current) },
      stepAttempt: 0, waitingSignal: null, wakeAt: null, revision: row.revision + 1, leaseOwner: null, claimToken: null, leaseExpiresAt: null, updatedAt: new Date(this.clock.current),
    })
    return true
  }
  async getSignal(instanceId: string, name: string): Promise<WorkflowSignal | null> {
    return [...this.receipts].reverse().find((receipt) => receipt.instanceId === instanceId && receipt.name === name) ?? null
  }
}
