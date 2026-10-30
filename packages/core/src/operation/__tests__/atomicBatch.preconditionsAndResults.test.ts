import { describe, expect, it, vi } from "vitest"
import { runOperation, runOperationDetailed } from "../operationPipeline"
import { createOperationContext } from "../operationContext"
import { OperationCommittedEffectError } from "../atomicBatchOperationPipeline"
import { ConfigurationError, createAnonymousPrincipal, encodeExecutionScopeId, type Principal, type RequestContext } from "../../domain"
import type { AtomicBatchPlan, PersistenceProvider } from "../../persistence/provider"
import type { RuntimeCapabilities } from "../../bootstrap/runtimeCapabilities"
import { createAuthorizedExecutionPlan } from "../../security"

const baseCapabilities = {
  interactiveTransactions: false, atomicBatch: true, returningInsert: false, readSessions: false,
  jsonQueries: false, exactDecimal: false, persistentConnection: false,
  maxPageSize: 100, maxBindParams: 100, maxStatementBytes: 100_000,
}
const runtimeCapabilities: RuntimeCapabilities = { deferredExecution: true, cache: true }
const allow = { authorize: async () => ({ allowed: true }) }
const fixedNow = new Date("2026-09-10T00:00:00.000Z")

function batchProvider(executeAtomicBatch?: (plan: AtomicBatchPlan<unknown>) => Promise<unknown[]>) {
  const plans: AtomicBatchPlan<unknown>[] = []
  const provider = {
    dialect: "memory",
    capabilities: baseCapabilities as PersistenceProvider["capabilities"],
    repository: () => { throw new Error("not used") },
    executeAtomicBatch: async (plan: AtomicBatchPlan<unknown>) => {
      plans.push(plan)
      if (executeAtomicBatch) return (await executeAtomicBatch(plan)) as never
      return plan.items.map((item) => ({ kind: item.kind, result: item.kind === "command" ? item.command : item }))
    },
  } as unknown as PersistenceProvider
  return { provider, plans }
}

function requestContext(actorId = "user-1", tenantId?: string): RequestContext {
  const actor: Principal = actorId
    ? { id: actorId, kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
    : createAnonymousPrincipal()
  const scope = tenantId ? { kind: "tenant", tenantId } as const : { kind: "application", applicationKey: "operation-tests" } as const
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    identity: { actor, subject: actor },
    scope,
    scopeId: encodeExecutionScopeId(scope),
    authority: {
      identity: { actor, subject: actor },
      correlationId: "correlation-1",
      grant: {
        grantId: "test:correlation-1",
        source: { kind: "route", routeKey: "atomic-test" },
        target: { scope, scopeId: encodeExecutionScopeId(scope) },
        purpose: "operation-test",
        reason: "test fixture",
        issuedAt: "2026-09-10T00:00:00.000Z",
        policy: { policyKey: "operation-test", policyVersion: 1, policyDigest: "test", evaluatedAt: "2026-09-10T00:00:00.000Z", authorizationModel: "snapshot" },
        delegationChain: [],
        impersonation: { kind: "none" },
      },
    },
    route: { routeKey: "atomic-test", definitionVersion: 1, operationKey: "ab" },
    signal: new AbortController().signal,
  } as never
}

function environment(overrides: Record<string, unknown> = {}, persistence?: PersistenceProvider) {
  return createOperationContext({
    persistence: persistence ?? batchProvider().provider,
    runtimeCapabilities,
    request: requestContext("user-1"),
    clock: { now: () => fixedNow },
    idGenerator: () => "id-1",
    ...overrides,
  } as never)
}

const applicationScope = { kind: "application", applicationKey: "operation-tests" } as const

function outbox(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: applicationScope, scopeId: encodeExecutionScopeId(applicationScope), tenantId: null,
    aggregateType: "order", aggregateId: "o-1", payload: {}, idempotencyKey: "k-1",
    ...extra,
  }
}

function batch(extra: Record<string, unknown> = {}): never {
  return {
    key: "ab",
    kind: "mutation",
    authorization: allow,
    atomicity: { kind: "atomic-batch" },
    prepare: () => ({ commands: ["c1"], result: { ok: true } }),
    ...extra,
  } as never
}

