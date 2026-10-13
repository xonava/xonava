/**
 * Deterministic fixtures for the workflow dispatcher differentials: a manual
 * clock, an in-memory WorkflowStore that follows the SQL stores' semantics
 * (drizzle-pg/drizzleWorkflowStore.ts), and a driver that runs a dispatch to
 * completion by firing fake timers in order.
 */
import type { TimerClock } from "../../kernel/clock"
import type { StartWorkflowInput, WorkflowFence, WorkflowStore } from "../../workflow/store"
import type { WorkflowClaim, WorkflowInstance, WorkflowSignal } from "../../workflow/types"
import { deliverWorkflowSignal, isWaitingForWorkflowSignal, isWorkflowSignalWait, isWorkflowTerminal, resumeWorkflowFromBufferedSignal } from "../../workflow/workflowStateMachine"

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

/** Plain-data view of a store's signal ledger, so the same invariant check can run against any store (memory, SQL). */
export interface SignalLedgerView {
  /** Every stored receipt in delivery order (the store's monotonic order). */
  readonly receipts: readonly { readonly id: string; readonly instanceId: string; readonly name: string }[]
  /** Ids of consumed receipts (each at most once). */
  readonly consumed: ReadonlySet<string>
  readonly rows: Iterable<{ readonly id: string; readonly status: string; readonly wakeAt: Date | null; readonly waitingSignal: string | null; readonly resumeSignalId?: string | null }>
}

/**
 * The structural invariants of the signal contract (docs/spec/workflow.md, "Signals"), as human-readable violations (empty when fine):
 * consumed receipts of one (instance, name) are a prefix of its delivery order (FIFO, no gaps); an instance that is waiting for a
 * signal has no pending receipt of that name (nothing is lost); `resumeSignalId` names a consumed receipt of the awaited name.
 */
export function signalLedgerViolations(view: SignalLedgerView): string[] {
  const violations: string[] = []
  const ids = new Set(view.receipts.map((receipt) => receipt.id))
  if (ids.size !== view.receipts.length) violations.push("a receipt id is stored twice")
  for (const id of view.consumed) if (!ids.has(id)) violations.push(`consumed receipt ${id} does not exist`)
  const byKey = new Map<string, boolean[]>()
  for (const receipt of view.receipts) {
    const key = JSON.stringify([receipt.instanceId, receipt.name])
    byKey.set(key, [...(byKey.get(key) ?? []), view.consumed.has(receipt.id)])
  }
  for (const [key, flags] of byKey) {
    const firstPending = flags.indexOf(false)
    if (firstPending !== -1 && flags.slice(firstPending).includes(true)) violations.push(`${key}: a later receipt was consumed while an older one is still pending`)
  }
  const byId = new Map(view.receipts.map((receipt) => [receipt.id, receipt]))
  for (const row of view.rows) {
    if (row.status === "waiting" && row.wakeAt === null && row.waitingSignal !== null) {
      const stuck = view.receipts.find((receipt) => receipt.instanceId === row.id && receipt.name === row.waitingSignal && !view.consumed.has(receipt.id))
      if (stuck) violations.push(`${row.id}: waiting for "${row.waitingSignal}" while receipt ${stuck.id} is pending (lost signal)`)
    }
    if (row.resumeSignalId !== undefined && row.resumeSignalId !== null) {
      const receipt = byId.get(row.resumeSignalId)
      if (!receipt || receipt.instanceId !== row.id) violations.push(`${row.id}: resumeSignalId ${row.resumeSignalId} is not a receipt of this instance`)
      else if (!view.consumed.has(receipt.id)) violations.push(`${row.id}: resumeSignalId ${receipt.id} is not consumed`)
      else if (row.waitingSignal !== receipt.name) violations.push(`${row.id}: resumeSignalId ${receipt.id} (${receipt.name}) does not match waitingSignal ${String(row.waitingSignal)}`)
    }
  }
  return violations
}

export interface CommitRecord { readonly instanceId: string; readonly claimToken: string; readonly workerId: string; readonly fenceRevision: number; readonly accepted: boolean }

/** One consumption of a signal receipt: by a delivery that woke a waiting instance, or by the commit of a `wait` that found it buffered. */
export interface Consumption { readonly signalId: string; readonly instanceId: string; readonly via: "deliver" | "commit"; readonly revision: number }

/**
 * In-memory store following the SQL stores: the store counts attempts at claim, owns revisions, and records signal receipts.
 * Receipts follow the buffering contract (docs/spec/workflow.md, "Signals"): `receipts` is in delivery order (the array index
 * is the store-assigned monotonic order), a receipt is pending until its id appears in `consumed`, and consumption happens
 * only inside `deliverSignal` (a waiting instance) or `commit` (a `wait` result with a pending receipt), always for the oldest
 * pending receipt of the awaited name.
 */
export class MemoryWorkflowStore implements WorkflowStore {
  readonly rows = new Map<string, WorkflowInstance>()
  readonly receipts: WorkflowSignal[] = []
  /** Consumed receipts by id. A receipt id appears here at most once (the store throws on a second consumption). */
  readonly consumed = new Map<string, Consumption>()
  readonly consumptions: Consumption[] = []
  readonly commits: CommitRecord[] = []
  /** Every claim ever handed out, in order. */
  readonly claims: Array<{ instanceId: string; claimToken: string; workerId: string; attempt: number; revision: number; resumeSignalId: string | null; consumedBefore: number }> = []
  #token = 0
  constructor(private readonly clock: ManualClock) {}

