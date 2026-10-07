import { describe, expect, it, vi } from "vitest"
import { runOperation, runOperationDetailed } from "../operationPipeline"
import { createOperationContext } from "../operationContext"
import { createExecutionDeadline } from "../deadline"
import { RetryablePersistenceError, TransactionRolledBackError } from "../../domain/errors"
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