describe("atomic-batch preconditions", () => {
  it("requires atomic-batch persistence support", async () => {
    const plain = { dialect: "memory", capabilities: { ...baseCapabilities, atomicBatch: false }, repository: () => { throw new Error("unused") } } as unknown as PersistenceProvider
    await expect(runOperation({ operation: environment({}, plain), definition: batch(), input: {} })).rejects.toThrow(
      new ConfigurationError("Operation ab requires atomic-batch persistence support."),
    )
  })

  it("treats a tenant-scoped capability without its contract as unsupported persistence", async () => {
    const { provider } = batchProvider()
    const scoped = { ...provider, capabilities: { ...baseCapabilities, atomicBatchScope: "tenant-scoped" } } as unknown as PersistenceProvider
    await expect(runOperation({ operation: environment({}, scoped), definition: batch(), input: {} })).rejects.toThrow(
      "Operation ab requires atomic-batch persistence support.",
    )
  })

  it("binds tenant-scoped batches to the request tenant", async () => {
    const plans: unknown[] = []
    const tenantProvider = {
      dialect: "memory",
      capabilities: { ...baseCapabilities, atomicBatchScope: "tenant-scoped" },
      tenantId: "tenant-1",
      commandEncoder: { encode: (command: unknown) => command },
      repository: () => { throw new Error("not used") },
      executeAtomicBatch: async (plan: { items: Array<{ kind: string; command?: unknown }> }) => {
        plans.push(plan)
        return plan.items.map((item) => ({ kind: item.kind, result: item.command }))
      },
    } as unknown as PersistenceProvider
    await expect(runOperation({
      operation: environment({ request: requestContext("user-1", "tenant-2") }, tenantProvider),
      definition: batch(),
      input: {},
    })).rejects.toThrow("Operation ab tenant does not match the persistence provider.")
    expect(plans).toHaveLength(0)
    await expect(runOperation({
      operation: environment({ request: requestContext("user-1", "tenant-1") }, tenantProvider),
      definition: batch(),
      input: {},
    })).resolves.toEqual({ ok: true })
    expect(plans).toHaveLength(1)
  })

  it("rejects mutation authorization plans, which cannot be executed without a command plan", async () => {
    const mutationPlan = createAuthorizedExecutionPlan({
      identity: { actor: { id: "user-1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }, subject: { id: "user-1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } } },
      scope: { kind: "application", applicationKey: "operation-tests" }, action: "records.write", operationKind: "mutation",
      readableFields: new Set(["id"]), writableFields: new Set(["status"]), obligations: [], dynamicFacts: [],
      policy: { key: "policy", version: 1, digest: "a".repeat(64) },
    } as never)
    const { provider, plans } = batchProvider()
    await expect(runOperation({
      operation: environment({}, provider),
      definition: batch({ authorization: { authorize: async () => ({ allowed: true, plan: mutationPlan }) } }),
      input: {},
    })).rejects.toThrow("Atomic-batch operation ab cannot execute a mutation authorization plan without an adapter-bound command plan.")
    expect(plans).toHaveLength(0)
  })

  it("rejects malformed prepared batches", async () => {
    const attempt = (prepare: () => unknown) => runOperation({ operation: environment(), definition: batch({ prepare }), input: {} })
    await expect(attempt(() => null)).rejects.toThrow("Atomic operation ab prepare must return a prepared batch.")
    await expect(attempt(() => ({ commands: "c1", result: 1 }))).rejects.toThrow("Atomic operation ab prepare must return commands and a result.")
    await expect(attempt(() => ({ commands: [] }))).rejects.toThrow("Atomic operation ab prepare must return commands and a result.")
    await expect(attempt(() => ({ commands: [], result: 1, verify: 5 }))).rejects.toThrow(
      "Atomic operation ab prepare.verify must be a function when provided.",
    )
  })

  it("runs before hooks and passes the adjusted input to prepare", async () => {
    const prepare = vi.fn(({ input }: { input: { value: number } }) => ({ commands: [], result: { value: input.value } }))
    const detailed = await runOperation({
      operation: environment(),
      definition: batch({ before: ({ input }: { input: { value: number } }) => ({ value: input.value + 1 }), prepare }),
      input: { value: 1 },
    })
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ input: { value: 2 } }))
    expect(detailed).toEqual({ value: 2 })
  })
})

