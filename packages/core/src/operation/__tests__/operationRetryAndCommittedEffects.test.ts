import { describe, expect, it, vi } from "vitest"
import { runOperation, runOperationDetailed } from "../operationPipeline"
import { createOperationContext } from "../operationContext"
import { createExecutionDeadline } from "../deadline"
import { RetryablePersistenceError, TransactionRolledBackError, ValidationError } from "../../domain/errors"
import type { InteractiveTransactionProvider, PersistenceProvider } from "../../persistence/provider"
import type { CommittedEffectFailure } from "../committedEffectFailure"
import { MAX_RECORDED_EFFECT_FAILURES } from "../committedEffectFailure"

const capabilities = { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: true, exactDecimal: true, persistentConnection: true }
const runtimeCapabilities = { deferredExecution: true } as never

function provider(runInTransaction?: InteractiveTransactionProvider["runInTransaction"]): InteractiveTransactionProvider {
  const self: InteractiveTransactionProvider = {
    dialect: "test",
    capabilities: capabilities as InteractiveTransactionProvider["capabilities"],
    repository: (() => { throw new Error("unused") }) as PersistenceProvider["repository"],
    runInTransaction: runInTransaction ?? (async (work) => work(self)),
  }
  return self
}

const allow = { authorize: async () => ({ allowed: true }) }
const retrying = (maxAttempts: number, delay = 0) => ({ kind: "retryable-transaction" as const, maxAttempts, delay, backoff: 2, maxDelay: Math.max(delay, delay * 4) })