  get now(): number { return this.clock.current }

  async start(input: StartWorkflowInput): Promise<WorkflowInstance> {
    const at = this.clock.now()
    const row: WorkflowInstance = {
      id: input.id, workflowType: input.workflowType, workflowVersion: input.workflowVersion, executionScope: input.executionScope, status: "pending",
      currentStep: input.initialStep, variables: input.variables, stepAttempt: 0, compensationStack: [], waitingSignal: null, resumeSignalId: null, wakeAt: null, outcome: null,
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
      this.claims.push({ instanceId: row.id, claimToken, workerId: args.workerId, attempt: claimed.stepAttempt, revision: claimed.revision, resumeSignalId: claimed.resumeSignalId ?? null, consumedBefore: this.consumptions.length })
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
  /** The pending (unconsumed) receipts of one instance, optionally of one name, oldest first. */
  pending(instanceId: string, name?: string): WorkflowSignal[] {
    return this.receipts.filter((receipt) => receipt.instanceId === instanceId && (name === undefined || receipt.name === name) && !this.consumed.has(receipt.id))
  }
  /** The signal ledger as plain data (see signalLedgerViolations). */
  ledger(): SignalLedgerView { return { receipts: this.receipts, consumed: new Set(this.consumed.keys()), rows: this.rows.values() } }
  #consume(receipt: WorkflowSignal, via: Consumption["via"], revision: number): void {
    if (this.consumed.has(receipt.id)) throw new Error(`receipt ${receipt.id} consumed twice`)
    const record: Consumption = { signalId: receipt.id, instanceId: receipt.instanceId, via, revision }
    this.consumed.set(receipt.id, record)
    this.consumptions.push(record)
  }
  async commit(fence: WorkflowFence, next: WorkflowInstance): Promise<boolean> {
    const row = this.#current(fence)
    this.commits.push({ instanceId: fence.instanceId, claimToken: fence.claimToken, workerId: fence.workerId, fenceRevision: fence.revision, accepted: row !== undefined })
    if (!row) return false
    const at = new Date(this.clock.current)
    // Buffering: a `wait` for a name that already has a pending receipt consumes the oldest one and leaves the instance resumed, atomically with this commit.
    const buffered = isWorkflowSignalWait(next) ? this.pending(row.id, next.waitingSignal!)[0] : undefined
    const stored = buffered ? resumeWorkflowFromBufferedSignal(next, buffered, at) : next
    const revision = row.revision + 1
    this.rows.set(row.id, {
      ...row, workflowVersion: stored.workflowVersion, status: stored.status, currentStep: stored.currentStep, variables: stored.variables, stepAttempt: stored.stepAttempt,
      compensationStack: stored.compensationStack, waitingSignal: stored.waitingSignal, resumeSignalId: stored.resumeSignalId ?? null, wakeAt: stored.wakeAt, outcome: stored.outcome, failure: stored.failure ?? null,
      revision, leaseOwner: null, claimToken: null, leaseExpiresAt: null, updatedAt: at,
    })
    if (buffered) this.#consume(buffered, "commit", revision)
    return true
  }
  async deliverSignal(signal: Omit<WorkflowSignal, "deliveredAt">): Promise<{ delivered: boolean; duplicate: boolean }> {
    const row = this.rows.get(signal.instanceId)
    if (!row) return { delivered: false, duplicate: false }
    if (this.receipts.some((receipt) => receipt.id === signal.id)) return { delivered: false, duplicate: true }
    if (isWorkflowTerminal(row)) return { delivered: false, duplicate: false }
    const at = new Date(this.clock.current)
    this.receipts.push({ ...signal, deliveredAt: at })
    if (isWaitingForWorkflowSignal(row, signal.name)) {
      const oldest = this.pending(row.id, signal.name)[0]!
      const woken = deliverWorkflowSignal(row, oldest, at)
      this.rows.set(row.id, { ...row, status: woken.status, stepAttempt: woken.stepAttempt, waitingSignal: woken.waitingSignal, resumeSignalId: woken.resumeSignalId ?? null, wakeAt: woken.wakeAt, revision: woken.revision, updatedAt: at })
      this.#consume(oldest, "deliver", woken.revision)
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
      stepAttempt: 0, waitingSignal: null, resumeSignalId: null, wakeAt: null, revision: row.revision + 1, leaseOwner: null, claimToken: null, leaseExpiresAt: null, updatedAt: new Date(this.clock.current),
    })
    return true
  }
  async getSignalById(instanceId: string, signalId: string): Promise<WorkflowSignal | null> {
    return this.receipts.find((receipt) => receipt.instanceId === instanceId && receipt.id === signalId) ?? null
  }
  async getSignal(instanceId: string, name: string): Promise<WorkflowSignal | null> {
    return [...this.receipts].reverse().find((receipt) => receipt.instanceId === instanceId && receipt.name === name) ?? null
  }
}