describe("atomic-batch items", () => {
  it("builds a transactional audit item from pre-commit values", async () => {
    const { provider, plans } = batchProvider()
    await runOperation({
      operation: environment({ request: requestContext("user-1", "tenant-1") }, provider),
      definition: batch({
        audit: {
          action: "records.update", resourceType: "record",
          resolveResourceId: ({ result }: { result: { ok: boolean } }) => `res-${String(result.ok)}`,
          extractOldValue: ({ input }: { input: { id: string } }) => ({ previous: input.id }),
          extractNewValue: ({ result }: { result: { ok: boolean } }) => ({ current: result.ok }),
        },
      }),
      input: { id: "old" },
    })
    const audit = plans[0]!.items.find((item) => item.kind === "audit") as unknown as { kind: string; record: Record<string, unknown> }
    expect(audit.record).toEqual({
      id: "id-1",
      occurredAt: fixedNow,
      actor: expect.objectContaining({ id: "user-1" }),
      action: "records.update",
      resourceType: "record",
      resourceId: "res-true",
      tenantId: "tenant-1",
      oldValue: { previous: "old" },
      newValue: { current: true },
    })
  })

  it("records null extracts and a null tenant for application scope", async () => {
    const { provider, plans } = batchProvider()
    await runOperation({
      operation: environment({}, provider),
      definition: batch({ audit: { action: "records.plain", resourceType: "record", resolveResourceId: () => "r" } }),
      input: {},
    })
    expect(plans[0]!.items.find((item) => item.kind === "audit")).toEqual({
      kind: "audit",
      record: expect.objectContaining({ tenantId: null, oldValue: null, newValue: null }),
    })
  })

  it("uses the configured audit sanitizer", async () => {
    const { provider, plans } = batchProvider()
    await runOperation({
      operation: environment({ auditSanitizer: (value: Record<string, unknown>) => ({ ...value, sanitized: true }) }, provider),
      definition: batch({ audit: { action: "records.sanitized", resourceType: "record", resolveResourceId: () => "r", extractNewValue: () => ({ name: "n" }) } }),
      input: {},
    })
    expect(plans[0]!.items.find((item) => item.kind === "audit")).toMatchObject({ record: { newValue: { name: "n", sanitized: true } } })
  })

  it("adds outbox records with defaulted identity and time", async () => {
    const { provider, plans } = batchProvider()
    await runOperation({
      operation: environment({}, provider),
      definition: batch({
        prepare: ({ operation }: { operation: { addOutboxRecord: (record: Record<string, unknown>) => void } }) => {
          operation.addOutboxRecord(outbox({ type: "orders.created", version: 1 }))
          return { commands: [], result: { ok: true } }
        },
      }),
      input: {},
    })
    expect(plans[0]!.items).toContainEqual({
      kind: "outbox",
      record: expect.objectContaining({ type: "orders.created", id: "id-1", occurredAt: fixedNow }),
    })
  })

  it("fences commit markers before the batch and appends their batch items", async () => {
    const order: string[] = []
    const { provider, plans } = batchProvider(async (plan) => {
      order.push("execute")
      return plan.items.map((item) => ({ kind: item.kind, result: item.kind === "command" ? item.command : item }))
    })
    const fence = vi.fn(async () => { order.push("fence") })
    const batchItem = vi.fn(async () => ({ kind: "idempotency", key: "k1" }))
    const silent = vi.fn(async () => undefined)
    await runOperation({
      operation: environment({ commitMarkers: [{ name: "lease", fence, batchItem }, { name: "silent", batchItem: silent }] }, provider),
      definition: batch({ prepare: () => ({ commands: ["c1"], result: { value: 7 } }) }),
      input: {},
    })
    expect(order).toEqual(["fence", "execute"])
    expect(fence).toHaveBeenCalledWith(provider)
    expect(batchItem).toHaveBeenCalledWith({ value: 7 })
    expect(silent).toHaveBeenCalledWith({ value: 7 })
    expect(plans[0]!.items).toEqual([
      { kind: "command", command: "c1" },
      { kind: "idempotency", key: "k1" },
    ])
  })
})

