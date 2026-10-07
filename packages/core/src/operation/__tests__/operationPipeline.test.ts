/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, vi } from "vitest"
import { createOperationContext, createOperationRunContext } from "../operationContext"
import { runOperation as frameworkRunOperation, runOperationDetailed as frameworkRunOperationDetailed } from "../operationPipeline"
import type { PersistenceProvider, InteractiveTransactionProvider, AtomicBatchItem, AtomicBatchPlan, AtomicBatchProvider, AtomicBatchResult, TenantScopedAtomicBatchProvider } from "../../persistence"
import { createTenantScopedPersistenceProvider } from "../../persistence"
import type { AuditSink } from "../../events"
import type { RuntimeCapabilities } from "../../bootstrap/runtimeCapabilities"
import { ConfigurationError, ConflictError, AuditSinkMissingError, AuditActorMissingError, RuntimeCapabilityError, RetryablePersistenceError, createAnonymousPrincipal, encodeExecutionScopeId, type Principal, type RequestContext } from "../../domain"
import { OperationCommittedEffectError } from "../atomicBatchOperationPipeline"
import type { AtomicAfterCommitHook, AfterCommitHook } from "../hooks"
import type { MutationOperationContext, OperationEnvironment, PostCommitContext, ReadOperationContext } from "../operationContext"
import type { InternalOperationRunContext } from "../operationRunContext"
import type { AtomicBatchPreparationContext, OperationAuditConfig, OperationDefinition } from "../operationDefinition"

function createNoTxProvider(): PersistenceProvider {
  return {
    dialect: "memory",
    capabilities: {
      interactiveTransactions: false,
      atomicBatch: false,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
      maxPageSize: 100,
      maxBindParams: 100,
      maxStatementBytes: 100_000,
    },
    repository: () => { throw new Error("not used") },
   }
 }

function createTxProvider(): InteractiveTransactionProvider {
  return {
    dialect: "memory",
    capabilities: {
      interactiveTransactions: true,
      atomicBatch: false,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
      maxPageSize: 100,
      maxBindParams: 100,
      maxStatementBytes: 100_000,
    },
    repository: () => { throw new Error("not used") },
    async runInTransaction(fn) {
      return fn(this)
    },
  }
}

function createOptionsRecordingTxProvider(): { provider: InteractiveTransactionProvider; getOptions: () => import("../../persistence").TransactionOptions | undefined } {
  let options: import("../../persistence").TransactionOptions | undefined
  const provider = createTxProvider()
  provider.runInTransaction = async (fn, transactionOptions) => {
    options = transactionOptions
    return fn(provider)
  }
  return { provider, getOptions: () => options }
}

function createAtomicProvider(onPlan: (items: readonly AtomicBatchItem<string>[]) => void): AtomicBatchProvider<string> {
  return {
    dialect: "memory",
    capabilities: {
      interactiveTransactions: false,
      atomicBatch: true,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
      maxPageSize: 100,
      maxBindParams: 100,
      maxStatementBytes: 100_000,
    },
    repository: () => { throw new Error("not used") },
     async executeAtomicBatch(plan) {
      onPlan(plan.items)
      return plan.items.map((item) => ({ kind: item.kind, result: item.kind === "command" ? item.command : item }))
    },
  }
}

function createRollbackTxProvider(): { provider: InteractiveTransactionProvider; committed: boolean; rolledBack: boolean } {
  let committed = false
  let rolledBack = false
  const provider: InteractiveTransactionProvider = {
    dialect: "memory",
    capabilities: {
      interactiveTransactions: true,
      atomicBatch: false,
      returningInsert: false,
      readSessions: false,
      jsonQueries: false,
      exactDecimal: false,
      persistentConnection: false,
      maxPageSize: 100,
      maxBindParams: 100,
      maxStatementBytes: 100_000,
    },
    repository: () => { throw new Error("not used") },
    async runInTransaction(fn) {
      rolledBack = false
      committed = false
      try {
        const result = await fn(provider)
        committed = true
        return result
      } catch {
        rolledBack = true
        throw new Error("transaction failed")
      }
    },
  }
  return {
    provider,
    get committed() { return committed },
    get rolledBack() { return rolledBack },
  }
}

const defaultRuntimeCaps: RuntimeCapabilities = {
  deferredExecution: true,
  cache: true,
}

const disabledRuntimeCaps: RuntimeCapabilities = {
  deferredExecution: false,
  cache: false,
}

