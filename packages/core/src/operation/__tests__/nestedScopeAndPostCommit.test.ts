import { afterEach, describe, expect, it } from "vitest"
import { runOperation } from "../operationPipeline"
import { createOperationContext } from "../operationContext"
import { createOperationInvoker } from "../operationInvoker"
import { OperationEffectCollector } from "../operationEffectCollector"
import { OperationContextInactiveError } from "../../domain/errors"
import type { OperationDefinition, StandardMutationOperationDefinition, StandardReadOperationDefinition } from "../operationDefinition"
import type { AtomicBatchProvider, InteractiveTransactionProvider, PersistenceProvider, UnversionedEntityDescriptor } from "../../persistence/provider"

const capabilities = { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: true, exactDecimal: true, persistentConnection: true }
const deferred = { deferredExecution: true, cache: false }
const noDeferred = { deferredExecution: false, cache: false }
const allow = { authorize: async () => ({ allowed: true }) }
const mutation = <I, R>(definition: StandardMutationOperationDefinition<I, R>) => definition
const read = <I, R>(definition: StandardReadOperationDefinition<I, R>) => definition
const entity: UnversionedEntityDescriptor<{ id: string }> = { name: "Row", primaryKey: "id", fields: { id: { type: "string" } } }

/** Transactions log BEGIN/COMMIT/ROLLBACK; writes (direct or via a repository) are buffered until commit. */
function recordingProvider() {
  const log: string[] = []
  const committed: string[] = []
  let next = 0
  const root: InteractiveTransactionProvider = {
    dialect: "test",
    capabilities: capabilities as InteractiveTransactionProvider["capabilities"],
    repository: (() => { throw new Error("root repository unused") }) as PersistenceProvider["repository"],
    runInTransaction: async (work) => {
      const id = ++next
      const pending: string[] = []
      log.push(`tx${id} begin`)
      const record = (value: string) => { pending.push(value); log.push(`tx${id} write ${value}`) }
      const scoped = {
        ...root,
        write: record,
        repository: () => ({ insert: async (row: { id: string }) => { record(row.id); return row } }),
      }
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

function child(log: string[]): OperationDefinition<string, string> {
  return mutation<string, string>({
    key: "child", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
    execute: ({ operation, input }) => { write(operation.persistence, `child:${input}`); return `child-${input}` },
    afterCommit: async () => { log.push("child afterCommit") },
  })
}

describe("joined child post-commit work without deferred execution", () => {
  it("returns the committed result and runs the child's afterCommit like a top-level afterCommit", async () => {
    const { root, log, committed } = recordingProvider()
    const result = await runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities: noDeferred }),
      definition: mutation({
        key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: ({ operation }) => operation.invoke(child(log), "a"),
        afterCommit: async () => { log.push("parent afterCommit") },
      }),
      input: {},
    })
    expect(result).toBe("child-a")
    expect(committed).toEqual(["child:a"])
    expect(log).toEqual(["tx1 begin", "tx1 write child:a", "tx1 commit", "parent afterCommit", "child afterCommit"])
  })
})