describe("atomic-batch result verification", () => {
  async function failingBatch(results: unknown[]) {
    const { provider } = batchProvider(async () => results)
    return runOperation({ operation: environment({}, provider), definition: batch(), input: {} })
  }

  it("wraps incomplete or malformed provider results as committed effect errors", async () => {
    const wrongLength = await failingBatch([]).catch((error: unknown) => error)
    expect(wrongLength).toBeInstanceOf(OperationCommittedEffectError)
    expect(wrongLength).toMatchObject({ committed: true, message: "Operation ab committed, but the persistence provider returned incomplete or malformed batch results." })
    expect((wrongLength as { cause: Error }).cause.message).toBe("Expected 1 results for 1 atomic batch items.")

    const wrongKind = await failingBatch([{ kind: "audit", result: "c" }]).catch((error: unknown) => error)
    expect((wrongKind as { cause: Error }).cause.message).toBe("Atomic batch result at index 0 does not match the submitted command item.")

    const missingResult = await failingBatch([{ kind: "command" }]).catch((error: unknown) => error)
    expect((missingResult as { cause: Error }).cause.message).toBe("Atomic batch result at index 0 does not match the submitted command item.")

    const nullResult = await failingBatch([null]).catch((error: unknown) => error)
    expect((nullResult as { cause: Error }).cause.message).toBe("Atomic batch result at index 0 does not match the submitted command item.")

    const unknownKind = await failingBatch([{ kind: "bogus", result: 1 }]).catch((error: unknown) => error)
    expect((unknownKind as { cause: Error }).cause.message).toBe("Atomic batch result at index 0 does not match the submitted command item.")
  })

  it("accepts every declared result kind and reports only command results to verification", async () => {
    const verify = vi.fn()
    const { provider } = batchProvider(async (plan) => plan.items.map((item) => ({ kind: item.kind, result: `r-${item.kind}` })))
    await runOperation({
      operation: environment({ outboxSinkFactory: { create: () => ({ append: async () => undefined }) } }, provider),
      definition: batch({
        audit: { action: "records.verify", resourceType: "record", resolveResourceId: () => "r" },
        prepare: ({ operation }: { operation: { addOutboxRecord: (record: Record<string, unknown>) => void } }) => {
          operation.addOutboxRecord(outbox({ type: "event", version: 1 }))
          return { commands: ["c1", "c2"], result: { ok: true }, verify }
        },
      }),
      input: {},
    })
    expect(verify).toHaveBeenCalledWith({ result: { ok: true }, commandResults: ["r-command", "r-command"] })
  })

  it("wraps verification failures as committed effect errors", async () => {
    const error = await runOperation({
      operation: environment(),
      definition: batch({ prepare: () => ({ commands: [], result: {}, verify: () => { throw new Error("mismatch") } }) }),
      input: {},
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OperationCommittedEffectError)
    expect(error).toMatchObject({ message: "Operation ab committed, but result verification failed." })
    expect((error as { cause: Error }).cause.message).toBe("mismatch")
  })
})

describe("atomic-batch post-commit", () => {
  it("returns the after-hook representation and reports after-hook failures as committed", async () => {
    const enriched = await runOperation({
      operation: environment(),
      definition: batch({ after: ({ result }: { result: { ok: boolean } }) => ({ ...result, enriched: true }) }),
      input: {},
    })
    expect(enriched).toEqual({ ok: true, enriched: true })

    const failures: string[] = []
    const error = await runOperation({
      operation: environment({ onCommittedEffectFailure: (failure: { phase: string; effectName: string }) => { failures.push(`${failure.phase}:${failure.effectName}`) } }),
      definition: batch({ after: () => { throw new Error("representation failed") } }),
      input: {},
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OperationCommittedEffectError)
    expect(error).toMatchObject({ message: "Operation ab committed, but a post-commit hook failed.", result: { ok: true } })
    expect(failures).toEqual(["after:hooks"])
  })

  it("runs after-commit hooks, business callbacks, and best-effort effects once the batch has committed", async () => {
    const calls: string[] = []
    const { provider } = batchProvider(async (plan) => {
      calls.push("commit")
      return plan.items.map((item) => ({ kind: item.kind, result: item.kind === "command" ? item.command : item }))
    })
    const failures: string[] = []
    const detailed = await runOperationDetailed({
      operation: environment({ onCommittedEffectFailure: (failure: { phase: string; effectName: string }) => { failures.push(`${failure.phase}:${failure.effectName}`) } }, provider),
      definition: batch({
        afterCommit: [
          () => { calls.push("after-1") },
          () => { throw new Error("after failed") },
        ],
        prepare: ({ operation }: { operation: { addBestEffortEffect: (name: string, execute: () => Promise<void>) => void } }) => {
          operation.addBestEffortEffect("notify", async () => { calls.push("best-effort") })
          return { commands: [], result: { ok: true } }
        },
      }),
      input: {},
      onBusinessResult: async () => { calls.push("business") },
    } as never)
    expect(detailed.result).toEqual({ ok: true })
    expect(calls).toEqual(["commit", "business", "after-1", "best-effort"])
    expect(failures).toEqual(["afterCommit:hooks"])
  })

  it("reports business-callback and best-effort failures without failing the committed batch", async () => {
    const failures: string[] = []
    const result = await runOperation({
      operation: environment({ onCommittedEffectFailure: (failure: { phase: string; effectName: string }) => { failures.push(`${failure.phase}:${failure.effectName}`) } }),
      definition: batch({
        prepare: ({ operation }: { operation: { addBestEffortEffect: (name: string, execute: () => Promise<void>) => void } }) => {
          operation.addBestEffortEffect("flaky", async () => { throw new Error("effect failed") })
          return { commands: [], result: { ok: true } }
        },
      }),
      input: {},
      onBusinessResult: async () => { throw new Error("callback failed") },
    } as never)
    expect(result).toEqual({ ok: true })
    expect(failures).toEqual(expect.arrayContaining(["onBusinessResult:business-result", "bestEffort:flaky"]))
  })
})