function requestContext(args: {
  requestId?: string
  correlationId?: string
  actorId?: string
  tenantId?: string
  metadata?: Record<string, unknown>
} = {}): RequestContext {
  const actor: Principal = args.actorId
    ? { id: args.actorId, kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
    : createAnonymousPrincipal()
  const scope = args.tenantId
    ? { kind: "tenant", tenantId: args.tenantId } as const
    : { kind: "application", applicationKey: "operation-tests" } as const
  const scopeId = encodeExecutionScopeId(scope)
  const correlationId = args.correlationId ?? "correlation-1"
  return {
    requestId: args.requestId ?? "request-1",
    correlationId,
    identity: { actor, subject: actor },
    scope,
    scopeId,
    authority: {
      identity: { actor, subject: actor },
      correlationId,
      grant: {
        grantId: `test:${correlationId}`,
        source: { kind: "route", routeKey: "operation-test" },
        target: { scope, scopeId },
        purpose: "operation-test",
        reason: "test fixture",
        issuedAt: "2026-09-10T00:00:00.000Z",
        policy: { policyKey: "operation-test", policyVersion: 1, policyDigest: "test", evaluatedAt: "2026-09-10T00:00:00.000Z", authorizationModel: "snapshot" },
        delegationChain: [],
        impersonation: { kind: "none" },
      },
    },
    route: { routeKey: "operation-test", definitionVersion: 1, operationKey: "operation-test" },
    signal: new AbortController().signal,
    ...(args.metadata ? { metadata: args.metadata } : {}),
  }
}

// Keep compact fixtures at the execution boundary while preserving the
// contract enforced by the framework validator.
/* eslint-disable @typescript-eslint/no-explicit-any */
type FixtureDefinition = Omit<OperationDefinition<any, any, any>, "kind" | "atomicity" | "authorization"> & {
  [key: string]: unknown
  kind?: "read" | "mutation"
  atomicity?: import("../operationDefinition").OperationAtomicity
  authorization?: import("../operationDefinition").OperationAuthorizationPort<any>
  execute?: (args: any) => any
  prepare?: (args: { operation: AtomicBatchPreparationContext; input: any }) => any
  audit?: OperationAuditConfig<any, any>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function normalizeFixtureDefinition(definition: FixtureDefinition): OperationDefinition<unknown, unknown, unknown> {
  if (definition.kind === "read" || definition.kind === "mutation") {
    return definition as unknown as OperationDefinition<unknown, unknown, unknown>
  }
  const atomicity = definition.atomicity
  const isMutation = atomicity?.kind === "atomic-batch" || atomicity?.mode === "required" ||
    "afterCommit" in definition || "outbox" in definition || "audit" in definition
  if (!isMutation) {
    return { ...definition, kind: "read" } as unknown as OperationDefinition<unknown, unknown, unknown>
  }
  return {
    ...definition,
    kind: "mutation",
    atomicity: atomicity ?? { kind: "standard", mode: "required" },
    authorization: definition.authorization ?? { authorize: async () => ({ allowed: true }) },
  } as unknown as OperationDefinition<unknown, unknown, unknown>
}

/** Test fixtures model a compiled route that dispatches to the definition under test. */
function bindFixtureRoute<T extends OperationEnvironment>(operation: T, definition: { key: string }): T {
  const request = operation.request
  if (!request || request.route.operationKey !== "operation-test") return operation
  return {
    ...operation,
    request: { ...request, route: { ...request.route, operationKey: definition.key } },
  } as T
}

async function runOperation<TInput, TResult>(args: { operation: OperationEnvironment; definition: FixtureDefinition; input: TInput; onBusinessResult?: (result: TResult, operation: PostCommitContext) => Promise<void> }): Promise<TResult> {
  const definition = normalizeFixtureDefinition(args.definition) as OperationDefinition<TInput, TResult, unknown>
  return frameworkRunOperation<TInput, TResult>({ ...args, operation: bindFixtureRoute(args.operation, definition) as OperationEnvironment, definition })
}

async function runOperationDetailed<TInput, TResult>(args: { operation: OperationEnvironment; definition: FixtureDefinition; input: TInput }): Promise<import("../operationPipeline").OperationOutcome<TResult>> {
  const definition = normalizeFixtureDefinition(args.definition) as OperationDefinition<TInput, TResult, unknown>
  return frameworkRunOperationDetailed<TInput, TResult>({ ...args, operation: bindFixtureRoute(args.operation, definition) as OperationEnvironment, definition })
}

describe("operationPipeline", () => {
  it("rejects a route authority context whose bound operation differs from the executed definition", async () => {
    const request = requestContext()
    const operation = createOperationContext({
      persistence: createNoTxProvider(),
      runtimeCapabilities: disabledRuntimeCaps,
      request: { ...request, route: { ...request.route, operationKey: "orders.read" } },
    })

    await expect(frameworkRunOperation({
      operation,
      definition: { key: "orders.delete", kind: "read", execute: async () => "must-not-run" },
      input: {},
    })).rejects.toThrow(/bound to operation/)
  })
  it("validates definitions passed directly to the execution boundary", async () => {
    await expect(runOperation({
      operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: { key: "", execute: async () => "done" },
      input: {},
    })).rejects.toThrow(/key must be non-empty/i)

    await expect(runOperationDetailed({
      operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: { key: "", execute: async () => "done" },
      input: {},
    })).rejects.toThrow(/key must be non-empty/i)
  })

  it("runs before, execute, after lifecycle", async () => {
    const events: string[] = []
    const result = await runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "test",
        before: () => { events.push("before"); return {} },
        execute: async () => { events.push("execute"); return { ok: true } },
        after: () => { events.push("after"); return { ok: true } },
      },
      input: {},
    })
    expect(events).toEqual(["before", "execute", "after"])
    expect(result).toEqual({ ok: true })
  })

  it("runs lifecycle but does not rollback on non-transactional provider", async () => {
    const writes: string[] = []

    await expect(runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "no-tx",
        before: () => { writes.push("before"); return {} },
        execute: async () => { writes.push("execute"); return {} },
        after: () => { writes.push("after"); throw new Error("after-hook failed") },
      },
      input: {},
    })).rejects.toThrow("after-hook failed")

    expect(writes).toEqual(["before", "execute", "after"])
  })

  it("throws ConfigurationError when required atomicity is unsupported", async () => {
    await expect(runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "tx-required",
        atomicity: { kind: "standard", mode: "required" },
        execute: async () => ({}),
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
  })

  it("runs best-effort effects after the operation", async () => {
     const metadata: Record<string, unknown> = {}
     const ctx = createOperationContext({
       persistence: createTxProvider(),
       runtimeCapabilities: defaultRuntimeCaps,
       request: requestContext({ metadata }),
     })

    const sideEffect = vi.fn()
    await runOperation({
      operation: ctx,
      definition: {
        key: "side-effects",
        atomicity: { kind: "standard", mode: "required" },
         execute: async ({ operation }: { operation: MutationOperationContext }) => {
          operation.addBestEffortEffect("test", sideEffect)
          return {}
        },
      },
      input: {},
    })

    expect(sideEffect).toHaveBeenCalled()
  })

  it("runs best-effort work after the business-result hook", async () => {
    const events: string[] = []
    const provider = createRollbackTxProvider()

    await frameworkRunOperation({
      operation: createOperationContext({ persistence: provider.provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "business-result-after-commit",
          kind: "mutation",
          atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true }) },
         execute: async ({ operation }: { operation: MutationOperationContext }) => {
          operation.addBestEffortEffect("audit-like-work", async () => { events.push("best-effort-effect") })
          return { ok: true }
        },
      },
      input: {},
      onBusinessResult: async () => { events.push("business-result") },
    })

    expect(events).toEqual(["business-result", "best-effort-effect"])
    expect(provider.committed).toBe(true)
  })

  it("keeps best-effort failures outside the business result", async () => {
    const provider = createRollbackTxProvider()
    const onBusinessResult = vi.fn(async () => undefined)

    await expect(frameworkRunOperation({
      operation: createOperationContext({ persistence: provider.provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "business-result-rollback",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true }) },
         execute: async ({ operation }: { operation: MutationOperationContext }) => {
          operation.addBestEffortEffect("rollback", async () => { throw new Error("audit failed") })
          return { ok: true }
        },
      },
      input: {},
      onBusinessResult,
    })).resolves.toEqual({ ok: true })

    expect(onBusinessResult).toHaveBeenCalled()
    expect(provider.committed).toBe(true)
    expect(provider.rolledBack).toBe(false)
  })

  it("rejects an operation that requires an unavailable runtime capability before hooks run", async () => {
    const before = vi.fn()

    await expect(runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: disabledRuntimeCaps }),
      definition: {
        key: "cache-required",
        requiredRuntimeCapabilities: ["cache"],
        before,
        execute: async () => ({}),
      },
      input: {},
    })).rejects.toSatisfy((error: unknown) => error instanceof RuntimeCapabilityError &&
      error.code === "RUNTIME_CAPABILITY_REQUIRED" &&
      Boolean(error.details && typeof error.details === "object" && "capability" in error.details && error.details.capability === "cache"))

    expect(before).not.toHaveBeenCalled()
  })

  it("rejects deferred effects when deferred execution is disabled", () => {
    const operation = createOperationRunContext(createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: disabledRuntimeCaps }))

    expect(() => operation.addBestEffortEffect("deferred", async () => {})).toThrow(RuntimeCapabilityError)
    expect(() => operation.addBestEffortEffect("deferred", async () => {})).toThrow(RuntimeCapabilityError)
  })

  it("preserves enabled runtime capabilities for deferred effects and facility checks", async () => {
    const operation = createOperationRunContext(createOperationContext({
       persistence: createTxProvider(),
      runtimeCapabilities: { deferredExecution: true, objectStore: { put: vi.fn(), get: vi.fn(), head: vi.fn(), delete: vi.fn() }, cache: true },
    }))
    const effect = vi.fn()

    await runOperation({
      operation,
      definition: {
         key: "enabled-capabilities",
         kind: "mutation",
         requiredRuntimeCapabilities: ["objectStore", "cache"],
         atomicity: { kind: "standard", mode: "required" },
         authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation: run }) => {
          run.addBestEffortEffect("deferred", effect)
          return {}
        },
      },
      input: {},
    })

    expect(effect).toHaveBeenCalled()
  })

  it("allows best-effort effects for mutation callbacks", async () => {
    const sideEffect = vi.fn()

    await expect(runOperation({
       operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
         key: "side-effects-without-tx",
         kind: "mutation",
         atomicity: { kind: "standard", mode: "required" },
         authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation }: { operation: MutationOperationContext; input: Record<string, never> }) => {
          operation.addBestEffortEffect("test", sideEffect)
          return {}
        },
      },
      input: { transformed: false },
    })).resolves.toEqual({})

    expect(sideEffect).toHaveBeenCalled()
  })

  it("afterCommit hook runs after success", async () => {
    const afterCommit = vi.fn()

    await runOperation({
      operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
         key: "after-commit",
         kind: "mutation",
         atomicity: { kind: "standard", mode: "required" },
         authorization: { authorize: async () => ({ allowed: true }) },
        execute: async () => ({ ok: true }),
        afterCommit: [afterCommit],
      },
      input: {},
    })

    expect(afterCommit).toHaveBeenCalled()
  })

  it("reports standard post-commit hook failures without rolling back the committed work", async () => {
    const rollbackCtx = createRollbackTxProvider()
    const emit = vi.fn()

    await expect(runOperation({
      operation: createOperationContext({
        persistence: rollbackCtx.provider,
        runtimeCapabilities: defaultRuntimeCaps,
        telemetry: { emit },
      }),
      definition: {
        key: "standard-after-commit-failure",
        atomicity: { kind: "standard", mode: "required" },
        execute: async () => ({ ok: true }),
        afterCommit: () => { throw new Error("after-commit failed") },
      },
      input: {},
    })).resolves.toEqual({ ok: true })

    expect(rollbackCtx.committed).toBe(true)
    expect(rollbackCtx.rolledBack).toBe(false)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "operation.effect.failure", attributes: expect.objectContaining({ phase: "afterCommit", effectName: "hooks" }) }))
  })

  it("reports best-effort post-commit failures without converting the committed result into an error", async () => {
    const rollbackCtx = createRollbackTxProvider()
    const emit = vi.fn()

    await expect(runOperation({
      operation: createOperationContext({
        persistence: rollbackCtx.provider,
        runtimeCapabilities: defaultRuntimeCaps,
        telemetry: { emit },
      }),
      definition: {
        key: "standard-best-effort-failure",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("best-effort", async () => { throw new Error("best-effort failed") })
          return { ok: true }
        },
      },
      input: {},
    })).resolves.toEqual({ ok: true })

    expect(rollbackCtx.committed).toBe(true)
    expect(rollbackCtx.rolledBack).toBe(false)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "operation.effect.failure", attributes: expect.objectContaining({ phase: "bestEffort", effectName: "best-effort" }) }))
  })

  it("reports best-effort failures without rejecting the committed operation", async () => {
    const rollbackCtx = createRollbackTxProvider()

    await expect(runOperation({
      operation: createOperationContext({ persistence: rollbackCtx.provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "standard-required-post-commit-failure",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("required", async () => { throw new Error("required failed") })
          return { ok: true }
        },
      },
      input: {},
    })).resolves.toEqual({ ok: true })

    expect(rollbackCtx.committed).toBe(true)
    expect(rollbackCtx.rolledBack).toBe(false)
  })

  it("drains post-commit effects when the committed business-result hook fails", async () => {
    const rollbackCtx = createRollbackTxProvider()
    const effect = vi.fn(async () => undefined)

    await expect(runOperation({
      operation: createOperationContext({ persistence: rollbackCtx.provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "business-result-failure",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("after-commit", effect)
          return { ok: true }
        },
      },
      input: {},
      onBusinessResult: async () => { throw new Error("idempotency failed") },
    })).resolves.toEqual({ ok: true })

    expect(effect).toHaveBeenCalledOnce()
    expect(rollbackCtx.committed).toBe(true)
  })

  it("returns committed detailed outcomes with best-effort effect failures", async () => {
    const metadata: Record<string, unknown> = {}
    const outcome = await runOperationDetailed({
      operation: createOperationContext({
         persistence: createTxProvider(),
        runtimeCapabilities: defaultRuntimeCaps,
        request: requestContext({ metadata }),
      }),
      definition: {
         key: "detailed-best-effort-failure",
         kind: "mutation",
         atomicity: { kind: "standard", mode: "required" },
         authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("notification", async () => { throw new Error("notification failed") })
          return { ok: true }
        },
      },
      input: {},
    })

    expect(outcome).toMatchObject({
      committed: true,
      result: { ok: true },
      postCommitEffectFailures: [{ message: "Error: notification failed" }],
    })
  })

  it("returns post-commit failures in a detailed outcome without correlation metadata", async () => {
    const metadata: Record<string, unknown> = {}
    const outcome = await runOperationDetailed({
      operation: createOperationContext({
         persistence: createTxProvider(),
        runtimeCapabilities: defaultRuntimeCaps,
        request: requestContext({ correlationId: "request-1", metadata }),
      }),
      definition: {
         key: "detailed-best-effort-no-correlation",
         kind: "mutation",
         atomicity: { kind: "standard", mode: "required" },
         authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("notification", async () => { throw new Error("notification failed") })
          return { ok: true }
        },
      },
      input: {},
    })

    expect(outcome).toEqual({
      result: { ok: true },
      operationId: expect.any(String) as string,
      correlationId: "request-1",
      committed: true,
      warnings: [],
      postCommitEffectFailures: [{ message: "Error: notification failed", phase: "bestEffort", effectName: "notification" }],
    })
    expect(typeof outcome.operationId).toBe("string")
  })

  it("normalizes detailed post-commit failures and omits empty failure metadata", async () => {
    const metadata: Record<string, unknown> = {
      _effectFailures: [
        { error: null, phase: "afterCommit", effectName: "hook" },
        { error: "plain failure", phase: 42, effectName: null },
      ],
     }
    const outcome = await runOperationDetailed({
      operation: createOperationContext({
       persistence: createTxProvider(),
        runtimeCapabilities: defaultRuntimeCaps,
        request: requestContext({ correlationId: "request-1", metadata }),
      }),
      definition: { key: "detailed-failure-shapes", execute: async () => ({ ok: true }) },
      input: {},
    })

    expect(outcome).toEqual({
      result: { ok: true },
      operationId: expect.any(String) as string,
      correlationId: "request-1",
      committed: true,
      warnings: [],
      postCommitEffectFailures: [
        { message: "Post-commit effect failed", phase: "afterCommit", effectName: "hook" },
        { message: "plain failure" },
      ],
    })
    expect(typeof outcome.operationId).toBe("string")

    const clean = await runOperationDetailed({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: { key: "detailed-no-correlation", execute: async () => ({ ok: true }) },
      input: {},
    })
    expect(clean).not.toHaveProperty("correlationId")
    expect(clean).not.toHaveProperty("postCommitEffectFailures")
  })

  it("passes transformed before input to afterCommit and uses the root provider", async () => {
     const metadata: Record<string, unknown> = {}
     const ctx = createOperationContext({
       persistence: createTxProvider(),
       runtimeCapabilities: defaultRuntimeCaps,
       request: requestContext({ metadata }),
     })
    const afterCommit = vi.fn<(context: {
      input: { transformed: boolean }
        operation: PostCommitContext
      result: { transformed: boolean }
    }) => void>()
    const deferred = vi.fn()

    await runOperation({
      operation: ctx,
      definition: {
       key: "after-commit-context",
        atomicity: { kind: "standard", mode: "required" },
        before: () => ({ transformed: true }),
         execute: async ({ input }): Promise<{ transformed: boolean }> => {
            // Compact fixtures are normalized by the test boundary above.
           // eslint-disable-next-line @typescript-eslint/no-unsafe-return
           return input
         },
        afterCommit: [(({ operation, input, result }) => {
          afterCommit({ operation, input, result })
           operation.addBestEffortEffect("deferred", deferred)
        }) satisfies AfterCommitHook<{ transformed: boolean }, { transformed: boolean }>],
      },
       input: { transformed: false },
    })

    expect(afterCommit).toHaveBeenCalledWith(expect.objectContaining({
      input: { transformed: true },
      result: { transformed: true },
    }))
    expect(Object.keys(afterCommit.mock.calls[0]?.[0].operation ?? {}).sort()).toEqual([
      "addBestEffortEffect", "correlationId", "deadline", "metadata", "operationId", "request", "services", "signal",
    ])
    expect(afterCommit.mock.calls[0]?.[0].operation.metadata).toBe(metadata)
    const restrictedOperation = afterCommit.mock.calls[0]?.[0].operation
    expect(restrictedOperation).toBeDefined()
    if (!restrictedOperation) throw new Error("afterCommit did not receive an operation context")
    expect(Reflect.get(restrictedOperation ?? {}, "addOutboxRecord")).toBeUndefined()
    expect(deferred).toHaveBeenCalledWith(expect.objectContaining({ services: ctx.services }))
    expect(deferred.mock.calls[0]?.[0]).not.toHaveProperty("persistence")
  })

  it("runs standard afterCommit with the root provider after the transaction-scoped work", async () => {
    const rootProvider = createTxProvider()
    const ctx = createOperationContext({ persistence: rootProvider, runtimeCapabilities: defaultRuntimeCaps })
    let scopedProvider: InteractiveTransactionProvider | undefined
    rootProvider.runInTransaction = async (work) => {
      const scoped: InteractiveTransactionProvider = {
        ...rootProvider,
        runInTransaction: async () => {
          throw new Error("nested transaction should not run")
        },
      }
      scopedProvider = scoped
      return work(scoped)
    }
    const afterCommit = vi.fn(({ operation }: { operation: PostCommitContext }) => {
      expect(operation.services).toBe(ctx.services)
      expect(operation).not.toHaveProperty("persistence")
    })

    await runOperation({
      operation: ctx,
      definition: {
        key: "root-provider-after-commit",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          expect(operation.persistence).toBe(scopedProvider)
          return { ok: true }
        },
        afterCommit,
      },
      input: {},
    })

    expect(afterCommit).toHaveBeenCalledOnce()
  })

  it("allows best-effort registration from afterCommit", async () => {
    const emit = vi.fn()
    const ctx = createOperationContext({
         persistence: createTxProvider(),
      runtimeCapabilities: defaultRuntimeCaps,
      telemetry: { emit },
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
         key: "after-commit-restrictions",
         kind: "mutation",
         atomicity: { kind: "standard", mode: "required" },
         authorization: { authorize: async () => ({ allowed: true }) },
        execute: async () => ({}),
          afterCommit: [(({ operation }: { operation: PostCommitContext }) => {
            operation.addBestEffortEffect("invalid", async () => {})
        }) satisfies AfterCommitHook<Record<string, never>, Record<string, never>>],
      },
      input: {},
    })).resolves.toEqual({})

    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ name: "operation.effect.failure" }))
  })

  it("continues all standard post-commit hooks and effects, then reports a committed failure", async () => {
    const events: string[] = []
    const failures: Array<{ phase: string; effectName: string }> = []
    const metadata: Record<string, unknown> = {}
    const ctx = createOperationContext({
      persistence: createTxProvider(),
      runtimeCapabilities: defaultRuntimeCaps,
      request: requestContext({ metadata }),
      telemetry: { emit: (event) => { if (event.name === "operation.effect.failure") failures.push({ phase: String(event.attributes.phase), effectName: String(event.attributes.effectName) }) } },
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "standard-post-commit-failures",
        atomicity: { kind: "standard", mode: "required" },
        execute: async () => ({ ok: true }),
        afterCommit: [
            async ({ operation }: { operation: PostCommitContext; input: Record<string, never>; result: { ok: boolean } }) => {
            events.push("hook-1")
             operation.addBestEffortEffect("effect-1", async (root) => {
              events.push("effect-1")
               expect(root).not.toHaveProperty("persistence")
              throw new Error("effect-1 failed")
            })
            throw new Error("hook-1 failed")
          },
            async ({ operation }: { operation: PostCommitContext; input: Record<string, never>; result: { ok: boolean } }) => {
            events.push("hook-2")
             operation.addBestEffortEffect("effect-2", async (root) => {
              events.push("effect-2")
               expect(root).not.toHaveProperty("persistence")
              throw new Error("effect-2 failed")
            })
          },
        ],
      },
      input: {},
    })).resolves.toEqual({ ok: true })

    expect(events).toEqual(["hook-1", "hook-2", "effect-1", "effect-2"])
    expect(failures).toEqual([
      { phase: "afterCommit", effectName: "hooks" },
       { phase: "bestEffort", effectName: "effect-1" },
       { phase: "bestEffort", effectName: "effect-2" },
    ])
  })

  it("gracefully degrades when preferred atomicity is unavailable", async () => {
    const events: string[] = []

    const result = await runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "tx-preferred",
        atomicity: { kind: "standard", mode: "preferred" },
        before: () => { events.push("before"); return {} },
        execute: async () => { events.push("execute"); return { ok: true } },
        after: () => { events.push("after"); return { ok: true } },
      },
      input: {},
    })

    expect(events).toEqual(["before", "execute", "after"])
    expect(result).toEqual({ ok: true })
  })

  it("ignores afterCommit hook when after hook throws", async () => {
    const afterCommit = vi.fn()

    await expect(runOperation({
      operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
         key: "after-commit-skip",
         kind: "mutation",
         atomicity: { kind: "standard", mode: "required" },
         authorization: { authorize: async () => ({ allowed: true }) },
        execute: async () => ({ ok: true }),
        after: () => { throw new Error("after failed") },
        afterCommit: [afterCommit],
      },
      input: {},
    })).rejects.toThrow("after failed")

    expect(afterCommit).not.toHaveBeenCalled()
  })
})

