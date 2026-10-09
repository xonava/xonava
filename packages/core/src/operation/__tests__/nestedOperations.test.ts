import { describe, expect, it } from "vitest"
import { runOperation, runOperationDetailed } from "../operationPipeline"
import { createOperationContext } from "../operationContext"
import { createOperationInvoker } from "../operationInvoker"
import type { OperationDefinition, StandardMutationOperationDefinition, StandardReadOperationDefinition } from "../operationDefinition"
import type { InteractiveTransactionProvider, PersistenceProvider } from "../../persistence/provider"

const capabilities = { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: true, exactDecimal: true, persistentConnection: true }
const runtimeCapabilities = { deferredExecution: true } as never
const allow = { authorize: async () => ({ allowed: true }) }
const mutation = <I, R>(definition: StandardMutationOperationDefinition<I, R>) => definition
const read = <I, R>(definition: StandardReadOperationDefinition<I, R>) => definition

/** A provider whose transactions log BEGIN/COMMIT/ROLLBACK and whose writes are buffered until commit. */
function recordingProvider() {
  const log: string[] = []
  const committed: string[] = []
  let next = 0
  const root: InteractiveTransactionProvider & { write?: (value: string) => void } = {
    dialect: "test",
    capabilities: capabilities as InteractiveTransactionProvider["capabilities"],
    repository: (() => { throw new Error("unused") }) as PersistenceProvider["repository"],
    runInTransaction: async (work) => {
      const id = ++next
      const pending: string[] = []
      log.push(`tx${id} begin`)
      const scoped = { ...root, write: (value: string) => { pending.push(value); log.push(`tx${id} write ${value}`) } }
      try {
        const result = await work(scoped as never)
        committed.push(...pending)
        log.push(`tx${id} commit`)
        return result
      } catch (error) {
        log.push(`tx${id} rollback`)
        throw error
      }
    },
  }
  return { root, log, committed }
}

const write = (persistence: unknown, value: string) => (persistence as { write(value: string): void }).write(value)

function child(log: string[], options: { fail?: boolean } = {}): OperationDefinition<string, string> {
  return mutation<string, string>({
    key: "child", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
    execute: ({ operation, input }) => {
      write(operation.persistence, `child:${input}`)
      if (options.fail) throw new Error("child failed")
      return `child-${input}`
    },
    afterCommit: async () => { log.push("child afterCommit") },
  })
}