describe("joined siblings after the parent fails", () => {
  it("aborts a running sibling, waits for it, and fails its persistence closed before the rollback", async () => {
    const { root, log, committed } = recordingProvider()
    const outcomes: string[] = []
    const slow = mutation<null, string>({
      key: "slow", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
      execute: async ({ operation }) => {
        const repository = operation.persistence.repository(entity)
        await new Promise((resolve) => { operation.signal.addEventListener("abort", resolve, { once: true }) })
        outcomes.push(`aborted:${operation.signal.aborted}`)
        try { write(operation.persistence, "slow:direct") } catch (error) { outcomes.push(`direct:${(error as Error).name}`) }
        try { await repository.insert({ id: "slow:repository" }) } catch (error) { outcomes.push(`repository:${(error as Error).name}`) }
        log.push("slow settled")
        return "slow"
      },
    })
    const failing = mutation<null, string>({
      key: "failing", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
      execute: async () => { await Promise.resolve(); throw new Error("sibling failed") },
    })
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities: deferred }),
      definition: mutation({
        key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => Promise.all([operation.invoke(slow, null), operation.invoke(failing, null)]),
      }),
      input: {},
    })).rejects.toThrow("sibling failed")
    expect(outcomes).toEqual(["aborted:true", `direct:${OperationContextInactiveError.name}`, `repository:${OperationContextInactiveError.name}`])
    expect(log).toEqual(["tx1 begin", "slow settled", "tx1 rollback"])
    expect(committed).toEqual([])
  })

  it("fails a grandchild's persistence closed once the root parent fails", async () => {
    const { root, log, committed } = recordingProvider()
    const outcomes: string[] = []
    const grandchild = mutation<null, string>({
      key: "grandchild", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
      execute: async ({ operation }) => {
        await new Promise((resolve) => { operation.signal.addEventListener("abort", resolve, { once: true }) })
        try { write(operation.persistence, "grandchild") } catch (error) { outcomes.push((error as Error).name) }
        return "grandchild"
      },
    })
    const middle = mutation<null, string>({ key: "middle", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: ({ operation }) => operation.invoke(grandchild, null) })
    const failing = mutation<null, string>({ key: "failing", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async () => { await Promise.resolve(); throw new Error("sibling failed") } })
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities: deferred }),
      definition: mutation({ key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: async ({ operation }) => Promise.all([operation.invoke(middle, null), operation.invoke(failing, null)]) }),
      input: {},
    })).rejects.toThrow("sibling failed")
    expect(outcomes).toEqual([OperationContextInactiveError.name])
    expect(log).toEqual(["tx1 begin", "tx1 rollback"])
    expect(committed).toEqual([])
  })

  it("bounds the wait for a sibling that ignores cancellation by the run deadline", async () => {
    const { root, log } = recordingProvider()
    const hung = read<null, string>({ key: "hung", kind: "read", execute: () => new Promise<string>(() => undefined) })
    const failing = read<null, string>({ key: "failing", kind: "read", execute: async () => { await Promise.resolve(); throw new Error("sibling failed") } })
    const startedAt = Date.now()
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities: deferred, executionBudget: { maxNestingDepth: 4, maxDurationMs: 50 } }),
      definition: mutation({
        key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => Promise.all([operation.invoke(hung, null), operation.invoke(failing, null)]),
      }),
      input: {},
    })).rejects.toThrow("sibling failed")
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    expect(log).toEqual(["tx1 begin", "tx1 rollback"])
  })
})