describe("shared side-effect state", () => {
  it("keeps durable effects scoped to the operation run", async () => {
    const sideEffect = vi.fn()

    const ctx = createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps })

    await runOperation({
      operation: ctx,
      definition: {
        key: "shared-state",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("test", sideEffect)
          return {}
        },
      },
      input: {},
    })

    expect(sideEffect).toHaveBeenCalled()
  })

  it("isolates effects between runs that reuse an operation context", async () => {
    const firstRunEffect = vi.fn()
    const secondRunEffect = vi.fn()
    const ctx = createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps })

    await runOperation({
      operation: ctx,
      definition: {
       key: "first-run",
       kind: "mutation" as const,
       atomicity: { kind: "standard" as const, mode: "required" as const },
       authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("first-run", firstRunEffect)
          return {}
        },
      },
      input: {},
    })

    await runOperation({
      operation: ctx,
      definition: {
       key: "second-run",
       kind: "mutation",
       atomicity: { kind: "standard", mode: "required" },
       authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("second-run", secondRunEffect)
          return {}
        },
      },
      input: {},
    })

    expect(firstRunEffect).toHaveBeenCalledTimes(1)
    expect(secondRunEffect).toHaveBeenCalledTimes(1)
  })

  it("assigns a fresh operation ID to each run from the same environment", async () => {
    const operationIds: string[] = []
    const ctx = createOperationContext({
      persistence: createNoTxProvider(),
      runtimeCapabilities: defaultRuntimeCaps,
      idGenerator: (() => {
        let next = 0
        return () => `operation-${++next}`
      })(),
    })
    const definition = {
      key: "fresh-operation-id",
        execute: async ({ operation }: { operation: ReadOperationContext }) => {
        operationIds.push(operation.operationId)
        return {}
      },
    }

    await runOperation({ operation: ctx, definition, input: {} })
    await runOperation({ operation: ctx, definition, input: {} })

    expect(operationIds).toHaveLength(2)
    expect(operationIds[0]).not.toBe(operationIds[1])
    expect(ctx).not.toHaveProperty("operationId")
  })

  it("does not replay effects registered on one run into another execution", async () => {
    const calls: string[] = []
     const environment = createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps })
     const definition = {
       key: "run-scoped-effects",
       kind: "mutation",
       atomicity: { kind: "standard", mode: "required" },
       authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation }: { operation: InternalOperationRunContext }) => {
         operation.addBestEffortEffect("once", async () => { calls.push("effect") })
         return {}
       },
       } as const

    await runOperation({ operation: environment, definition, input: {} })
    await runOperation({ operation: environment, definition, input: {} })

    expect(calls).toEqual(["effect", "effect"])
  })

  it("reports a fresh operation ID for each detailed run from the same environment", async () => {
    const ctx = createOperationContext({
      persistence: createNoTxProvider(),
      runtimeCapabilities: defaultRuntimeCaps,
      idGenerator: (() => {
        let next = 0
        return () => `operation-${++next}`
      })(),
    })
    const definition = {
      key: "fresh-detailed-operation-id",
      execute: async () => ({ ok: true }),
    }

    const first = await runOperationDetailed({ operation: ctx, definition, input: {} })
    const second = await runOperationDetailed({ operation: ctx, definition, input: {} })

    expect(first).toEqual({ result: { ok: true }, operationId: "operation-1", committed: true, warnings: [] })
    expect(second).toEqual({ result: { ok: true }, operationId: "operation-2", committed: true, warnings: [] })
    expect(ctx).not.toHaveProperty("operationId")
  })

  it("keeps one operation ID across standard execution, audit, and post-commit contexts", async () => {
    const ids: string[] = []
    const append = vi.fn()
    const ctx = createOperationContext({
      persistence: createTxProvider(),
      runtimeCapabilities: defaultRuntimeCaps,
      request: requestContext({ actorId: "user-1" }),
      outboxSinkFactory: { create: () => ({ append }) },
      idGenerator: () => crypto.randomUUID(),
    })

    const result = await runOperationDetailed({
      operation: ctx,
      definition: {
        key: "operation-id-consistency",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          ids.push(operation.operationId)
           operation.addBestEffortEffect("same-operation", async (effectOperation: PostCommitContext | undefined) => {
             if (!effectOperation) throw new Error("Expected post-commit operation context")
             ids.push(effectOperation.operationId)
          })
          return { ok: true }
        },
        audit: {
          action: "entity.updated",
          resourceType: "entity",
          auditGuarantee: "durable",
          resolveResourceId: () => "entity-1",
        },
        afterCommit: ({ operation }) => {
          ids.push(operation.operationId)
        },
      },
      input: {},
    })

    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
    expect(result.operationId).toBe(ids[0])
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `audit:${result.operationId}:entity.updated`,
    }))
  })

  it("does not expose persistence escape hatches to effects", async () => {
    const events: string[] = []
     const ctx = createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps })

    await runOperation({
      operation: ctx,
      definition: {
         key: "nested-persistence-effects",
         kind: "mutation",
         atomicity: { kind: "standard", mode: "required" },
         authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("outer", async (nested: PostCommitContext | undefined) => {
            events.push("outer")
            expect(Reflect.get(nested ?? {}, "addOutboxRecord")).toBeUndefined()
            expect(Reflect.get(nested ?? {}, "enforceAbac")).toBeUndefined()
            nested?.addBestEffortEffect("inner", async () => { events.push("inner") })
          })
          return {}
        },
      },
      input: {},
    })

    expect(events).toEqual(["outer", "inner"])
  })

  it("disposes effects registered by a failed run before the next run", async () => {
    const failedRunEffect = vi.fn()
    const successfulRunEffect = vi.fn()
    const ctx = createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "failed-run",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation }) => {
           operation.addBestEffortEffect("failed-run", failedRunEffect)
          throw new Error("execute failed")
        },
      },
      input: {},
    })).rejects.toThrow("execute failed")

    await runOperation({
      operation: ctx,
      definition: {
        key: "successful-run",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
           operation.addBestEffortEffect("successful-run", successfulRunEffect)
          return {}
        },
      },
      input: {},
    })

    expect(failedRunEffect).not.toHaveBeenCalled()
    expect(successfulRunEffect).toHaveBeenCalledTimes(1)
  })

  it("executes effects registered during afterCommit only for that run", async () => {
    const lateEffect = vi.fn()
     const ctx = createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps })

      const definition = {
       key: "late-registration",
       kind: "mutation" as const,
       atomicity: { kind: "standard" as const, mode: "required" as const },
      authorization: { authorize: async () => ({ allowed: true }) },
      execute: async () => ({}),
        afterCommit: [({ operation }: { operation: PostCommitContext }) => {
         operation.addBestEffortEffect("late", lateEffect)
      }],
      }

    await runOperation({ operation: ctx, definition, input: {} })
    await runOperation({ operation: ctx, definition, input: {} })

    expect(lateEffect).toHaveBeenCalledTimes(2)
  })

  it("drains effects registered while post-commit and best-effort effects execute", async () => {
    const events: string[] = []
     const ctx = createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps })

    await runOperation({
      operation: ctx,
      definition: {
         key: "dynamic-effect-registration",
         kind: "mutation",
         atomicity: { kind: "standard", mode: "required" },
         authorization: { authorize: async () => ({ allowed: true }) },
        execute: async ({ operation }) => {
            operation.addBestEffortEffect("post-1", async (root: PostCommitContext | undefined) => {
             events.push("post-1")
             expect(Reflect.get(root ?? {}, "addOutboxRecord")).toBeUndefined()
             expect(Reflect.get(root ?? {}, "enforceAbac")).toBeUndefined()
             root?.addBestEffortEffect("best-2", async () => { events.push("best-2") })
               root?.addBestEffortEffect("best-1", async (bestEffortRoot: PostCommitContext | undefined) => {
               events.push("best-1")
               expect(Reflect.get(bestEffortRoot ?? {}, "addOutboxRecord")).toBeUndefined()
               expect(Reflect.get(bestEffortRoot ?? {}, "enforceAbac")).toBeUndefined()
               bestEffortRoot?.addBestEffortEffect("best-3", async () => { events.push("best-3") })
            })
          })
          return {}
        },
      },
      input: {},
    })

     expect(events).toEqual(["post-1", "best-2", "best-1", "best-3"])
  })

})