describe("nested operations join the parent transaction", () => {
  it("commits child writes with the parent and runs child post-commit work after the parent commits", async () => {
    const { root, log, committed } = recordingProvider()
    const result = await runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities }),
      definition: mutation({
        key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          write(operation.persistence, "parent")
          return operation.invoke(child(log), "a")
        },
      }),
      input: {},
    })
    expect(result).toBe("child-a")
    expect(log).toEqual(["tx1 begin", "tx1 write parent", "tx1 write child:a", "tx1 commit", "child afterCommit"])
    expect(committed).toEqual(["parent", "child:a"])
  })

  it("discards child writes and post-commit work when the parent rolls back", async () => {
    const { root, log, committed } = recordingProvider()
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities }),
      definition: mutation({
        key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          await operation.invoke(child(log), "a")
          throw new Error("parent failed")
        },
      }),
      input: {},
    })).rejects.toThrow("parent failed")
    expect(log).toEqual(["tx1 begin", "tx1 write child:a", "tx1 rollback"])
    expect(committed).toEqual([])
  })

  it("refuses to commit a parent that swallowed a failed child", async () => {
    const { root, log, committed } = recordingProvider()
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities }),
      definition: mutation({
        key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          await operation.invoke(child(log, { fail: true }), "a").catch(() => undefined)
          return "ignored"
        },
      }),
      input: {},
    })).rejects.toThrow("after a nested operation failed")
    expect(log.at(-1)).toBe("tx1 rollback")
    expect(committed).toEqual([])
  })

  it("refuses to commit while a child is still running", async () => {
    const { root } = recordingProvider()
    // The parent cancels the still-running child and waits for it before its
    // transaction ends, so the child must observe its signal to settle.
    let aborted = false
    const slow = read<null, string>({ key: "slow", kind: "read", execute: ({ operation }) => new Promise<string>((resolve) => { operation.signal.addEventListener("abort", () => { aborted = true; resolve("late") }, { once: true }) }) })
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities }),
      definition: mutation({
        key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: ({ operation }) => { void operation.invoke(slow, null).catch(() => undefined); return "early" },
      }),
      input: {},
    })).rejects.toThrow("before its nested operations completed")
    expect(aborted).toBe(true)
  })

  it("enforces the nesting-depth budget through execute contexts", async () => {
    const { root } = recordingProvider()
    const recursive: StandardReadOperationDefinition<null, string> = read<null, string>({
      key: "recursive", kind: "read",
      execute: ({ operation }) => operation.invoke(recursive, null),
    })
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities, executionBudget: { maxNestingDepth: 3, maxDurationMs: 10_000 } }),
      definition: recursive,
      input: null,
    })).rejects.toThrow("nesting depth exceeds 3")
  })

  it("lets read operations invoke only read operations", async () => {
    const { root, log } = recordingProvider()
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities }),
      definition: read({ key: "reader", kind: "read", execute: ({ operation }) => operation.invoke(child(log), "a") }),
      input: null,
    })).rejects.toThrow("Read operation cannot invoke mutation")
  })

  it("rejects children that manage their own transaction or use atomic batches", async () => {
    const { root } = recordingProvider()
    const retrying: OperationDefinition<null, string> = { key: "retrying", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 2, delay: 0, backoff: 2, maxDelay: 0 }, execute: () => "x" }
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities }),
      definition: mutation({ key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: ({ operation }) => operation.invoke(retrying, null) }),
      input: {},
    })).rejects.toThrow("cannot run inside another transaction")
  })

  it("reports a child's post-commit failures on the parent outcome", async () => {
    const { root } = recordingProvider()
    const failing: OperationDefinition<null, string> = { key: "failing-hook", kind: "read", execute: () => "x", afterCommit: async () => { throw new Error("hook boom") } }
    const outcome = await runOperationDetailed({
      operation: createOperationContext({ persistence: root, runtimeCapabilities }),
      definition: mutation({ key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: ({ operation }) => operation.invoke(failing, null) }),
      input: {},
    })
    expect(outcome.result).toBe("x")
    expect(outcome.postCommitEffectFailures?.map((failure) => failure.message)).toEqual(["Error: hook boom"])
  })

  it("keeps the standalone invoker for top-level composition", async () => {
    const { root, log, committed } = recordingProvider()
    await expect(createOperationInvoker(createOperationContext({ persistence: root, runtimeCapabilities })).invoke(child(log), "solo")).resolves.toBe("child-solo")
    expect(committed).toEqual(["child:solo"])
  })

  it("works inside a routed request whose route is bound to the parent", async () => {
    const { root, committed, log } = recordingProvider()
    const human = { id: "u1", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
    const request = { requestId: "r1", correlationId: "c1", identity: { actor: human, subject: human }, route: { routeKey: "POST /parent", operationKey: "parent", definitionVersion: 1 }, signal: new AbortController().signal } as never
    await expect(runOperation({
      operation: { ...createOperationContext({ persistence: root, runtimeCapabilities }), request },
      definition: mutation({ key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: ({ operation }) => operation.invoke(child(log), "routed") }),
      input: {},
    })).resolves.toBe("child-routed")
    expect(committed).toEqual(["child:routed"])
    // The root operation is still bound to its route.
    await expect(runOperation({
      operation: { ...createOperationContext({ persistence: root, runtimeCapabilities }), request },
      definition: child(log),
      input: "direct",
    })).rejects.toThrow('bound to operation "parent"')
  })
})