describe("joined child infrastructure sinks", () => {
  it("hands adapter sink factories the raw transaction provider they registered", async () => {
    // Adapters resolve their database session from a WeakMap keyed by the
    // transaction-scoped provider object, so sinks must receive that object.
    const sessions = new WeakMap<object, string[]>()
    const { root, committed } = recordingProvider()
    const runInTransaction = root.runInTransaction.bind(root)
    root.runInTransaction = (work, options) => runInTransaction((scoped) => { sessions.set(scoped, []); return work(scoped) }, options)
    const session = (persistence: object): string[] => {
      const found = sessions.get(persistence)
      if (!found) throw new Error("No session found for this persistence provider")
      return found
    }
    const appended: string[] = []
    const audited: string[] = []
    const human = { id: "u1", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
    const request = { requestId: "r1", correlationId: "c1", identity: { actor: human, subject: human }, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" } as never
    const environment = {
      ...createOperationContext({
        persistence: root,
        runtimeCapabilities: deferred,
        outboxSinkFactory: { create: (persistence) => { session(persistence); return { append: async (record) => { appended.push(record.type) } } } },
        auditSinkFactory: { create: (persistence) => { session(persistence); return { write: async (record) => { audited.push(record.action) } } } },
      }),
      request,
    }
    const durableChild = mutation<string, string>({
      key: "durable-child", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
      audit: { action: "child.write", resourceType: "row", auditGuarantee: "atomic", resolveResourceId: () => "row-1" },
      execute: ({ operation, input }) => {
        write(operation.persistence, `child:${input}`)
        operation.addDurableEffect({ name: "notify", outbox: { type: "child.written", version: 1, tenantId: null, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never, aggregateType: "row", aggregateId: "row-1", payload: {}, idempotencyKey: "child-1" } })
        return `child-${input}`
      },
    })
    await expect(runOperation({
      operation: environment,
      definition: mutation({ key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: ({ operation }) => operation.invoke(durableChild, "a") }),
      input: {},
    })).resolves.toBe("child-a")
    expect(committed).toEqual(["child:a"])
    expect(appended).toEqual(["child.written"])
    expect(audited).toEqual(["child.write"])
  })
})

describe("deferred effect budget across the commit boundary", () => {
  const count = Math.floor(OperationEffectCollector.defaultMaxDeferredEffects * 0.6)

  it("runs every pre-commit best-effort effect of a committed transaction", async () => {
    const { root } = recordingProvider()
    let ran = 0
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities: deferred }),
      definition: mutation({
        key: "many-effects", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: ({ operation }) => { for (let index = 0; index < count; index += 1) operation.addBestEffortEffect(`e${index}`, async () => { ran += 1 }); return "ok" },
      }),
      input: {},
    })).resolves.toBe("ok")
    expect(ran).toBe(count)
  })

  it("runs every best-effort effect of a committed atomic batch", async () => {
    let ran = 0
    const provider: AtomicBatchProvider<string> = {
      dialect: "memory",
      capabilities: { ...capabilities, interactiveTransactions: false, atomicBatch: true } as AtomicBatchProvider<string>["capabilities"],
      repository: () => { throw new Error("unused") },
      executeAtomicBatch: async (plan) => plan.items.map((item) => ({ kind: item.kind, result: item.kind === "command" ? item.command : item })),
    }
    await expect(runOperation({
      operation: createOperationContext({ persistence: provider, runtimeCapabilities: deferred }),
      definition: {
        key: "many-atomic-effects", kind: "mutation", authorization: allow, atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => {
          for (let index = 0; index < count; index += 1) operation.addBestEffortEffect(`e${index}`, async () => { ran += 1 })
          return { commands: ["insert"], result: "ok" }
        },
      },
      input: {},
    })).resolves.toBe("ok")
    expect(ran).toBe(count)
  })

  it("never turns a committed operation into an error when post-commit registration exceeds the budget", async () => {
    const { root } = recordingProvider()
    const max = OperationEffectCollector.defaultMaxDeferredEffects
    await expect(runOperation({
      operation: createOperationContext({ persistence: root, runtimeCapabilities: deferred }),
      definition: mutation({
        key: "overflow", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: ({ operation }) => { for (let index = 0; index < max; index += 1) operation.addBestEffortEffect(`e${index}`, async () => undefined); return "ok" },
        afterCommit: async ({ operation }) => { operation.addBestEffortEffect("one-too-many", async () => undefined) },
      }),
      input: {},
    })).resolves.toBe("ok")
  })
})

describe("reusable operation environments", () => {
  it("gives every run its own default deadline instead of one fixed when the environment was created", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z")
    const { root } = recordingProvider()
    const environment = createOperationContext({ persistence: root, runtimeCapabilities: deferred, clock: { now: () => new Date(now) }, executionBudget: { maxNestingDepth: 4, maxDurationMs: 1_000 } })
    expect(environment.deadline).toBeUndefined()
    now += 5_000
    await expect(runOperation({ operation: environment, definition: read({ key: "later", kind: "read", execute: () => "ok" }), input: null })).resolves.toBe("ok")
  })
})