describe("atomic-batch operations", () => {
  it("forwards the business-result hook once through the standard atomic-batch fallback", async () => {
    const onBusinessResult = vi.fn(async () => undefined)

    await frameworkRunOperation({
      operation: createOperationContext({ persistence: createAtomicProvider(() => {}), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "atomic-fallback-business-result",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true }) },
        execute: async () => ({ ok: true }),
        atomicBatch: {
          prepare: async () => ({ commands: ["insert"], result: { ok: true } }),
        },
      },
      input: {},
      onBusinessResult,
    })

    expect(onBusinessResult).toHaveBeenCalledTimes(1)
  })

  it("passes a restricted post-commit context to the atomic onBusinessResult", async () => {
    let received: unknown
    await runOperation({
      operation: createOperationContext({ persistence: createAtomicProvider(() => {}), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "atomic-on-business-result-context",
        atomicity: { kind: "atomic-batch" },
        prepare: async () => ({ commands: ["insert"], result: { ok: true } }),
      },
      input: {},
      onBusinessResult: async (_result, operation) => { received = operation },
    })
    const keys = Object.keys(received ?? {})
    expect(keys).not.toContain("persistence")
    expect(keys).not.toContain("addOutboxRecord")
    expect(keys).toContain("addBestEffortEffect")
  })

  it("closes the pre-commit effect collector before the atomic batch commits", async () => {
    const executeAtomicBatch = vi.fn()
    const provider = createAtomicProvider(() => {})
    provider.executeAtomicBatch = async (plan) => {
      executeAtomicBatch(plan)
      return plan.items.map((item) => ({ kind: item.kind, result: "ok" }))
    }

    await expect(runOperation({
      operation: createOperationContext({ persistence: provider, runtimeCapabilities: defaultRuntimeCaps, outboxSinkFactory: { create: () => ({ append: async () => {} }) } }),
      definition: {
        key: "atomic-late-outbox-registration",
        atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => ({
          commands: ["insert"],
          result: { ok: true },
          verify: async () => {
            operation.addOutboxRecord({ type: "late", version: 1, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never, aggregateType: "x", aggregateId: "1", payload: {}, idempotencyKey: "late" })
          },
        }),
      },
      input: {},
    })).rejects.toThrow(OperationCommittedEffectError)

    expect(executeAtomicBatch).toHaveBeenCalledOnce()
  })

  it("rejects late post-commit effect registration after the atomic batch commits", async () => {
    const executeAtomicBatch = vi.fn()
    const provider = createAtomicProvider(() => {})
    provider.executeAtomicBatch = async (plan) => {
      executeAtomicBatch(plan)
      return plan.items.map((item) => ({ kind: item.kind, result: "ok" }))
    }

    await expect(runOperation({
      operation: createOperationContext({ persistence: provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
         key: "atomic-late-post-commit-effect",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({
          commands: ["insert"],
          result: { ok: true },
        }),
        after: async ({ operation }) => {
            // @ts-expect-error Representation hooks cannot register effects publicly.
            operation.addBestEffortEffect("late", async () => undefined)
        },
      },
      input: {},
    })).rejects.toThrow(OperationCommittedEffectError)

    expect(executeAtomicBatch).toHaveBeenCalledOnce()
  })

  it("rejects unavailable required runtime capabilities before atomic preparation", async () => {
    const prepare = vi.fn()

    await expect(runOperation({
      operation: createOperationContext({ persistence: createAtomicProvider(() => {}), runtimeCapabilities: disabledRuntimeCaps }),
      definition: {
        key: "atomic-cache-required",
        atomicity: { kind: "atomic-batch" },
        requiredRuntimeCapabilities: ["cache"],
        prepare,
      },
      input: {},
    })).rejects.toThrow(RuntimeCapabilityError)

    expect(prepare).not.toHaveBeenCalled()
  })

  it("keeps one operation ID across atomic preparation and post-commit contexts", async () => {
    const ids: string[] = []
    const ctx = createOperationContext({
      persistence: createAtomicProvider(() => {}),
      runtimeCapabilities: defaultRuntimeCaps,
    })

    await runOperation({
      operation: ctx,
      definition: {
        key: "atomic-operation-id-consistency",
        atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => {
          ids.push(operation.operationId)
            operation.addBestEffortEffect("same-operation", async (effectOperation: PostCommitContext | undefined) => {
            if (!effectOperation) throw new Error("Expected post-commit operation context")
            ids.push(effectOperation.operationId)
          })
          return { commands: ["insert"], result: { ok: true } }
        },
        afterCommit: ({ operation }) => {
          ids.push(operation.operationId)
        },
      },
      input: {},
    })

    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
  })

  it("dispatches to the atomic provider and uses operation ID/clock services", async () => {
    const fixedDate = new Date("2026-01-02T03:04:05.000Z")
    const ids = ["operation-id", "audit-id", "outbox-id"]
    let capturedItems: readonly AtomicBatchItem<string>[] = []
    const result = await runOperation({
      operation: createOperationContext({
        persistence: createAtomicProvider((items) => { capturedItems = items }),
        runtimeCapabilities: defaultRuntimeCaps,
        request: requestContext({ actorId: "user-1" }),
        idGenerator: () => ids.shift() ?? "unexpected-id",
        clock: { now: () => fixedDate },
      }),
      definition: {
        key: "atomic-create",
        atomicity: { kind: "atomic-batch" },
         prepare: ({ operation }) => {
          operation.addOutboxRecord({
            id: "",
            type: "entity.created",
            version: 1,
            tenantId: null,
            scope: { kind: "platform", platformKey: "test" },
            scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never,
            aggregateType: "entity",
            aggregateId: "entity-1",
            payload: {},
            idempotencyKey: "entity-1",
            occurredAt: fixedDate,
          })
            return { commands: ["insert"], result: { id: "entity-1" } }
        },
        audit: {
          action: "entity.created",
          resourceType: "entity",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })

    expect(result).toEqual({ id: "entity-1" })
    expect(capturedItems[0]).toEqual({ kind: "command", command: "insert" })
    const auditItem = capturedItems.find((item) => item.kind === "audit")
    if (!auditItem) throw new Error("Expected audit item")
    expect(auditItem.kind).toBe("audit")
    if (auditItem.kind === "audit") {
      expect(auditItem.record.id).toBe("audit-id")
      expect(auditItem.record.occurredAt).toBe(fixedDate)
    }
    const outboxItem = capturedItems.find((item) => item.kind === "outbox")
    if (!outboxItem) throw new Error("Expected outbox item")
    expect(outboxItem.kind).toBe("outbox")
    if (outboxItem.kind === "outbox") {
      expect(outboxItem.record.id).toBe("outbox-id")
      expect(outboxItem.record.occurredAt).toBe(fixedDate)
    }
  })

  it("commits a durable post-commit obligation atomically with the mutation (P1-16)", async () => {
    const fixedDate = new Date("2026-01-02T03:04:05.000Z")
    const ids = ["operation-id"]
    let capturedItems: readonly AtomicBatchItem<string>[] = []
    const result = await runOperation({
      operation: createOperationContext({
        persistence: createAtomicProvider((items) => { capturedItems = items }),
        runtimeCapabilities: defaultRuntimeCaps,
        request: requestContext({ actorId: "user-1" }),
        idGenerator: () => ids.shift() ?? "unexpected-id",
        clock: { now: () => fixedDate },
      }),
      definition: {
        key: "durable-effect",
        atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => {
          operation.addDurableEffect({
            name: "notify-billing",
            outbox: {
              id: "durable-effect-id",
              type: "billing.invoice.generated",
              version: 1,
              scope: { kind: "platform", platformKey: "test" },
              scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never,
              tenantId: null,
              aggregateType: "billing",
              aggregateId: "invoice-1",
              payload: { amount: 100 },
              idempotencyKey: "durable:billing.invoice:invoice-1",
            },
          })
          return { commands: ["insert"], result: { id: "invoice-1" } }
        },
        audit: {
          action: "invoice.generated",
          resourceType: "billing",
          resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })

    expect(result).toEqual({ id: "invoice-1" })
    const outboxItem = capturedItems.find((item) => item.kind === "outbox")
    if (!outboxItem) throw new Error("Expected committed outbox obligation")
    expect(outboxItem.kind).toBe("outbox")
    if (outboxItem.kind === "outbox") {
      expect(outboxItem.record.type).toBe("billing.invoice.generated")
      expect(outboxItem.record.id).toBe("durable-effect-id")
      expect(outboxItem.record.occurredAt).toBe(fixedDate)
      expect(outboxItem.record.idempotencyKey).toBe("durable:billing.invoice:invoice-1")
    }
  })

  it("sanitizes PHI and secrets in atomic audit values before batch submission", async () => {
    let capturedItems: readonly AtomicBatchItem<string>[] = []
    const auditSanitizer = (value: unknown) => {
      const record = value as Record<string, unknown>
      return {
        ...record,
        patientName: "[REDACTED]",
        apiToken: "[REDACTED]",
      }
    }

    await runOperation({
      operation: createOperationContext({
        persistence: createAtomicProvider((items) => { capturedItems = items }),
        runtimeCapabilities: defaultRuntimeCaps,
        request: requestContext({ actorId: "user-1" }),
        auditSanitizer,
      }),
      definition: {
        key: "atomic-audit-sanitization",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({ commands: ["insert"], result: { id: "entity-1" } }),
        audit: {
          action: "entity.updated",
          resourceType: "entity",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
          extractOldValue: () => ({ patientName: "Asha Patient", apiToken: "old-secret", status: "draft" }),
          extractNewValue: () => ({ patientName: "Asha Patient", apiToken: "new-secret", status: "active" }),
        },
      },
      input: {},
    })

    const auditItem = capturedItems.find((item) => item.kind === "audit")
    expect(auditItem).toMatchObject({
      kind: "audit",
      record: {
        oldValue: { patientName: "[REDACTED]", apiToken: "[REDACTED]", status: "draft" },
        newValue: { patientName: "[REDACTED]", apiToken: "[REDACTED]", status: "active" },
      },
    })
    expect(JSON.stringify(auditItem)).not.toContain("Asha Patient")
    expect(JSON.stringify(auditItem)).not.toContain("secret")
  })

  it("uses a safe default when atomic audit values have no configured sanitizer", async () => {
    let capturedItems: readonly AtomicBatchItem<string>[] = []

    await runOperation({
      operation: createOperationContext({
        persistence: createAtomicProvider((items) => { capturedItems = items }),
        runtimeCapabilities: defaultRuntimeCaps,
        request: requestContext({ actorId: "user-1" }),
      }),
      definition: {
        key: "atomic-default-audit-sanitization",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({ commands: ["insert"], result: { id: "entity-1" } }),
        audit: {
          action: "entity.updated",
          resourceType: "entity",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
          extractNewValue: () => ({ patientName: "Asha Patient", apiToken: "raw-secret", status: "active" }),
        },
      },
      input: {},
    })

    const auditItem = capturedItems.find((item) => item.kind === "audit")
    expect(JSON.stringify(auditItem)).not.toContain("Asha Patient")
    expect(JSON.stringify(auditItem)).not.toContain("raw-secret")
    expect(auditItem).toMatchObject({ kind: "audit", record: { newValue: { patientName: "[redacted]", apiToken: "[redacted]", status: "active" } } })
  })

  it("runs after hooks after the batch commits and verifies only command results", async () => {
    const events: string[] = []
    let verifiedResults: readonly unknown[] = []
    const result = await runOperation({
      operation: createOperationContext({
        persistence: createAtomicProvider(() => { events.push("batch") }),
        runtimeCapabilities: defaultRuntimeCaps,
      }),
      definition: {
        key: "atomic-projection",
        atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => {
          operation.addCommand("first")
          return {
            commands: ["second"],
            result: { value: "projected" },
             verify: ({ commandResults }: { commandResults: readonly unknown[] }) => { verifiedResults = commandResults },
          }
        },
        after: ({ result: value }: { result: { value: string } }) => { events.push(`after:${value.value}`); return { value: "final" } },
      },
      input: {},
    })

    expect(events).toEqual(["batch", "after:projected"])
    expect(verifiedResults).toEqual(["first", "second"])
    expect(result).toEqual({ value: "final" })
  })

  it("verifies the prepared command projection and returns the after-transformed result", async () => {
    let verifiedResult: { value: string } | undefined

    const result = await runOperation({
      operation: createOperationContext({
        persistence: createAtomicProvider(() => {}),
        runtimeCapabilities: defaultRuntimeCaps,
      }),
      definition: {
        key: "atomic-prepared-result",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({
          commands: ["insert"],
          result: { value: "prepared" },
          verify: ({ result: value }: { result: { value: string } }) => { verifiedResult = value },
        }),
         after: ({ result: value }: { result: { value: string } }) => ({ value: `${value.value}-after` }),
      },
      input: {},
    })

    expect(result).toEqual({ value: "prepared-after" })
    expect(verifiedResult).toEqual({ value: "prepared" })
  })

  it("reports verification failure as committed after the batch succeeds", async () => {
    const executeAtomicBatch = vi.fn(async () => [{ kind: "command" as const, result: { ok: true } }])
    const provider = createAtomicProvider(() => {})
    provider.executeAtomicBatch = executeAtomicBatch

    await expect(runOperation({
      operation: createOperationContext({
        persistence: provider,
        runtimeCapabilities: defaultRuntimeCaps,
      }),
      definition: {
        key: "atomic-verification-failure",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({
          commands: ["insert"],
          result: { value: "prepared" },
          verify: () => { throw new Error("verification failed") },
        }),
      },
      input: {},
    })).rejects.toSatisfy((error: unknown) => error instanceof OperationCommittedEffectError && error.committed === true)

    expect(executeAtomicBatch).toHaveBeenCalledOnce()
  })

  it.each([
    ["fewer results", []],
    ["malformed result", [{ kind: "audit", result: {} }]],
  ])("reports %s as committed even without verification", async (_name, batchResults) => {
    const provider = createAtomicProvider(() => {})
    provider.executeAtomicBatch = async () => batchResults as AtomicBatchResult

    await expect(runOperation({
      operation: createOperationContext({ persistence: provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "atomic-incomplete-results",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({ commands: ["insert"], result: {} }),
      },
      input: {},
    })).rejects.toSatisfy((error: unknown) => error instanceof OperationCommittedEffectError && error.committed === true)
  })

  it("rejects malformed prepared verification semantics before commit", async () => {
    const executeAtomicBatch = vi.fn()
    const provider = createAtomicProvider(() => {})
    provider.executeAtomicBatch = async () => {
      executeAtomicBatch()
      return [{ kind: "command", result: undefined }]
    }

    await expect(runOperation({
      operation: createOperationContext({ persistence: provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "atomic-invalid-verifier",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({ commands: ["insert"], result: {}, verify: "not-a-function" as never }),
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })

  it("dispatches tenant-scoped atomic operations through the safe batch contract", async () => {
    let capturedItems: readonly AtomicBatchItem<string>[] = []
    const atomicBase = createAtomicProvider((items) => { capturedItems = items })
    const scoped = createTenantScopedPersistenceProvider(
      Object.assign(atomicBase, {
        createTenantScopedCommandEncoder: () => ({ tenantId: "tenant-a", encode: (command: string) => `${command}:tenant-a` }),
      }),
      "tenant-a",
    )
    const result = await runOperation({
      operation: createOperationContext({
        persistence: scoped,
        runtimeCapabilities: defaultRuntimeCaps,
        request: requestContext({ actorId: "user-1", tenantId: "tenant-a" }),
      }),
      definition: {
        key: "tenant-atomic",
        atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => {
          operation.addOutboxRecord({
            id: "outbox-1",
            occurredAt: new Date("2026-01-01T00:00:00.000Z"),
            type: "row.created",
            version: 1,
            scope: { kind: "platform", platformKey: "test" },
            scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never,
            aggregateType: "row",
            aggregateId: "row-1",
            payload: {},
            idempotencyKey: "row-1",
          })
          return { commands: ["insert"], result: { ok: true } }
        },
      },
      input: {},
    })

    expect(result).toEqual({ ok: true })
    expect(capturedItems[0]).toEqual({ kind: "command", command: "insert:tenant-a" })
    expect(capturedItems[1]).toMatchObject({ kind: "outbox", record: { tenantId: "tenant-a" } })
  })

  it("rejects a direct tenant-scoped provider without an adapter-owned capability", async () => {
    const provider = {
      ...createAtomicProvider(() => {}),
      capabilities: { ...createAtomicProvider(() => {}).capabilities, atomicBatch: true, atomicBatchScope: "tenant-scoped" as const },
    } as unknown as TenantScopedAtomicBatchProvider<string>

    await expect(runOperation({
      operation: createOperationContext({
        persistence: provider,
        runtimeCapabilities: defaultRuntimeCaps,
         request: requestContext({ tenantId: "tenant-b" }),
      }),
      definition: {
        key: "direct-tenant-atomic",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({ commands: ["insert"], result: {} }),
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
  })

  it("rejects a tenant-scoped encoder from another tenant or provider", async () => {
    const scoped = createTenantScopedPersistenceProvider(
      Object.assign(createAtomicProvider(() => {}), {
        createTenantScopedCommandEncoder: () => ({ tenantId: "tenant-a", encode: (command: string) => command }),
      }),
      "tenant-a",
    )

    await expect(runOperation({
      operation: createOperationContext({
        persistence: scoped,
        runtimeCapabilities: defaultRuntimeCaps,
         request: requestContext({ tenantId: "tenant-b" }),
      }),
      definition: {
        key: "mismatched-tenant-atomic",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({ commands: ["insert"], result: {} }),
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
  })

  it("rejects effects from the post-commit atomic after hook", async () => {
    await expect(runOperation({
      operation: createOperationContext({ persistence: createAtomicProvider(() => {}), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
         key: "atomic-no-post-commit-effects",
        atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => {
          // The preparation context exposes only the durable operation contract.
          operation.addBestEffortEffect("allowed", async () => {})
          return { commands: ["insert"], result: {} }
        },
        after: ({ operation, result }) => {
          // @ts-expect-error Representation hooks cannot register effects publicly.
          operation.addBestEffortEffect("forbidden", async () => {})
          // This hook intentionally returns the unchanged result after registering a forbidden effect.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return result
        },
      },
      input: {},
    })).rejects.toThrow(OperationCommittedEffectError)
  })

  it("rejects outbox registration from the post-commit phase", async () => {
    const provider = createAtomicProvider(() => {})
    const atomicAfterCommit: AtomicAfterCommitHook<Record<string, never>, Record<string, never>> = ({ operation }) => {
       expect(Reflect.get(operation, "addOutboxRecord")).toBeUndefined()
    }

    await runOperation({
      operation: createOperationContext({ persistence: provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "atomic-post-commit-outbox",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({ commands: ["insert"], result: {} }),
        afterCommit: [atomicAfterCommit],
      },
      input: {},
    })
  })

  it("keeps the committed result when afterCommit fails", async () => {
    const executeAtomicBatch = vi.fn()
    const atomicProvider = createAtomicProvider(() => {})
    atomicProvider.executeAtomicBatch = async (plan: AtomicBatchPlan<string>) => {
      executeAtomicBatch(plan)
      return [{ kind: "command", result: undefined }]
    }
    await expect(runOperation({
      operation: createOperationContext({
        persistence: atomicProvider,
        runtimeCapabilities: defaultRuntimeCaps,
      }),
      definition: {
        key: "atomic-after-commit-failure",
        atomicity: { kind: "atomic-batch" },
        prepare: () => ({ commands: ["insert"], result: {} }),
        afterCommit: () => { throw new Error("effect failed") },
      },
      input: {},
    })).resolves.toEqual({})
    expect(executeAtomicBatch).toHaveBeenCalledOnce()
  })

  it("continues all atomic post-commit hooks and effects, then reports a committed failure", async () => {
    const events: string[] = []
    const failures: Array<{ phase: string; effectName: string }> = []
    const metadata: Record<string, unknown> = {}
    const ctx = createOperationContext({
      persistence: createAtomicProvider(() => {}),
      runtimeCapabilities: defaultRuntimeCaps,
      request: requestContext({ metadata }),
      telemetry: { emit: (event) => { if (event.name === "operation.effect.failure") failures.push({ phase: String(event.attributes.phase), effectName: String(event.attributes.effectName) }) } },
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "atomic-post-commit-failures",
        atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => {
            operation.addBestEffortEffect("effect-1", async (root: PostCommitContext | undefined) => {
            events.push("effect-1")
             expect(root).not.toHaveProperty("persistence")
            throw new Error("effect-1 failed")
          })
          return { commands: ["insert"], result: {} }
        },
        afterCommit: [
            async ({ operation }: { operation: PostCommitContext; input: Record<string, never>; result: Record<string, never> }) => {
            events.push("hook-1")
             operation.addBestEffortEffect("effect-2", async (root) => {
              events.push("effect-2")
               expect(root).not.toHaveProperty("persistence")
              throw new Error("effect-2 failed")
            })
            throw new Error("hook-1 failed")
          },
          async () => { events.push("hook-2") },
        ],
      },
      input: {},
    })).resolves.toEqual({})

    expect(events).toEqual(["hook-1", "hook-2", "effect-1", "effect-2"])
    expect(failures).toEqual([
      { phase: "afterCommit", effectName: "hooks" },
       { phase: "bestEffort", effectName: "effect-1" },
       { phase: "bestEffort", effectName: "effect-2" },
    ])
  })

  it("drains effects registered while atomic post-commit and best-effort effects execute", async () => {
    const events: string[] = []
    const ctx = createOperationContext({
      persistence: createAtomicProvider(() => {}),
      runtimeCapabilities: defaultRuntimeCaps,
    })

    await runOperation({
      operation: ctx,
      definition: {
        key: "atomic-dynamic-effect-registration",
        atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => {
            operation.addBestEffortEffect("post-1", async (root: PostCommitContext | undefined) => {
             events.push("post-1")
             expect(Reflect.get(root ?? {}, "addOutboxRecord")).toBeUndefined()
             expect(Reflect.get(root ?? {}, "enforceAbac")).toBeUndefined()
             root?.addBestEffortEffect("best-2", async () => { events.push("best-2") })
               root?.addBestEffortEffect("best-1", async (bestEffortRoot: PostCommitContext | undefined) => {
               events.push("best-1")
               expect(Reflect.get(bestEffortRoot ?? {}, "addOutboxRecord")).toBeUndefined()
               expect(Reflect.get(bestEffortRoot ?? {}, "enforceAbac")).toBeUndefined()
               bestEffortRoot?.addBestEffortEffect("best-3", async () => { events.push("best-3") })
            })
          })
          return { commands: ["insert"], result: {} }
        },
      },
      input: {},
    })

      expect(events).toEqual(["post-1", "best-2", "best-1", "best-3"])
  })
})

describe("audit modes", () => {
  function auditCtx(overrides?: Partial<Parameters<typeof createOperationContext>[0]>) {
    return createOperationContext({
     persistence: createTxProvider(),
      runtimeCapabilities: defaultRuntimeCaps,
      ...overrides,
    })
  }

  it("writes audit record directly in transactional mode", async () => {
    const write = vi.fn()
    const sink: AuditSink = { write }
    const auditSinkFactory = { create: () => sink }

    await runOperation({
      operation: auditCtx({
        persistence: createTxProvider(),
        request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
        auditSinkFactory,
      }),
      definition: {
        key: "tx-audit",
        atomicity: { kind: "standard", mode: "required" },
        execute: async () => ({ id: "ent-1" }),
        audit: {
          action: "entity.created",
          resourceType: "entity",
           auditGuarantee: "atomic",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      action: "entity.created",
      resourceType: "entity",
      resourceId: "ent-1",
      actor: expect.objectContaining({ id: "user-1", kind: "human" }),
    }))
  })

  it("fails the operation when a required transaction-bound audit sink fails", async () => {
    const write = vi.fn(async () => { throw new Error("audit sink unavailable") })

    await expect(runOperation({
      operation: auditCtx({
        request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
        auditSinkFactory: { create: () => ({ write }) },
      }),
      definition: {
        key: "required-audit-failure",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true }) },
        execute: async () => ({ id: "ent-1" }),
        audit: {
          required: true,
          action: "entity.created",
          resourceType: "entity",
          auditGuarantee: "atomic",
          resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })).rejects.toThrow("audit sink unavailable")
    expect(write).toHaveBeenCalledOnce()
  })

  it("throws ConfigurationError when transactional audit used without transaction support", async () => {
    await expect(runOperation({
      operation: auditCtx({
        persistence: createNoTxProvider(),
        request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
        auditSinkFactory: { create: () => ({ write: vi.fn() }) },
      }),
      definition: {
        key: "tx-audit-no-tx",
        execute: async () => ({ id: "ent-1" }),
        audit: {
          action: "entity.created",
          resourceType: "entity",
           auditGuarantee: "atomic",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
  })

  it("throws ConfigurationError when outbox audit mode used without transaction support and no fallback", async () => {
    const ctx = auditCtx({
      persistence: createNoTxProvider(),
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
      outboxSinkFactory: { create: () => ({ append: vi.fn() }) },
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "outbox-audit",
        execute: async () => ({ id: "ent-1" }),
        audit: {
          action: "entity.updated",
          resourceType: "entity",
           auditGuarantee: "durable",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
  })

  it("adds outbox entry in outbox audit mode with transactional provider", async () => {
    const append = vi.fn()
    const ctx = auditCtx({
      persistence: createTxProvider(),
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
      outboxSinkFactory: { create: () => ({ append }) },
    })

    await runOperation({
      operation: ctx,
      definition: {
        key: "outbox-audit-tx",
        atomicity: { kind: "standard", mode: "required" },
        execute: async () => ({ id: "ent-1" }),
        audit: {
          action: "entity.updated",
          resourceType: "entity",
           auditGuarantee: "durable",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })

    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ type: "framework.audit.write" }))
  })

  it("rejects durable mutation audit fallback without required atomicity", async () => {
    const write = vi.fn()
    const ctx = auditCtx({
      persistence: createNoTxProvider(),
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
      auditSink: { write },
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "outbox-fallback-be",
        execute: async () => ({ id: "ent-1" }),
        audit: {
          action: "entity.updated",
          resourceType: "entity",
           auditGuarantee: "durable",
           fallbackAuditGuarantee: "best-effort",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
    expect(write).not.toHaveBeenCalled()
  })

  it("registers best-effort notification in best-effort audit mode (default)", async () => {
    const write = vi.fn()
    const ctx = auditCtx({
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
      auditSink: { write },
    })

    await runOperation({
      operation: ctx,
      definition: {
        key: "be-audit",
        execute: async () => ({ id: "ent-1" }),
        audit: {
          action: "entity.deleted",
          resourceType: "entity",
           auditGuarantee: "best-effort",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })

    expect(write).toHaveBeenCalledTimes(1)
  })

  it("fails loudly when required audit configured but audit sink missing", async () => {
    await expect(runOperation({
      operation: auditCtx({
        request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
      }),
      definition: {
        key: "sink-missing",
        execute: async () => ({ id: "ent-1" }),
        audit: {
          action: "entity.created",
          resourceType: "entity",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })).rejects.toThrow(AuditSinkMissingError)
  })

  it("records the explicit anonymous principal instead of treating it as a missing identity", async () => {
    const write = vi.fn()
    await expect(runOperation({
      operation: auditCtx({
        request: requestContext({ requestId: "r1", correlationId: "c1" }),
        auditSink: { write },
      }),
      definition: {
        key: "actor-missing",
        execute: async () => ({ id: "ent-1" }),
        audit: {
          action: "entity.created",
          resourceType: "entity",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })).resolves.toEqual({ id: "ent-1" })
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ kind: "anonymous", authentication: { kind: "anonymous" } }),
    }))
  })

  it("allows optional audit to no-op when audit sink missing", async () => {
    const ctx = auditCtx({
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "optional-audit",
        execute: async () => ({ id: "ent-1" }),
        audit: {
          required: false,
          action: "entity.created",
          resourceType: "entity",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })).resolves.toEqual({ id: "ent-1" })
  })

  it("extracts old and new values in audit record", async () => {
    const write = vi.fn()
    const sink: AuditSink = { write }
    const auditSinkFactory = { create: () => sink }

    await runOperation({
      operation: auditCtx({
        persistence: createTxProvider(),
        request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
        auditSinkFactory,
      }),
      definition: {
        key: "audit-values",
        atomicity: { kind: "standard", mode: "required" },
        execute: async () => ({ id: "ent-1", status: "active" }),
        audit: {
          action: "entity.updated",
          resourceType: "entity",
           auditGuarantee: "atomic",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
          extractOldValue: () => ({ status: "draft" }),
          extractNewValue: ({ result }) => ({ status: (result as { status: string }).status }),
        },
      },
      input: {},
    })

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      oldValue: { status: "draft" },
      newValue: { status: "active" },
    }))
  })

  it("defaults to best-effort audit when no guarantee is specified", async () => {
    const write = vi.fn()
    const ctx = auditCtx({
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "user-1" }),
      auditSink: { write },
    })

    await runOperation({
      operation: ctx,
      definition: {
        key: "default-be",
        execute: async () => ({ id: "ent-1" }),
        audit: {
          action: "entity.created",
          resourceType: "entity",
           resolveResourceId: ({ result }: { result: { id: string } }) => result.id,
        },
      },
      input: {},
    })

    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe("transaction boundary", () => {
  it("retries the whole transaction before commit with a fresh effect scope", async () => {
    const provider = createTxProvider()
    let transactionCalls = 0
    const options = { isolationLevel: "serializable" as const, accessMode: "read write" as const }
    const seenOptions: typeof options[] = []
    provider.runInTransaction = async (fn, transactionOptions) => {
      transactionCalls += 1
      seenOptions.push(transactionOptions as typeof options)
      return fn(provider)
    }
    // P1-07: Retry is safe only when no transactional side effects were registered.
    // Use a pure retryable serialization failure without side effects.
     const execute = vi.fn(async (_args: { operation: ReadOperationContext }) => {
      if (execute.mock.calls.length === 1) throw new RetryablePersistenceError("serialization failure")
      return { ok: true }
    })
    const afterCommit = vi.fn()
    const operationIds: string[] = []
    const ctx = createOperationContext({
      persistence: provider,
      runtimeCapabilities: defaultRuntimeCaps,
      idGenerator: () => "operation-1",
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "retry-transaction",
         atomicity: { kind: "standard", mode: "required", transactionOptions: options }, execution: { kind: "retryable-transaction", maxAttempts: 2, delay: 0, backoff: 2, maxDelay: 0 },
        execute: async (args) => {
          operationIds.push(args.operation.operationId)
          return execute(args)
        },
        afterCommit,
      },
      input: {},
    })).resolves.toEqual({ ok: true })

    expect(transactionCalls).toBe(2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(operationIds).toEqual(["operation-1", "operation-1"])
    expect(afterCommit).toHaveBeenCalledOnce()
    expect(seenOptions).toEqual([options, options])
  })

  it("does not retry when the failed attempt registered durable work (P1-07)", async () => {
    const provider = createTxProvider()
    let transactionCalls = 0
    provider.runInTransaction = async (fn) => {
      transactionCalls += 1
      return fn(provider)
    }
    const execute = vi.fn(async ({ operation }: { operation: InternalOperationRunContext }) => {
      expect(Reflect.get(operation, "addDurableEffect")).toBeUndefined()
      throw new RetryablePersistenceError("serialization failure")
    })
    await expect(runOperation({
       operation: createOperationContext({ persistence: provider, runtimeCapabilities: defaultRuntimeCaps, outboxSinkFactory: { create: () => ({ append: async () => {} }) } }),
       definition: {
         key: "no-retry-with-side-effects",
         atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 3, delay: 0, backoff: 2, maxDelay: 0 },
        execute: async (args) => execute(args),
      },
      input: {},
    })).rejects.toThrow(RetryablePersistenceError)
    expect(transactionCalls).toBe(3)
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it("does not retry when the failed attempt registered outbox records (P1-07)", async () => {
    const provider = createTxProvider()
    let transactionCalls = 0
    provider.runInTransaction = async (fn) => {
      transactionCalls += 1
      return fn(provider)
    }
    const execute = vi.fn(async ({ operation }: { operation: InternalOperationRunContext }) => {
       expect(Reflect.get(operation, "addDurableEffect")).toBeUndefined()
       throw new RetryablePersistenceError("serialization failure")
    })
    await expect(runOperation({
      operation: createOperationContext({ persistence: provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "no-retry-with-outbox",
         atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 3, delay: 0, backoff: 2, maxDelay: 0 },
        execute: async (args) => execute(args),
      },
      input: {},
    })).rejects.toThrow(RetryablePersistenceError)
    expect(transactionCalls).toBe(3)
  })

  it("retries rolled-back attempts even with idempotency commit markers; the marker commits once (P1-07 revised)", async () => {
    const provider = createTxProvider()
    let transactionCalls = 0
    provider.runInTransaction = async (fn) => {
      transactionCalls += 1
      return fn(provider)
    }
    const markerCommit = vi.fn(async () => {})
    let calls = 0
    await expect(runOperation({
      operation: createOperationContext({
        persistence: provider,
        runtimeCapabilities: defaultRuntimeCaps,
        commitMarkers: [{ name: "idempotency", commit: markerCommit }],
      }),
      definition: {
        key: "retry-with-marker",
         atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 3, delay: 0, backoff: 2, maxDelay: 0 },
        execute: async () => { calls++; if (calls < 3) throw new RetryablePersistenceError("serialization failure"); return { ok: true } },
      },
      input: {},
    })).resolves.toEqual({ ok: true })
    expect(transactionCalls).toBe(3)
    expect(markerCommit).toHaveBeenCalledTimes(1)
  })

  it("does not retry non-retryable transaction failures", async () => {
    const provider = createTxProvider()
    let transactionCalls = 0
    provider.runInTransaction = async (fn) => {
      transactionCalls += 1
      return fn(provider)
    }

    await expect(runOperation({
      operation: createOperationContext({ persistence: provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "no-retry-business-failure",
         atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 3, delay: 0, backoff: 2, maxDelay: 0 },
        execute: async () => { throw new Error("not retryable") },
      },
      input: {},
    })).rejects.toThrow("not retryable")

    expect(transactionCalls).toBe(1)
  })

  it("does not retry a retryable provider error after the callback returns", async () => {
    const provider = createTxProvider()
    let transactionCalls = 0
    provider.runInTransaction = async (fn) => {
      transactionCalls += 1
      await fn(provider)
      throw new RetryablePersistenceError("commit outcome is unknown")
    }

    await expect(runOperation({
      operation: createOperationContext({ persistence: provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "no-retry-after-callback",
         atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 3, delay: 0, backoff: 2, maxDelay: 0 },
        execute: async () => ({ ok: true }),
      },
      input: {},
    })).rejects.toThrow("commit outcome is unknown")

    expect(transactionCalls).toBe(1)
  })

  it("rolls back on execute failure when using transactional provider", async () => {
    const rollbackCtx = createRollbackTxProvider()
    const ctx = createOperationContext({ persistence: rollbackCtx.provider, runtimeCapabilities: defaultRuntimeCaps })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "rollback-execute",
        atomicity: { kind: "standard", mode: "required" },
        execute: async () => { throw new Error("execute failed") },
      },
      input: {},
    })).rejects.toThrow("transaction failed")

    expect(rollbackCtx.rolledBack).toBe(true)
    expect(rollbackCtx.committed).toBe(false)
  })

  it("rolls back on after hook failure when using transactional provider", async () => {
    const rollbackCtx = createRollbackTxProvider()
    const ctx = createOperationContext({ persistence: rollbackCtx.provider, runtimeCapabilities: defaultRuntimeCaps })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "rollback-after",
        atomicity: { kind: "standard", mode: "required" },
        execute: async () => ({ ok: true }),
        after: () => { throw new Error("after failed") },
      },
      input: {},
    })).rejects.toThrow("transaction failed")

    expect(rollbackCtx.rolledBack).toBe(true)
    expect(rollbackCtx.committed).toBe(false)
  })
})

describe("before hook", () => {
  it("transforms input and passes transformed value to execute", async () => {
    const result = await runOperation({
       operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "transform-input",
        before: () => ({ transformed: true, original: "value" }),
         execute: async ({ input }) => {
            // Compact fixtures are normalized by the test boundary above.
           // eslint-disable-next-line @typescript-eslint/no-unsafe-return
           return input
         },
      },
      input: { original: "value", transformed: true },
    })

    expect(result).toEqual({ transformed: true, original: "value" })
  })

  it("preserves input when before hook returns undefined", async () => {
    const result = await runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "no-transform",
        before: () => {},
         execute: async ({ input }) => {
            // Compact fixtures are normalized by the test boundary above.
           // eslint-disable-next-line @typescript-eslint/no-unsafe-return
           return input
         },
      },
      input: { key: "val" },
    })

    expect(result).toEqual({ key: "val" })
  })

  it("supports multiple before hooks as array", async () => {
    const events: string[] = []

    await runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "multi-before",
        before: [
          () => { events.push("before1"); return {} },
          () => { events.push("before2"); return {} },
        ],
        execute: async () => { events.push("execute"); return {} },
      },
      input: {},
    })

    expect(events).toEqual(["before1", "before2", "execute"])
  })
})

describe("after hook", () => {
  it("transforms result and passes transformed value to caller", async () => {
    const result = await runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "transform-result",
        execute: async () => ({ count: 5 }),
         after: ({ result }: { result: { count: number } }) => ({ count: result.count + 1 }),
      },
      input: {},
    })

    expect(result).toEqual({ count: 6 })
  })

  it("preserves result when after hook returns undefined", async () => {
    const result = await runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "no-transform-after",
        execute: async () => ({ ok: true }),
        after: () => {},
      },
      input: {},
    })

    expect(result).toEqual({ ok: true })
  })

  it("supports multiple after hooks as array", async () => {
    const events: string[] = []

    await runOperation({
      operation: createOperationContext({ persistence: createNoTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "multi-after",
        execute: async () => { events.push("execute"); return {} },
        after: [
          () => { events.push("after1"); return {} },
          () => { events.push("after2"); return {} },
        ],
      },
      input: {},
    })

    expect(events).toEqual(["execute", "after1", "after2"])
  })
})

describe("lifecycle event ordering", () => {
  it("follows correct event ordering: BEGIN, MUTATION, AUDIT, OUTBOX, COMMIT, AFTER_COMMIT", async () => {
    const events: string[] = []
    const auditWrite = vi.fn().mockImplementation(() => { events.push("AUDIT") })
    const auditSinkFactory = { create: () => ({ write: auditWrite }) }
    const outboxAppend = vi.fn().mockImplementation(() => { events.push("OUTBOX") })
    const outboxSinkFactory = { create: () => ({ append: outboxAppend }) }

    const txProvider: InteractiveTransactionProvider = {
      ...createTxProvider(),
      async runInTransaction(fn) {
        const result = await fn(this)
        events.push("COMMIT")
        return result
      },
    }

    const ctx = createOperationContext({
      persistence: txProvider,
      runtimeCapabilities: defaultRuntimeCaps,
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "u1" }),
      auditSinkFactory,
      outboxSinkFactory,
    })

    await runOperation({
      operation: ctx,
      definition: {
        key: "event-ordering",
        atomicity: { kind: "standard", mode: "required" },
        before: () => { events.push("BEGIN"); return {} },
        execute: async ({ operation }) => {
          events.push("MUTATION")
           operation.addDurableEffect({ name: "event-outbox", outbox: {
             id: "",
             type: "test", version: 1, tenantId: null,
             scope: operation.request!.scope, scopeId: operation.request!.scopeId,
             aggregateType: "test", aggregateId: "1",
             payload: {}, idempotencyKey: "k1", occurredAt: new Date(),
           } })
          return { ok: true }
        },
        after: () => { events.push("AFTER"); return { ok: true } },
        audit: {
          action: "entity.created", resourceType: "entity",
           auditGuarantee: "atomic",
          resolveResourceId: () => "ent-1",
        },
        afterCommit: [() => { events.push("AFTER_COMMIT") }],
      },
      input: {},
    })

    expect(events).toEqual(["BEGIN", "MUTATION", "AFTER", "AUDIT", "OUTBOX", "COMMIT", "AFTER_COMMIT"])
  })
})

describe("audit failure rollback", () => {
  it("rolls back transaction when transactional audit write fails", async () => {
    const rollbackCtx = createRollbackTxProvider()
    const auditWrite = vi.fn().mockRejectedValue(new Error("audit write failed"))
    const auditSinkFactory = { create: () => ({ write: auditWrite }) }

    const ctx = createOperationContext({
      persistence: rollbackCtx.provider,
      runtimeCapabilities: defaultRuntimeCaps,
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "u1" }),
      auditSinkFactory,
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "audit-fail-rollback",
        atomicity: { kind: "standard", mode: "required" },
        execute: async () => ({ ok: true }),
        audit: {
          action: "entity.created",
          resourceType: "entity",
           auditGuarantee: "atomic",
          resolveResourceId: () => "ent-1",
        },
      },
      input: {},
    })).rejects.toThrow()

    expect(rollbackCtx.rolledBack).toBe(true)
    expect(rollbackCtx.committed).toBe(false)
  })
})

describe("void result handling", () => {
  it("runs afterCommit hooks when execute returns void", async () => {
    const afterCommit = vi.fn()

    await runOperation({
      operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "void-result",
        execute: async () => {},
        afterCommit: [afterCommit],
      },
      input: {},
    })

    expect(afterCommit).toHaveBeenCalled()
  })
})

