import { behaviorAt, LEASE_MS as DEFAULT_LEASE_MS, STEP_NAMES, STEP_TIMEOUT_MS as DEFAULT_STEP_TIMEOUT_MS, stableJson, type Behavior, type InvocationRecord, type ThrowKind, type WorldSpec } from "./workflowWorld"

/**
 * Independent reference model of the workflow state machine
 * (docs/spec/workflow.md, docs/spec/workflow/durable-state.md).
 *
 * The model works on a small plain-data view of an instance and is written
 * from the spec's transition table, not from workflowStateMachine.ts. It is
 * pure: every transition returns a new value or a rejection kind.
 */

export type RefStatus = "pending" | "running" | "waiting" | "compensating" | "succeeded" | "failed" | "cancelled" | "compensation_failed"
export type RefOutcome = "succeeded" | "failed" | "cancelled" | null

export interface RefFailure { code: string; step: string; phase: "execute" | "compensate"; attempt: number; at: number; message?: string | undefined }

export interface RefInstance {
  status: RefStatus
  step: string
  vars: Record<string, unknown>
  attempt: number
  stack: string[]
  signal: string | null
  /** Id of the receipt that resumed the current step (null: not resumed by a signal). */
  resume: string | null
  wakeAt: number | null
  outcome: RefOutcome
  revision: number
  failure: RefFailure | null
  leased: boolean
}

export type RefResult =
  | { kind: "next"; step: string; variables?: Record<string, unknown>; compensation?: string }
  | { kind: "wait"; signal: string; variables?: Record<string, unknown> }
  | { kind: "sleep"; wakeAt: number; variables?: Record<string, unknown> }
  | { kind: "complete"; variables?: Record<string, unknown> }
  | { kind: "retry"; error: string }
  | { kind: "fail"; error: string }

export type RefEvent =
  | { t: "claim"; leaseMs: number }
  | { t: "step"; result: RefResult }
  | { t: "retryAt"; wakeAt: number | "invalid" }
  | { t: "failStep"; failure: RefFailure }
  | { t: "failComp"; failure: RefFailure }
  | { t: "stall"; failure: RefFailure; wakeAt: number | "invalid" }
  | { t: "signal"; name: string; id: string }
  /** A `wait` commit found a pending receipt: the instance is stored resumed (same commit, so no extra revision). */
  | { t: "buffered"; id: string }
  | { t: "release" }
  | { t: "cancel" }
  | { t: "completeComp" }

export type Rejection = "state" | "definition"
export type RefOutcomeOrError = { ok: RefInstance } | { err: Rejection }

export const TERMINAL: readonly RefStatus[] = ["succeeded", "failed", "cancelled", "compensation_failed"]
export const isTerminalStatus = (status: RefStatus): boolean => TERMINAL.includes(status)

/** Largest durable variables object, in UTF-8 bytes of its canonical JSON form. */
export const REF_MAX_DURABLE_BYTES = 65_536