describe("explicit composition through createOperationInvoker", () => {
  const human = { id: "u1", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
  const request = { requestId: "r1", correlationId: "c1", identity: { actor: human, subject: human }, route: { routeKey: "POST /parent", operationKey: "parent", definitionVersion: 1 }, signal: new AbortController().signal } as never

  it("composes another operation from a route-bound environment while still authorizing it", async () => {
    const { root, committed, log } = recordingProvider()
    const environment = { ...createOperationContext({ persistence: root, runtimeCapabilities: deferred }), request }
    await expect(createOperationInvoker(environment).invoke(child(log), "composed")).resolves.toBe("child-composed")
    expect(committed).toEqual(["child:composed"])
    const denied = mutation<string, string>({ key: "denied", kind: "mutation", authorization: { authorize: async () => ({ allowed: false }) }, atomicity: { kind: "standard", mode: "required" }, execute: () => "never" })
    await expect(createOperationInvoker(environment).invoke(denied, "x")).rejects.toMatchObject({ code: "FORBIDDEN" })
    // Running another operation directly on the route-bound environment is still refused.
    await expect(runOperation({ operation: environment, definition: child(log), input: "direct" })).rejects.toThrow('bound to operation "parent"')
  })
})

describe("run context disposal without AbortSignal.any", () => {
  const originalAny = AbortSignal.any
  afterEach(() => { (AbortSignal as { any?: unknown }).any = originalAny })

  function countingSignal() {
    const controller = new AbortController()
    let listeners = 0
    const add = controller.signal.addEventListener.bind(controller.signal)
    const remove = controller.signal.removeEventListener.bind(controller.signal)
    const tracked = new Set<unknown>()
    controller.signal.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
      if (type === "abort" && !tracked.has(listener)) { tracked.add(listener); listeners += 1 }
      add(type, listener, options as AddEventListenerOptions)
    }) as AbortSignal["addEventListener"]
    controller.signal.removeEventListener = ((type: string, listener: EventListener, options?: unknown) => {
      if (type === "abort" && tracked.delete(listener)) listeners -= 1
      remove(type, listener, options as EventListenerOptions)
    }) as AbortSignal["removeEventListener"]
    return { signal: controller.signal, get listeners() { return listeners } }
  }

  it("returns long-lived signal listeners to baseline on every run path", async () => {
    (AbortSignal as { any?: unknown }).any = undefined
    const environmentSignal = countingSignal()
    const requestSignal = countingSignal()
    const human = { id: "u1", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
    const request = { requestId: "r1", correlationId: "c1", identity: { actor: human, subject: human }, signal: requestSignal.signal } as never
    const { root, log } = recordingProvider()
    const environment = { ...createOperationContext({ persistence: root, runtimeCapabilities: deferred, signal: environmentSignal.signal }), request }
    const baseline = () => [environmentSignal.listeners, requestSignal.listeners]

    // A run that fails a pre-start check.
    await expect(runOperation({ operation: environment, definition: read({ key: "needs-store", kind: "read", requiredRuntimeCapabilities: ["objectStore"], execute: () => "never" }), input: null })).rejects.toThrow()
    expect(baseline()).toEqual([0, 0])

    // A retryable-transaction run (outer and attempt contexts).
    await expect(runOperation({ operation: environment, definition: { key: "retryable", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 2, delay: 0, backoff: 2, maxDelay: 0 }, execute: async () => "ok" }, input: {} })).resolves.toBe("ok")
    expect(baseline()).toEqual([0, 0])

    // A joined child whose parent rolls back.
    await expect(runOperation({
      operation: environment,
      definition: mutation({
        key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => { await operation.invoke(child(log), "a"); throw new Error("parent failed") },
      }),
      input: {},
    })).rejects.toThrow("parent failed")
    expect(baseline()).toEqual([0, 0])

    // A committed parent with a joined child.
    await expect(runOperation({
      operation: environment,
      definition: mutation({ key: "parent", kind: "mutation", authorization: allow, atomicity: { kind: "standard", mode: "required" }, execute: ({ operation }) => operation.invoke(child(log), "b") }),
      input: {},
    })).resolves.toBe("child-b")
    expect(baseline()).toEqual([0, 0])
  })
})