describe("operation pipeline branch outcomes", () => {
  it("uses the default authorization denial message and warns for preferred non-transactional work", async () => {
    const emit = vi.fn()
    await expect(runOperation({
      operation: createOperationContext({
        persistence: createNoTxProvider(),
        runtimeCapabilities: defaultRuntimeCaps,
        telemetry: { emit },
      }),
      definition: {
        key: "denied-preferred",
        atomicity: { kind: "standard", mode: "preferred" },
        authorization: { authorize: async () => ({ allowed: false }) },
        execute: async () => ({}),
      },
      input: {},
    })).rejects.toThrow("Operation is not allowed: denied-preferred")
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "operation.transaction.unavailable" }))
  })

  it("writes best-effort audit data with extracted values and records effect failures", async () => {
    const metadata: Record<string, unknown> = {}
    const failures: Array<{ phase: string; effectName: string }> = []
    const auditWrite = vi.fn(async () => { throw new Error("audit write failed") })
    const ctx = createOperationContext({
      persistence: createTxProvider(),
      runtimeCapabilities: defaultRuntimeCaps,
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "u1", metadata }),
      auditSink: { write: auditWrite },
      telemetry: { emit: (event) => { if (event.name === "operation.effect.failure") failures.push({ phase: String(event.attributes.phase), effectName: String(event.attributes.effectName) }) } },
    })
    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "best-effort-audit",
        audit: {
          action: "record.updated",
          resourceType: "record",
          resolveResourceId: () => "record-1",
          extractOldValue: () => ({ patientName: "private" }),
          extractNewValue: () => ({ status: "active" }),
        },
        execute: async () => ({ ok: true }),
      },
      input: {},
    })).resolves.toEqual({ ok: true })
    expect(auditWrite).toHaveBeenCalledOnce()
    expect(failures).toEqual([expect.objectContaining({ phase: "bestEffort", effectName: "audit-write" })])
  })

  it("rejects required audit and outbox configurations before executing", async () => {
     const noActor = createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps })
    await expect(runOperation({
      operation: noActor,
      definition: {
        key: "missing-actor",
        audit: { action: "record.read", resourceType: "record", resolveResourceId: () => "r" },
        execute: async () => ({}),
      },
      input: {},
    })).rejects.toThrow(AuditActorMissingError)

    const noOutbox = createOperationContext({
      persistence: createTxProvider(),
      runtimeCapabilities: defaultRuntimeCaps,
      request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "u1" }),
    })
    await expect(runOperation({
      operation: noOutbox,
      definition: {
        key: "missing-outbox",
        atomicity: { kind: "standard", mode: "required" },
        outbox: { required: true },
        execute: async () => ({}),
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
  })

  it("propagates configured transaction options to the persistence provider", async () => {
    const recorded = createOptionsRecordingTxProvider()

    await runOperation({
      operation: createOperationContext({ persistence: recorded.provider, runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "configured-transaction-options",
        atomicity: { kind: "standard", mode: "required", transactionOptions: { isolationLevel: "serializable", accessMode: "read write" } },
        execute: async () => ({}),
      },
      input: {},
    })

    expect(recorded.getOptions()).toEqual({ isolationLevel: "serializable", accessMode: "read write" })
  })

  it("allows explicitly optional audit without an actor or sink", async () => {
    await expect(runOperation({
       operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "optional-audit",
        audit: { action: "record.read", resourceType: "record", required: false, resolveResourceId: () => "r" },
        execute: async () => ({ ok: true }),
      },
      input: {},
    })).resolves.toEqual({ ok: true })
  })

  it("reports missing best-effort audit sinks for actors", async () => {
    await expect(runOperation({
      operation: createOperationContext({
         persistence: createTxProvider(),
        runtimeCapabilities: defaultRuntimeCaps,
        request: requestContext({ requestId: "r1", correlationId: "c1", actorId: "u1" }),
      }),
      definition: {
        key: "missing-audit-sink",
        audit: { action: "record.read", resourceType: "record", resolveResourceId: () => "r" },
        execute: async () => ({}),
      },
      input: {},
    })).rejects.toThrow(AuditSinkMissingError)
  })
})