/** Canonical JSON byte length for the flat string/number/boolean/null objects the model generates. */
export function refDurableBytes(vars: Record<string, unknown>): number {
  const keys = Object.keys(vars).sort()
  const body = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(vars[key])}`).join(",")
  return new TextEncoder().encode(`{${body}}`).byteLength
}

const ok = (instance: RefInstance): RefOutcomeOrError => ({ ok: instance })
const reject = (err: Rejection): RefOutcomeOrError => ({ err })

function bump(from: RefInstance, patch: Partial<RefInstance>): RefInstance {
  return { ...from, stack: [...from.stack], vars: { ...from.vars }, leased: false, ...patch, revision: from.revision + 1 }
}

function enterFailure(i: RefInstance, failure: RefFailure): RefInstance {
  const compensate = i.stack.length > 0
  return bump(i, { status: compensate ? "compensating" : "failed", outcome: compensate ? null : "failed", attempt: 0, signal: null, resume: null, wakeAt: null, failure })
}

function failCompensation(i: RefInstance, failure: RefFailure): RefOutcomeOrError {
  if (i.status !== "compensating") return reject("state")
  return ok(bump(i, { status: "compensation_failed", outcome: "failed", wakeAt: null, resume: null, failure }))
}

function cancel(i: RefInstance, at: number): RefInstance {
  if (isTerminalStatus(i.status) || i.status === "compensating") return i
  const compensate = i.stack.length > 0
  return bump(i, {
    status: compensate ? "compensating" : "cancelled",
    outcome: compensate ? null : "cancelled",
    attempt: 0, signal: null, resume: null, wakeAt: null,
    failure: { code: "CANCELLED", message: "Workflow was cancelled", step: i.step, phase: "execute", attempt: i.attempt, at },
  })
}

/** The reference transition function. `now` is the transition timestamp in epoch milliseconds. */
export function refApply(i: RefInstance, event: RefEvent, now: number): RefOutcomeOrError {
  const terminal = isTerminalStatus(i.status)
  switch (event.t) {
    case "claim": {
      // Store behaviour (not a core transition): only live work can be claimed.
      return ok({ ...i, stack: [...i.stack], vars: { ...i.vars }, status: i.status === "waiting" ? "pending" : i.status, attempt: i.attempt + 1, revision: i.revision + 1, leased: true })
    }
    case "step": {
      if (terminal) return reject("state")
      const result = event.result
      const compensating = i.status === "compensating"
      if (result.kind === "fail") {
        const phase = compensating ? "compensate" : "execute"
        const step = compensating ? (i.stack[i.stack.length - 1] ?? i.step) : i.step
        const failure: RefFailure = { code: "STEP_FAILED", message: result.error, step, phase, attempt: i.attempt, at: now }
        return compensating ? failCompensation(i, failure) : ok(enterFailure(i, failure))
      }
      if (compensating && result.kind !== "retry") return reject("state")
      if (result.kind !== "retry") {
        const merged = { ...i.vars, ...(result.variables ?? {}) }
        if (refDurableBytes(merged) > REF_MAX_DURABLE_BYTES) return reject("definition")
      }
      switch (result.kind) {
        case "next": return ok(bump(i, { failure: null, resume: null, status: "pending", step: result.step, attempt: 0, stack: result.compensation ? [...i.stack, result.compensation] : [...i.stack], signal: null, wakeAt: null, vars: { ...i.vars, ...(result.variables ?? {}) } }))
        case "wait": return ok(bump(i, { failure: null, resume: null, status: "waiting", attempt: 0, signal: result.signal, wakeAt: null, vars: { ...i.vars, ...(result.variables ?? {}) } }))
        case "sleep": return ok(bump(i, { failure: null, resume: null, status: "waiting", attempt: 0, signal: null, wakeAt: result.wakeAt, vars: { ...i.vars, ...(result.variables ?? {}) } }))
        case "complete": return ok(bump(i, { failure: null, resume: null, status: "succeeded", outcome: "succeeded", signal: null, wakeAt: null, vars: { ...i.vars, ...(result.variables ?? {}) } }))
        case "retry": return ok(bump(i, { status: compensating ? "compensating" : "pending", wakeAt: null }))
      }
      return reject("state")
    }
    case "retryAt": {
      if (terminal || event.wakeAt === "invalid") return reject("state")
      return ok(bump(i, { status: i.status === "compensating" ? "compensating" : "waiting", wakeAt: event.wakeAt }))
    }
    case "failStep": {
      if (terminal) return reject("state")
      return i.status === "compensating" ? failCompensation(i, event.failure) : ok(enterFailure(i, event.failure))
    }
    case "failComp": return failCompensation(i, event.failure)
    case "stall": {
      if (terminal || event.wakeAt === "invalid") return reject("state")
      const compensating = i.status === "compensating"
      return ok(bump(i, { status: compensating ? "compensating" : "waiting", wakeAt: event.wakeAt, ...(compensating ? {} : { failure: event.failure }) }))
    }
    case "signal": {
      if (i.status !== "waiting" || i.wakeAt !== null || i.signal !== event.name) return reject("state")
      return ok(bump(i, { status: "pending", attempt: 0, wakeAt: null, resume: event.id }))
    }
    case "buffered": {
      if (i.status !== "waiting" || i.wakeAt !== null || i.signal === null) return reject("state")
      return ok({ ...i, stack: [...i.stack], vars: { ...i.vars }, leased: false, status: "pending", attempt: 0, wakeAt: null, resume: event.id })
    }
    case "release": {
      if (terminal) return reject("state")
      return ok(bump(i, { attempt: Math.max(0, i.attempt - 1) }))
    }
    case "cancel": return ok(cancel(i, now))
    case "completeComp": {
      if (i.status !== "compensating") return reject("state")
      const stack = i.stack.slice(0, -1)
      const finalOutcome: "cancelled" | "failed" = i.failure?.code === "CANCELLED" ? "cancelled" : "failed"
      return ok(bump(i, { stack, status: stack.length > 0 ? "compensating" : finalOutcome, outcome: stack.length > 0 ? null : finalOutcome, attempt: 0, wakeAt: null }))
    }
  }
}

/** Reference backoff schedule (docs/spec/resilience.md): delay after failed attempt n (1-based). */
export interface RefPolicy { maxAttempts: number; initialDelayMs: number; backoffMultiplier: number; maxDelayMs: number; jitter: "none" | "equal" }

export function refBackoffDelay(policy: RefPolicy, failedAttempt: number, sample: number): number {
  let base = policy.initialDelayMs
  for (let n = 1; n < failedAttempt && base < policy.maxDelayMs; n++) base *= policy.backoffMultiplier
  base = Math.min(base, policy.maxDelayMs)
  return policy.jitter === "none" ? Math.floor(base) : Math.floor(base / 2 + (sample * base) / 2)
}

// ---------------------------------------------------------------------------
// Dispatcher model (docs/spec/workflow/durable-state.md, "Attempts, retry, and failure")


export interface ModelRow extends RefInstance { id: string; type: string; version: number; leaseExpiresAt: number | null }
export interface ModelReceipt { id: string; instanceId: string; name: string; consumed: boolean }
export interface ModelCounts { claimed: number; advanced: number; compensated: number; retried: number; deferred: number; stalled: number; leaseLost: number; failed: number }
type ClaimOutcome = "advanced" | "compensated" | "retried" | "deferred" | "stalled" | "failed" | "lease-lost"

/** What a thrown value looks like to the dispatcher. */
type Thrown = { retryable: boolean; code: string | null; text: string | null; isError: boolean }

function describeThrown(kind: ThrowKind): Thrown {
  switch (kind) {
    case "plain": return { retryable: false, code: null, text: "plain boom", isError: true }
    case "coded": return { retryable: false, code: "E_DOWN", text: "service down", isError: true }
    case "codedBad": return { retryable: false, code: "lower", text: "odd code", isError: true }
    case "retryable": return { retryable: true, code: null, text: "try later", isError: true }
    case "kindRetryable": return { retryable: true, code: null, text: "kind later", isError: true }
    case "retryableCoded": return { retryable: true, code: "E_BUSY", text: "busy", isError: true }
    case "string": return { retryable: false, code: null, text: "oops", isError: false }
    case "null":
    case "undefined":
    case "number": return { retryable: false, code: null, text: null, isError: false }
    case "object": return { retryable: true, code: null, text: null, isError: false }
    case "leaseLost": throw new Error("lease loss is not a step error")
  }
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_.:-]{0,63}$/

/** A step's resolution on the model timeline. */
type Play =
  | { kind: "settled"; value: Behavior | "void"; at: number }
  | { kind: "threw"; error: ThrowKind; at: number }
  | { kind: "hung"; cooperative: "abort" | "resolve" | "none" }
  | { kind: "late"; settleAt: number; hangsAfter: boolean }

const stepResultOf = (behavior: Behavior, at: number): RefResult | "invalid" | "malformed" | null => {
  switch (behavior.k) {
    case "next": return { kind: "next", step: behavior.to, ...(behavior.comp !== undefined ? { compensation: behavior.comp } : {}), ...(behavior.vars ? { variables: behavior.vars } : {}) }
    case "wait": return { kind: "wait", signal: behavior.sig, ...(behavior.vars ? { variables: behavior.vars } : {}) }
    case "sleep": return { kind: "sleep", wakeAt: at + behavior.delay, ...(behavior.vars ? { variables: behavior.vars } : {}) }
    case "complete": return { kind: "complete", ...(behavior.vars ? { variables: behavior.vars } : {}) }
    case "retry": return { kind: "retry", error: "again" }
    case "fail": return { kind: "fail", error: "boom" }
    case "junk": return "invalid"
    case "malformed": return "malformed"
    default: return null
  }
}

export class ModelDispatcher {
  readonly rows = new Map<string, ModelRow>()
  readonly receipts: ModelReceipt[] = []
  readonly counters = new Map<string, number>()
  readonly log: InvocationRecord[] = []
  time: number
  samples: readonly number[]
  #sampleIndex = 0

  readonly leaseMs: number
  readonly timeoutMs: number

  constructor(readonly spec: WorldSpec, time: number, samples: readonly number[]) {
    this.time = time
    this.samples = samples
    this.leaseMs = spec.leaseMs ?? DEFAULT_LEASE_MS
    this.timeoutMs = spec.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  }

  start(id: string, type: string, version: number, vars: Record<string, unknown>): void {
    this.rows.set(id, { id, type, version, status: "pending", step: "a", vars, attempt: 0, stack: [], signal: null, resume: null, wakeAt: null, outcome: null, revision: 0, failure: null, leased: false, leaseExpiresAt: null })
  }

  signal(instanceId: string, name: string, id: string): void {
    const row = this.rows.get(instanceId)
    if (!row || this.receipts.some((receipt) => receipt.id === id) || isTerminalStatus(row.status)) return
    this.receipts.push({ id, instanceId, name, consumed: false })
    // A waiting instance consumes the oldest pending receipt of the awaited name (the new one, unless legacy state left an older one).
    const oldest = this.pending(instanceId, name)[0]!
    const woken = refApply(row, { t: "signal", name, id: oldest.id }, this.time)
    if ("ok" in woken) {
      oldest.consumed = true
      this.rows.set(instanceId, { ...row, ...woken.ok, leased: row.leased, leaseExpiresAt: row.leaseExpiresAt })
    }
  }

  /** Pending (unconsumed) receipts of an instance, optionally of one name, oldest first. */
  pending(instanceId: string, name?: string): ModelReceipt[] {
    return this.receipts.filter((receipt) => receipt.instanceId === instanceId && !receipt.consumed && (name === undefined || receipt.name === name))
  }

  cancel(instanceId: string): boolean {
    const row = this.rows.get(instanceId)
    if (!row || isTerminalStatus(row.status) || row.status === "compensating") return false
    const cancelled = refApply(row, { t: "cancel" }, this.time) as { ok: RefInstance }
    this.rows.set(instanceId, { ...row, ...cancelled.ok, leaseExpiresAt: null })
    return true
  }

  #constantSample: number | null = null
  #nextSample(): number { return this.#constantSample ?? this.samples[this.#sampleIndex++ % this.samples.length]! }

  /** The store's atomic claim: marks up to `limit` due rows as claimed at the current time and returns their claim-time snapshots. */
  claimBatch(limit: number): ModelRow[] {
    const now = this.time
    const due = [...this.rows.values()]
      .filter((row) => (row.status === "pending" || (row.status === "compensating" && (row.wakeAt === null || row.wakeAt <= now)) || (row.status === "waiting" && row.wakeAt !== null && row.wakeAt <= now)) && (row.leaseExpiresAt === null || row.leaseExpiresAt <= now))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .slice(0, limit)
    return due.map((row) => {
      const next: ModelRow = { ...row, vars: { ...row.vars }, stack: [...row.stack], status: row.status === "waiting" ? "pending" : row.status, leased: true, leaseExpiresAt: now + this.leaseMs, attempt: row.attempt + 1, revision: row.revision + 1 }
      this.rows.set(row.id, next)
      return next
    })
  }

  /**
   * Runs claims one after another (dispatcher concurrency 1), or all at once when `parallel` (concurrency >= claims): then every claim
   * starts at the batch start and the batch ends with the slowest one. Parallel batches use a constant jitter sample, because the order
   * in which concurrent retries are scheduled is not specified.
   */
  runBatch(claimed: readonly ModelRow[], parallel = false): ModelCounts {
    const counts: ModelCounts = { claimed: claimed.length, advanced: 0, compensated: 0, retried: 0, deferred: 0, stalled: 0, leaseLost: 0, failed: 0 }
    const batchStart = this.time
    let batchEnd = batchStart
    if (parallel) this.#constantSample = 0.5
    for (const snapshot of claimed) {
      if (parallel) this.time = batchStart
      const outcome = this.#runClaim(snapshot)
      batchEnd = Math.max(batchEnd, this.time)
      if (outcome === "lease-lost") counts.leaseLost++
      else counts[outcome === "advanced" ? "advanced" : outcome === "compensated" ? "compensated" : outcome === "retried" ? "retried" : outcome === "deferred" ? "deferred" : outcome === "stalled" ? "stalled" : "failed"]++
    }
    this.#constantSample = null
    if (parallel) this.time = batchEnd
    return counts
  }

  /** One dispatch round by a single worker. */
  dispatch(claimLimit: number, parallel = false): ModelCounts { return this.runBatch(this.claimBatch(claimLimit), parallel) }

  #runClaim(snapshot: ModelRow): ClaimOutcome {
    const LEASE_MS = this.leaseMs
    const STEP_TIMEOUT_MS = this.timeoutMs
    const id = snapshot.id
    let T = this.time
    const tStart = T
    const live = (): ModelRow => this.rows.get(id)!
    // The first fence check renews the lease.
    this.rows.set(id, { ...live(), leaseExpiresAt: Math.max(live().leaseExpiresAt ?? 0, T + LEASE_MS) })

    const holds = (): boolean => { const row = live(); return row.leased && row.revision === snapshot.revision && row.leaseExpiresAt !== null && row.leaseExpiresAt > T }
    const commit = (next: RefInstance & { version?: number }, outcome: ClaimOutcome): ClaimOutcome => {
      if (!holds()) return "lease-lost"
      const row = live()
      // A `wait` whose signal is already buffered consumes the oldest pending receipt of that name and is stored resumed.
      if (next.status === "waiting" && next.wakeAt === null && next.signal !== null) {
        const oldest = this.pending(id, next.signal)[0]
        if (oldest) {
          const resumed = refApply(next, { t: "buffered", id: oldest.id }, T) as { ok: RefInstance }
          oldest.consumed = true
          next = { ...resumed.ok, ...(next.version !== undefined ? { version: next.version } : {}) }
        }
      }
      this.rows.set(id, {
        ...row, version: next.version ?? snapshot.version, status: next.status, step: next.step, vars: next.vars, attempt: next.attempt, stack: next.stack, signal: next.signal, resume: next.resume,
        wakeAt: next.wakeAt, outcome: next.outcome, failure: next.failure, revision: row.revision + 1, leased: false, leaseExpiresAt: null,
      })
      return outcome
    }
    const finishWith = (outcome: ClaimOutcome): ClaimOutcome => { this.time = T; return outcome }

    const phase: "execute" | "compensate" = snapshot.status === "compensating" ? "compensate" : "execute"
    const stepName = phase === "compensate" ? snapshot.stack[snapshot.stack.length - 1] ?? "" : snapshot.step
    const attempt = Math.max(1, snapshot.attempt)
    let policy: RefPolicy = { maxAttempts: 3, initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 60_000, jitter: "equal" }

    type Msg = { kind: "text"; text: string } | { kind: "error"; text: string } | { kind: "other" } | { kind: "any" }
    const failOrRetry = (retryable: boolean, code: string, message: Msg): ClaimOutcome => {
      const at = T
      if (retryable && attempt >= 1 && attempt < policy.maxAttempts) {
        const sample = policy.jitter === "equal" ? this.#nextSample() : 0
        const applied = refApply(snapshot, { t: "retryAt", wakeAt: at + refBackoffDelay(policy, attempt, sample) }, at) as { ok: RefInstance }
        return commit(applied.ok, "retried")
      }
      const text = message.kind === "other" || message.kind === "any" ? null : message.text
      const finalCode = retryable ? "RETRY_EXHAUSTED" : code
      const finalMessage = retryable ? `${code}: ${text ?? "retry exhausted"}` : text ?? "Workflow step failed"
      const failure: RefFailure = { code: CODE_PATTERN.test(finalCode) ? finalCode : "STEP_ERROR", ...(message.kind === "any" ? {} : { message: finalMessage }), step: stepName, phase, attempt, at }
      const applied = refApply(snapshot, { t: "failStep", failure }, at) as { ok: RefInstance }
      return commit(applied.ok, "failed")
    }

    // --- decode
    const versions = this.spec.v2 ? [1, 2] : [1]
    const target = Math.max(...versions)
    if (snapshot.type !== "order" || snapshot.version > target) {
      return finishWith(this.#defer(snapshot, T, commit))
    }
    const decodedVars = snapshot.version < target ? { ...snapshot.vars, upgraded: true } : snapshot.vars
    if (target === 2 && decodedVars.poison === true) return finishWith(failOrRetry(false, "DECODE_FAILED", { kind: "error", text: "poisoned variables" }))
    const current: RefInstance & { version: number } = { ...snapshot, version: target, vars: decodedVars }

    // --- step lookup and budgets
    const v2 = target === 2 ? this.spec.v2! : null
    const defined = (STEP_NAMES as readonly string[]).includes(stepName) && !(v2?.missing.includes(stepName))
    const config = defined ? this.spec.steps[stepName]! : undefined
    const compensable = config !== undefined && config.hasCompensate && !(v2?.noCompensate.includes(stepName))
    if (config === undefined || (phase === "compensate" && !compensable)) {
      return finishWith(failOrRetry(false, "STEP_NOT_DEFINED", { kind: "text", text: `Workflow ${phase === "compensate" ? "compensation " : ""}step is not defined: ${stepName}` }))
    }
    policy = (phase === "compensate" ? config.compensationRetry : config.retry) ?? policy
    if (attempt > policy.maxAttempts) return finishWith(failOrRetry(false, "ATTEMPTS_EXHAUSTED", { kind: "text", text: `Attempt ${attempt} exceeds maxAttempts ${policy.maxAttempts}` }))
    const failure = snapshot.failure
    const stalledBefore = snapshot.status !== "compensating" && failure !== null && failure.code === "TIMEOUT" && failure.phase === "execute" && failure.step === snapshot.step && failure.attempt >= 1 && failure.attempt < snapshot.attempt
    if (phase === "execute" && config.idempotent !== true && stalledBefore) {
      return finishWith(failOrRetry(false, "TIMEOUT", { kind: "text", text: "Workflow step deadline exceeded" }))
    }
    let signalId: string | null = null
    if (phase === "execute" && snapshot.signal !== null) {
      // The step receives the receipt that resumed it; only instances without a recorded resume receipt fall back to the latest by name.
      const latest = snapshot.resume === null ? [...this.receipts].reverse().find((receipt) => receipt.instanceId === id && receipt.name === snapshot.signal) : undefined
      signalId = snapshot.resume ?? latest?.id ?? null
    }

    // --- invocation
    const key = `${id}/${stepName}/${phase}`
    const index = this.counters.get(key) ?? 0
    this.counters.set(key, index + 1)
    this.log.push({ id, step: stepName, phase, defVersion: target, attempt, signalId, vars: stableJson(decodedVars) })
    const script = phase === "execute" ? config.exec : config.comp
    const deadline = T + STEP_TIMEOUT_MS
    const play = (behavior: Behavior, at: number): Play => {
      switch (behavior.k) {
        case "coopAbort": return { kind: "hung", cooperative: "abort" }
        case "coopResolve": return { kind: "hung", cooperative: "resolve" }
        case "stall": return { kind: "hung", cooperative: "none" }
        case "throw": return { kind: "threw", error: behavior.err, at }
        case "slow": return at + behavior.ms > deadline ? { kind: "late", settleAt: at + behavior.ms, hangsAfter: ["stall", "coopAbort", "coopResolve"].includes(behavior.then.k) } : play(behavior.then, at + behavior.ms)
        case "cancelSelf": {
          this.cancel(id)
          return { kind: "settled", value: { k: "complete" }, at }
        }
        case "signalSelf": {
          this.signal(id, behavior.name, `self-${id}-${attempt}-${behavior.name}`)
          return play(behavior.then, at)
        }
        default: return { kind: "settled", value: behavior, at }
      }
    }
    const played = play(behaviorAt(script, index), T)
    const grace = this.spec.graceMs

    const handleTimeout = (settledAt: number | null): ClaimOutcome => {
      if (settledAt === null) {
        T = deadline + grace
        const failureRecord: RefFailure = { code: "TIMEOUT", message: "Workflow step deadline exceeded and the step ignored cancellation", step: stepName, phase, attempt, at: T }
        const applied = refApply(snapshot, { t: "stall", failure: failureRecord, wakeAt: T + LEASE_MS }, T) as { ok: RefInstance }
        return commit(applied.ok, "stalled")
      }
      T = settledAt
      return failOrRetry(config.idempotent === true || phase === "compensate", "TIMEOUT", { kind: "text", text: "Workflow step deadline exceeded" })
    }

    if (played.kind === "hung") {
      // Cooperative steps settle as soon as they are aborted; a step that ignores the abort never does.
      return finishWith(handleTimeout(played.cooperative !== "none" && grace > 0 ? deadline : null))
    }
    if (played.kind === "late") return finishWith(handleTimeout(grace > 0 && !played.hangsAfter && played.settleAt <= deadline + grace ? played.settleAt : null))
    T = played.at
    if (played.kind === "threw") {
      if (played.error === "leaseLost") return finishWith("lease-lost")
      const error = describeThrown(played.error)
      const retryable = phase === "compensate" || error.retryable
      return finishWith(failOrRetry(retryable, error.code ?? "STEP_ERROR", error.text === null ? { kind: "other" } : error.isError ? { kind: "error", text: error.text } : { kind: "text", text: error.text }))
    }
    // The step returned.
    if (phase === "compensate") {
      return finishWith(commit((refApply(snapshot, { t: "completeComp" }, T) as { ok: RefInstance }).ok, "compensated"))
    }
    const result = stepResultOf(played.value as Behavior, T)
    if (result === "invalid") return finishWith(failOrRetry(false, "INVALID_STEP_RESULT", { kind: "text", text: "Workflow step returned an invalid result" }))
    if (result === "malformed") return finishWith(failOrRetry(false, "INVALID_STEP_RESULT", { kind: "any" }))
    if (result === null) throw new Error(`model: unexpected settled behaviour ${(played.value as Behavior).k}`)
    if (result.kind === "retry") return finishWith(failOrRetry(true, "STEP_RETRY", { kind: "text", text: result.error }))
    if (result.kind === "fail") return finishWith(failOrRetry(false, "STEP_FAILED", { kind: "text", text: result.error }))
    const applied = refApply(current, { t: "step", result }, T)
    if ("err" in applied) throw new Error("model: unexpected rejection of a well-formed result")
    return finishWith(commit({ ...applied.ok, version: target }, "advanced"))
  }

  #defer(snapshot: ModelRow, at: number, commit: (next: RefInstance & { version?: number }, outcome: ClaimOutcome) => ClaimOutcome): ClaimOutcome {
    const handedBack: RefInstance = { ...snapshot, attempt: Math.max(0, snapshot.attempt - 1) }
    const applied = refApply(handedBack, { t: "retryAt", wakeAt: at + this.leaseMs }, at) as { ok: RefInstance }
    return commit(applied.ok, "deferred")
  }
}