describe("transaction retry", () => {
  it("re-runs a transaction the provider reports as rolled back at COMMIT", async () => {
    let attempts = 0
    const tx = provider()
    tx.runInTransaction = async (work) => { attempts++; const result = await work(tx); if (attempts === 1) throw new TransactionRolledBackError("40001 at commit"); return result }
    await expect(runOperation({ operation: createOperationContext({ persistence: tx, runtimeCapabilities }), definition: { key: "commit-rollback", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execution: retrying(3), execute: async () => ({ ok: true }) }, input: {} })).resolves.toEqual({ ok: true })
    expect(attempts).toBe(2)
  })

  it("never re-runs after an unknown commit outcome", async () => {
    let attempts = 0
    const tx = provider()
    tx.runInTransaction = async (work) => { attempts++; await work(tx); throw new RetryablePersistenceError("connection lost during commit") }
    await expect(runOperation({ operation: createOperationContext({ persistence: tx, runtimeCapabilities }), definition: { key: "unknown-outcome", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execution: retrying(3), execute: async () => ({ ok: true }) }, input: {} })).rejects.toThrow("connection lost")
    expect(attempts).toBe(1)
  })

  it("stops waiting as soon as the operation is aborted and leaves no timer behind", async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      let attempts = 0
      const run = runOperation({
        operation: createOperationContext({ persistence: provider(), runtimeCapabilities, signal: controller.signal }),
        definition: { key: "abort-backoff", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execution: retrying(5, 10_000), execute: async () => { attempts++; throw new RetryablePersistenceError("busy") } },
        input: {},
      })
      const assertion = expect(run).rejects.toThrow("shutting down")
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      controller.abort(new Error("shutting down"))
      await assertion
      expect(attempts).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it("gives up with the last error instead of retrying past the execution deadline", async () => {
    let attempts = 0
    const now = new Date("2026-01-01T00:00:00.000Z")
    const run = runOperation({
      operation: createOperationContext({ persistence: provider(), runtimeCapabilities, clock: { now: () => now }, deadline: createExecutionDeadline(new Date(now.getTime() + 1_000)) }),
      definition: { key: "deadline-backoff", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execution: retrying(5, 60_000), execute: async () => { attempts++; throw new RetryablePersistenceError("busy") } },
      input: {},
    })
    await expect(run).rejects.toBeInstanceOf(RetryablePersistenceError)
    expect(attempts).toBe(1)
  })
})

describe("post-commit failure contract", () => {
  it("returns the committed result, reports every failure, and isolates a failing handler", async () => {
    const seen: CommittedEffectFailure[] = []
    const handler = vi.fn((failure: CommittedEffectFailure) => { seen.push(failure); throw new Error("pager down") })
    const outcome = await runOperationDetailed({
      operation: createOperationContext({ persistence: provider(), runtimeCapabilities, idGenerator: () => "op-1", onCommittedEffectFailure: handler }),
      definition: { key: "post-commit", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async () => ({ id: "r1" }), afterCommit: async () => { throw new Error("email failed") } },
      input: {},
      onBusinessResult: async () => { throw new Error("projection failed") },
    })
    expect(outcome).toMatchObject({ result: { id: "r1" }, committed: true })
    expect(outcome.postCommitEffectFailures?.map((failure) => failure.phase)).toEqual(["onBusinessResult", "afterCommit"])
    expect(seen.map((failure) => [failure.phase, failure.operationId, failure.errorType])).toEqual([["onBusinessResult", "op-1", "Error"], ["afterCommit", "op-1", "Error"]])
    expect(Object.isFrozen(seen[0])).toBe(true)
  })

  it("plain runOperation also resolves; an async handler rejection is contained", async () => {
    const handler = vi.fn(async () => { throw new Error("async pager down") })
    await expect(runOperation({
      operation: createOperationContext({ persistence: provider(), runtimeCapabilities, onCommittedEffectFailure: handler }),
      definition: { key: "post-commit-plain", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async () => "done", afterCommit: async () => { throw new Error("webhook failed") } },
      input: {},
    })).resolves.toBe("done")
    expect(handler).toHaveBeenCalledOnce()
  })

  it("bounds retained failure records while still notifying for each one", async () => {
    const handler = vi.fn()
    const outcome = await runOperationDetailed({
      operation: createOperationContext({ persistence: provider(), runtimeCapabilities, onCommittedEffectFailure: handler }),
      definition: { key: "many-failures", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async () => 1, afterCommit: Array.from({ length: MAX_RECORDED_EFFECT_FAILURES + 20 }, () => async () => { throw new Error("x") }) },
      input: {},
    })
    expect(outcome.postCommitEffectFailures).toHaveLength(MAX_RECORDED_EFFECT_FAILURES)
    expect(handler).toHaveBeenCalledTimes(MAX_RECORDED_EFFECT_FAILURES + 20)
  })
})

describe("transaction deadline propagation", () => {
  it("passes the remaining deadline to providers that enforce transaction timeouts", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z")
    const seen: unknown[] = []
    const tx = provider()
    ;(tx as { capabilities: object }).capabilities = { ...capabilities, transactionTimeouts: true }
    tx.runInTransaction = async (work, options) => { seen.push(options); return work(tx) }
    const environment = createOperationContext({ persistence: tx, runtimeCapabilities, clock: { now: () => now }, deadline: createExecutionDeadline(new Date(now.getTime() + 5_000)) })
    await runOperation({ operation: environment, definition: { key: "deadline-a", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required", transactionOptions: { isolationLevel: "serializable" } }, execute: async () => 1 }, input: {} })
    await runOperation({ operation: environment, definition: { key: "deadline-b", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required", transactionOptions: { timeoutMs: 250 } }, execute: async () => 1 }, input: {} })
    expect(seen).toEqual([{ isolationLevel: "serializable", timeoutMs: 5_000 }, { timeoutMs: 250 }])
  })

  it("leaves options untouched for providers without the capability and validates timeoutMs", async () => {
    const seen: unknown[] = []
    const tx = provider()
    tx.runInTransaction = async (work, options) => { seen.push(options); return work(tx) }
    await runOperation({ operation: createOperationContext({ persistence: tx, runtimeCapabilities }), definition: { key: "plain", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async () => 1 }, input: {} })
    expect(seen).toEqual([undefined])
    await expect(runOperation({ operation: createOperationContext({ persistence: tx, runtimeCapabilities }), definition: { key: "bad", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required", transactionOptions: { timeoutMs: 0 } }, execute: async () => 1 }, input: {} })).rejects.toThrow("timeoutMs")
  })
})

describe("operation.completed telemetry", () => {
  it("emits one event per run with outcome, duration, and error code", async () => {
    let now = 1_000
    const events: { name: string; attributes: Record<string, unknown> }[] = []
    const environment = createOperationContext({ persistence: provider(), runtimeCapabilities, clock: { now: () => new Date(now) }, idGenerator: () => "op", telemetry: { emit: (event) => { events.push(event as never) } } })
    await runOperation({ operation: environment, definition: { key: "ok", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async () => { now += 42; return 1 } }, input: {} })
    await expect(runOperation({ operation: environment, definition: { key: "bad", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async () => { throw new ValidationError("nope") } }, input: {} })).rejects.toThrow("nope")
    await runOperation({ operation: environment, definition: { key: "warn", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async () => 1, afterCommit: async () => { throw new Error("x") } }, input: {} })
    const completed = events.filter((event) => event.name === "operation.completed").map((event) => event.attributes)
    expect(completed).toEqual([
      expect.objectContaining({ operationKey: "ok", outcome: "success", durationMs: 42, operationKind: "mutation" }),
      expect.objectContaining({ operationKey: "bad", outcome: "error", errorCode: "VALIDATION_ERROR" }),
      expect.objectContaining({ operationKey: "warn", outcome: "committed_with_effect_failures" }),
    ])
  })

  it("never lets a failing telemetry sink or clock change the result", async () => {
    const environment = createOperationContext({ persistence: provider(), runtimeCapabilities, telemetry: { emit: () => { throw new Error("sink down") } } })
    await expect(runOperation({ operation: environment, definition: { key: "ok", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async () => "fine" }, input: {} })).resolves.toBe("fine")
  })
})