describe("durable commit markers", () => {
  it("runs the marker inside the business transaction so ownership loss rolls back the mutation", async () => {
    const rollback = createRollbackTxProvider()
    const markerSeen: unknown[] = []
    const ctx = createOperationContext({
      persistence: rollback.provider,
      runtimeCapabilities: defaultRuntimeCaps,
      commitMarkers: [{
        name: "idempotency",
        commit: async (result, persistence) => {
          markerSeen.push({ result, persistence })
          throw new ConflictError("Idempotency ownership was lost before the mutation committed")
        },
      }],
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "tx-commit-marker-rollback",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true }) },
        execute: async () => ({ ok: true }),
      },
      input: {},
    })).rejects.toThrow("transaction failed")

    expect(rollback.rolledBack).toBe(true)
    expect(rollback.committed).toBe(false)
    expect(markerSeen).toHaveLength(1)
  })

  it("runs the fence before the atomic batch and aborts before anything commits", async () => {
    const executeAtomicBatch = vi.fn()
    const provider = createAtomicProvider(() => {})
    provider.executeAtomicBatch = async (plan) => {
      executeAtomicBatch(plan)
      return plan.items.map((item) => ({ kind: item.kind, result: "ok" }))
    }
    const ctx = createOperationContext({
      persistence: provider,
      runtimeCapabilities: defaultRuntimeCaps,
      commitMarkers: [{
        name: "idempotency",
        fence: async () => { throw new ConflictError("Idempotency ownership was lost before the mutation committed") },
      }],
    })

    await expect(runOperation({
      operation: ctx,
      definition: {
        key: "atomic-commit-marker-fence",
        atomicity: { kind: "atomic-batch" },
        prepare: async () => ({ commands: ["insert"], result: { ok: true } }),
      },
      input: {},
    })).rejects.toThrow("Idempotency ownership was lost")

    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })

  it("includes self-contained commit marker items in the atomic batch", async () => {
    let capturedItems: readonly AtomicBatchItem<string>[] = []
    const provider = createAtomicProvider((items) => { capturedItems = items })
    const ctx = createOperationContext({
      persistence: provider,
      runtimeCapabilities: defaultRuntimeCaps,
      commitMarkers: [{
        name: "idempotency",
        batchItem: (result) => ({ kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "f", token: "t", result } }),
      }],
    })

    const result = await runOperation({
      operation: ctx,
      definition: {
        key: "atomic-marker-batch-item",
        atomicity: { kind: "atomic-batch" },
        prepare: async () => ({ commands: ["insert"], result: { ok: true } }),
      },
      input: {},
    })

    expect(result).toEqual({ ok: true })
    const idempotencyItem = capturedItems.find((item) => item.kind === "idempotency")
    expect(idempotencyItem).toBeTruthy()
    if (idempotencyItem && idempotencyItem.kind === "idempotency") {
      expect(idempotencyItem.commit).toMatchObject({ scope: "s", key: "k", token: "t", result: { ok: true } })
    }
  })

  it("passes the transaction-scoped persistence to the in-transaction marker", async () => {
    let markerPersistence: unknown
    const provider = createTxProvider()
    const ctx = createOperationContext({
      persistence: provider,
      runtimeCapabilities: defaultRuntimeCaps,
      commitMarkers: [{
        name: "idempotency",
        commit: async (_result, persistence) => { markerPersistence = persistence },
      }],
    })

    await runOperation({
      operation: ctx,
      definition: {
        key: "tx-commit-marker-persistence",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true }) },
        execute: async () => ({ ok: true }),
      },
      input: {},
    })

    expect(markerPersistence).toBeTruthy()
  })
})

describe("P1-09/10/11 pipeline hardening", () => {
  it("executes best-effort effects in registration order (P1-09)", async () => {
    const order: string[] = []
    await runOperation({
      operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "tx-effect-order",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("first", async () => { order.push("first") })
          operation.addBestEffortEffect("second", async () => { order.push("second") })
          operation.addBestEffortEffect("third", async () => { order.push("third") })
          return {}
        },
      },
      input: {},
    })
    expect(order).toEqual(["first", "second", "third"])
  })

  it("persists outbox records in registration order before commit markers (P1-09)", async () => {
    const appended: string[] = []
    const provider = createTxProvider()
    const ctx = createOperationContext({
      persistence: provider,
      runtimeCapabilities: defaultRuntimeCaps,
      outboxSinkFactory: { create: () => ({ append: async (r: { type: string }) => { appended.push(r.type) } }) },
      commitMarkers: [{ name: "m1", commit: async () => { appended.push("marker") } }],
    })
    await runOperation({
      operation: ctx,
      definition: {
        key: "outbox-order",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
           operation.addDurableEffect({ name: "a", outbox: { type: "a", version: 1, tenantId: null, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never, aggregateType: "x", aggregateId: "1", payload: {}, idempotencyKey: "k1" } })
           operation.addDurableEffect({ name: "b", outbox: { type: "b", version: 1, tenantId: null, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never, aggregateType: "x", aggregateId: "2", payload: {}, idempotencyKey: "k2" } })
          return {}
        },
      },
      input: {},
    })
    expect(appended).toEqual(["a", "b", "marker"])
  })

  it("does not warn for best-effort effects without an outbox sink", async () => {
    await runOperation({
      operation: createOperationContext({
        persistence: createTxProvider(),
        runtimeCapabilities: defaultRuntimeCaps,
      }),
      definition: {
        key: "standard-post-commit-warn",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("notify", async () => {})
          return {}
        },
      },
      input: {},
    })
  })

  it("does not warn for atomic best-effort effects without an outbox sink", async () => {
    await runOperation({
      operation: createOperationContext({
        persistence: createAtomicProvider(() => {}),
        runtimeCapabilities: defaultRuntimeCaps,
      }),
      definition: {
        key: "atomic-post-commit-warn",
        atomicity: { kind: "atomic-batch" },
        prepare: ({ operation }) => {
          operation.addBestEffortEffect("notify", async () => {})
          return { commands: ["insert"], result: {} }
        },
      },
      input: {},
    })
  })

  it("does not warn when post-commit effects have durable outbox sink", async () => {
    await runOperation({
      operation: createOperationContext({
        persistence: createTxProvider(),
        runtimeCapabilities: defaultRuntimeCaps,
        outboxSinkFactory: { create: () => ({ append: async () => {} }) },
      }),
      definition: {
        key: "standard-post-commit-durable",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("notify", async () => {})
          return {}
        },
      },
      input: {},
    })
  })

  it("runs post-commit effects in registration order before best-effort (P1-11)", async () => {
    const order: string[] = []
    await runOperation({
      operation: createOperationContext({ persistence: createTxProvider(), runtimeCapabilities: defaultRuntimeCaps }),
      definition: {
        key: "post-commit-order",
        atomicity: { kind: "standard", mode: "required" },
        execute: async ({ operation }) => {
          operation.addBestEffortEffect("p1", async () => { order.push("p1") })
          operation.addBestEffortEffect("p2", async () => { order.push("p2") })
          operation.addBestEffortEffect("b1", async () => { order.push("b1") })
          return {}
        },
      },
      input: {},
    })
    expect(order).toEqual(["p1", "p2", "b1"])
  })
})
