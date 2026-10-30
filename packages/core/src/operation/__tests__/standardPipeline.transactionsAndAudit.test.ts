import { describe, expect, it, vi } from "vitest"
import { runOperation, runOperationDetailed } from "../operationPipeline"
import { createOperationContext } from "../operationContext"
import { createExecutionDeadline } from "../deadline"
import {
  AuditSinkMissingError,
  ConfigurationError,
  OutboxSinkMissingError,
  RetryablePersistenceError,
  RuntimeCapabilityError,
  ValidationError,
  createAnonymousPrincipal,
  encodeExecutionScopeId,
  type Principal,
  type RequestContext,
} from "../../domain"
import { TransactionRolledBackError } from "../../domain/errors"
import type { InteractiveTransactionProvider, PersistenceProvider, TransactionOptions } from "../../persistence/provider"
import type { RuntimeCapabilities } from "../../bootstrap/runtimeCapabilities"
import { createAuthorizedExecutionPlan } from "../../security"

const baseCapabilities = {
  interactiveTransactions: true, atomicBatch: false, returningInsert: false, readSessions: false,
  jsonQueries: false, exactDecimal: false, persistentConnection: false,
  maxPageSize: 100, maxBindParams: 100, maxStatementBytes: 100_000,
}

function txProvider(extraCapabilities: Record<string, unknown> = {}): InteractiveTransactionProvider {
  const self: InteractiveTransactionProvider = {
    dialect: "memory",
    capabilities: { ...baseCapabilities, ...extraCapabilities } as InteractiveTransactionProvider["capabilities"],
    repository: () => { throw new Error("not used") },
    runInTransaction: async (work) => work(self),
  }
  return self
}

function recordingProvider(extraCapabilities: Record<string, unknown> = {}) {
  const calls: Array<TransactionOptions | undefined> = []
  const self: InteractiveTransactionProvider = {
    dialect: "memory",
    capabilities: { ...baseCapabilities, ...extraCapabilities } as InteractiveTransactionProvider["capabilities"],
    repository: () => { throw new Error("not used") },
    runInTransaction: (async (work: (scoped: InteractiveTransactionProvider) => Promise<unknown>, options?: TransactionOptions) => {
      calls.push(options)
      return work(self)
    }) as InteractiveTransactionProvider["runInTransaction"],
  }
  return { provider: self, calls }
}

function plainProvider(): PersistenceProvider {
  return {
    dialect: "memory",
    capabilities: { ...baseCapabilities, interactiveTransactions: false } as PersistenceProvider["capabilities"],
    repository: () => { throw new Error("not used") },
  }
}

const runtimeCapabilities: RuntimeCapabilities = { deferredExecution: true, cache: true }
const allow = { authorize: async () => ({ allowed: true }) }
const fixedNow = new Date("2026-09-10T00:00:00.000Z")

function requestContext(args: { actorId?: string; tenantId?: string } = {}): RequestContext {
  const actor: Principal = args.actorId
    ? { id: args.actorId, kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
    : createAnonymousPrincipal()
  const scope = args.tenantId
    ? { kind: "tenant", tenantId: args.tenantId } as const
    : { kind: "application", applicationKey: "operation-tests" } as const
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
        source: { kind: "route", routeKey: "operation-test" },
        target: { scope, scopeId: encodeExecutionScopeId(scope) },
        purpose: "operation-test",
        reason: "test fixture",
        issuedAt: "2026-09-10T00:00:00.000Z",
        policy: { policyKey: "operation-test", policyVersion: 1, policyDigest: "test", evaluatedAt: "2026-09-10T00:00:00.000Z", authorizationModel: "snapshot" },
        delegationChain: [],
        impersonation: { kind: "none" },
      },
    },
    route: { routeKey: "operation-test", definitionVersion: 1, operationKey: "m" },
    signal: new AbortController().signal,
  } as never
}

function environment(overrides: Record<string, unknown> = {}) {
  return createOperationContext({
    persistence: txProvider(),
    runtimeCapabilities,
    request: requestContext({ actorId: "user-1", tenantId: "tenant-1" }),
    clock: { now: () => fixedNow },
    idGenerator: () => "id-1",
    ...overrides,
  } as never)
}

function mutation(extra: Record<string, unknown> = {}): never {
  return {
    key: "m", kind: "mutation", authorization: allow,
    atomicity: { kind: "standard", mode: "required" },
    execute: async () => ({ ok: true }),
    ...extra,
  } as never
}

function read(extra: Record<string, unknown> = {}): never {
  return { key: "m", kind: "read", execute: async () => ({ value: 1 }), ...extra } as never
}

describe("transaction support and capabilities", () => {
  it("rejects required atomicity and transaction execution without interactive transactions", async () => {
    await expect(runOperation({ operation: environment({ persistence: plainProvider() }), definition: mutation(), input: {} })).rejects.toThrow(
      new ConfigurationError("Operation m requires interactive transactions."),
    )
    await expect(runOperation({
      operation: environment({ persistence: plainProvider() }),
      definition: read({ atomicity: { kind: "standard", mode: "preferred" }, execution: { kind: "transaction" } }),
      input: {},
    })).rejects.toThrow(new ConfigurationError("Operation m requires interactive transaction execution."))
  })

  it("requires every declared runtime capability", async () => {
    await expect(runOperation({
      operation: environment({ runtimeCapabilities: { deferredExecution: true, cache: false } }),
      definition: read({ requiredRuntimeCapabilities: ["cache"] }),
      input: {},
    })).rejects.toThrow(RuntimeCapabilityError)
  })

  it("reports preferred operations that run without a transaction", async () => {
    const emit = vi.fn()
    await expect(runOperation({
      operation: environment({ persistence: plainProvider(), telemetry: { emit } }),
      definition: read({ atomicity: { kind: "standard", mode: "preferred" } }),
      input: {},
    })).resolves.toEqual({ value: 1 })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ name: "operation.transaction.unavailable", severity: "warn" }))
  })

  it("does not open a transaction for operations without atomicity", async () => {
    const { provider, calls } = recordingProvider()
    await expect(runOperation({ operation: environment({ persistence: provider }), definition: read(), input: {} })).resolves.toEqual({ value: 1 })
    expect(calls).toHaveLength(0)
  })

  it("opens read-only transactions for reads and forwards mutation transaction options", async () => {
    const { provider, calls } = recordingProvider()
    await runOperation({ operation: environment({ persistence: provider }), definition: read({ atomicity: { kind: "standard", mode: "required" } }), input: {} })
    expect(calls[0]).toEqual({ accessMode: "read only" })
    await runOperation({
      operation: environment({ persistence: provider }),
      definition: mutation({ atomicity: { kind: "standard", mode: "required", transactionOptions: { isolationLevel: "serializable" } } }),
      input: {},
    })
    expect(calls[1]).toEqual({ isolationLevel: "serializable" })
  })

  it("bounds transactions by the remaining deadline only when the provider can enforce it", async () => {
    const deadline = createExecutionDeadline(new Date(fixedNow.getTime() + 5_000))
    const timed = recordingProvider({ transactionTimeouts: true })
    await runOperation({ operation: environment({ persistence: timed.provider, deadline }), definition: mutation(), input: {} })
    expect(timed.calls[0]).toEqual({ timeoutMs: 5_000 })

    await runOperation({
      operation: environment({ persistence: timed.provider, deadline }),
      definition: mutation({ atomicity: { kind: "standard", mode: "required", transactionOptions: { timeoutMs: 2_000 } } }),
      input: {},
    })
    expect(timed.calls[1]).toEqual({ timeoutMs: 2_000 })

    await runOperation({
      operation: environment({ persistence: timed.provider, deadline }),
      definition: mutation({ atomicity: { kind: "standard", mode: "required", transactionOptions: { timeoutMs: 9_000 } } }),
      input: {},
    })
    expect(timed.calls[2]).toEqual({ timeoutMs: 5_000 })

    const untimed = recordingProvider()
    await runOperation({ operation: environment({ persistence: untimed.provider, deadline }), definition: mutation(), input: {} })
    expect(untimed.calls[0]).toBeUndefined()
  })
})

describe("audit and outbox preflight", () => {
  it("rejects a required audit that would use best-effort delivery", async () => {
    await expect(runOperation({
      operation: environment(),
      definition: mutation({ audit: { action: "records.write", resourceType: "record", resolveResourceId: () => "r", required: true } }),
      input: {},
    })).rejects.toThrow(new ConfigurationError("Required audit cannot use best-effort delivery for operation m."))
  })

  it("requires a transactional audit sink factory for atomic audits", async () => {
    await expect(runOperation({
      operation: environment(),
      definition: mutation({ audit: { action: "records.write", resourceType: "record", resolveResourceId: () => "r", auditGuarantee: "atomic" } }),
      input: {},
    })).rejects.toThrow(new AuditSinkMissingError("Transactional audit sink missing for operation: records.write"))
  })

  it("requires an outbox sink for durable audits on required atomicity", async () => {
    await expect(runOperation({
      operation: environment(),
      definition: mutation({ audit: { action: "records.write", resourceType: "record", resolveResourceId: () => "r", auditGuarantee: "durable" } }),
      input: {},
    })).rejects.toThrow(new OutboxSinkMissingError("Outbox sink missing for operation: records.write"))
  })

  it("requires a best-effort audit sink for required-false best-effort audits only when they are required", async () => {
    await expect(runOperation({
      operation: environment(),
      definition: mutation({ audit: { action: "records.write", resourceType: "record", resolveResourceId: () => "r" } }),
      input: {},
    })).rejects.toThrow(new AuditSinkMissingError("Audit sink missing for operation: records.write"))
    await expect(runOperation({
      operation: environment(),
      definition: mutation({ audit: { action: "records.write", resourceType: "record", resolveResourceId: () => "r", required: false } }),
      input: {},
    })).resolves.toEqual({ ok: true })
    // required: false skips preflight, but the transactional write still needs its factory.
    await expect(runOperation({
      operation: environment(),
      definition: mutation({ audit: { action: "records.write", resourceType: "record", resolveResourceId: () => "r", auditGuarantee: "atomic", required: false } }),
      input: {},
    })).rejects.toThrow("Transactional audit sink factory missing.")
  })

  it("requires outbox audits to run on required atomicity", async () => {
    await expect(runOperation({
      operation: environment({ outboxSinkFactory: { create: () => ({ append: async () => undefined }) } }),
      definition: read({
        atomicity: { kind: "standard", mode: "preferred" },
        audit: { action: "records.write", resourceType: "record", resolveResourceId: () => "r", auditGuarantee: "durable", fallbackAuditGuarantee: "best-effort" },
      }),
      input: {},
    })).rejects.toThrow(new ConfigurationError("Outbox audit requires required standard atomicity: records.write"))
  })

  it("rejects durable audits without transactions unless explicitly allowed to fall back", async () => {
    await expect(runOperation({
      operation: environment({ persistence: plainProvider() }),
      definition: read({ audit: { action: "records.read", resourceType: "record", resolveResourceId: () => "r", auditGuarantee: "durable", fallbackAuditGuarantee: "best-effort" } }),
      input: {},
    })).rejects.toThrow(new ConfigurationError("Outbox audit requires interactive transactions."))
    await expect(runOperation({
      operation: environment({ persistence: plainProvider() }),
      definition: read({ audit: { action: "records.read", resourceType: "record", resolveResourceId: () => "r", auditGuarantee: "durable", fallbackAuditGuarantee: "best-effort", required: false } }),
      input: {},
    })).resolves.toEqual({ value: 1 })
  })

  it("requires an outbox sink and required atomicity for required outboxes", async () => {
    await expect(runOperation({ operation: environment(), definition: mutation({ outbox: { required: true } }), input: {} })).rejects.toThrow(
      new ConfigurationError("Required outbox needs a required standard atomicity and an outbox sink."),
    )
  })
})

describe("audit record construction", () => {
  it("writes a transactional audit record with extracted old and new values", async () => {
    const write = vi.fn(async (_record: unknown) => undefined)
    const create = vi.fn(() => ({ write }))
    const operation = environment({ auditSinkFactory: { create } })
    await runOperation({
      operation,
      definition: mutation({
        audit: {
          action: "records.update", resourceType: "record", resolveResourceId: ({ result }: { result: { ok: boolean } }) => `res-${String(result.ok)}`,
          auditGuarantee: "atomic",
          extractOldValue: ({ input }: { input: { id: string } }) => ({ previous: input.id }),
          extractNewValue: ({ result }: { result: { ok: boolean } }) => ({ current: result.ok }),
        },
        execute: async () => ({ ok: true }),
      }),
      input: { id: "old" },
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({
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

  it("records null values, a null tenant for application scope, and empty objects for missing extracts", async () => {
    const write = vi.fn(async (_record: unknown) => undefined)
    await runOperation({
      operation: environment({ request: requestContext({ actorId: "user-1" }), auditSinkFactory: { create: () => ({ write }) } }),
      definition: mutation({ audit: { action: "records.plain", resourceType: "record", resolveResourceId: () => "r", auditGuarantee: "atomic" } }),
      input: {},
    })
    expect(write.mock.calls[0]?.[0]).toMatchObject({ tenantId: null, oldValue: null, newValue: null })

    const writeEmpty = vi.fn(async (_record: unknown) => undefined)
    await runOperation({
      operation: environment({ auditSinkFactory: { create: () => ({ write: writeEmpty }) } }),
      definition: mutation({
        audit: {
          action: "records.empty", resourceType: "record", resolveResourceId: () => "r", auditGuarantee: "atomic",
          extractOldValue: () => undefined,
          extractNewValue: () => undefined,
        },
      }),
      input: {},
    })
    expect(writeEmpty.mock.calls[0]?.[0]).toMatchObject({ oldValue: {}, newValue: {} })
  })

  it("applies the configured audit sanitizer to extracted values", async () => {
    const write = vi.fn(async (_record: unknown) => undefined)
    await runOperation({
      operation: environment({
        auditSinkFactory: { create: () => ({ write }) },
        auditSanitizer: (value: Record<string, unknown>) => ({ ...value, sanitized: true }),
      }),
      definition: mutation({
        audit: {
          action: "records.sanitized", resourceType: "record", resolveResourceId: () => "r", auditGuarantee: "atomic",
          extractNewValue: () => ({ name: "n" }),
        },
      }),
      input: {},
    })
    expect(write.mock.calls[0]?.[0]).toMatchObject({ newValue: { name: "n", sanitized: true } })
  })

  it("queues an outbox audit record keyed by operation and action", async () => {
    const append = vi.fn(async (_record: unknown) => undefined)
    await runOperation({
      operation: environment({ outboxSinkFactory: { create: () => ({ append }) } }),
      definition: mutation({
        audit: { action: "records.outbox", resourceType: "record", resolveResourceId: () => "res-9", auditGuarantee: "durable" },
      }),
      input: {},
    })
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: "framework.audit.write",
      version: 1,
      tenantId: "tenant-1",
      aggregateType: "record",
      aggregateId: "res-9",
      idempotencyKey: expect.stringMatching(/^audit:.+:records\.outbox$/),
    }))
  })

  it("writes best-effort audit records after commit to the audit sink", async () => {
    const write = vi.fn(async (_record: unknown) => undefined)
    await runOperation({
      operation: environment({ auditSink: { write } }),
      definition: mutation({ audit: { action: "records.best", resourceType: "record", resolveResourceId: () => "res-b" } }),
      input: {},
    })
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ action: "records.best", resourceId: "res-b", id: "id-1" }))
  })
})

describe("transaction retry", () => {
  it("does not retry without a policy", async () => {
    const { provider, calls } = recordingProvider()
    let attempts = 0
    await expect(runOperation({
      operation: environment({ persistence: provider }),
      definition: mutation({ execute: async () => { attempts += 1; throw new RetryablePersistenceError("busy") } }),
      input: {},
    })).rejects.toThrow(RetryablePersistenceError)
    expect(attempts).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it("retries a rolled-back attempt until success within the attempt budget", async () => {
    let attempts = 0
    await expect(runOperation({
      operation: environment(),
      definition: mutation({
        execution: { kind: "retryable-transaction", maxAttempts: 3, delay: 0, backoff: 1, maxDelay: 0 },
        execute: async () => {
          attempts += 1
          if (attempts < 3) throw new RetryablePersistenceError("busy")
          return { ok: attempts }
        },
      }),
      input: {},
    })).resolves.toEqual({ ok: 3 })
    expect(attempts).toBe(3)
  })

  it("rethrows the last retryable error once the attempt budget is spent", async () => {
    let attempts = 0
    await expect(runOperation({
      operation: environment(),
      definition: mutation({
        execution: { kind: "retryable-transaction", maxAttempts: 2, delay: 0, backoff: 1, maxDelay: 0 },
        execute: async () => { attempts += 1; throw new RetryablePersistenceError(`busy-${attempts}`) },
      }),
      input: {},
    })).rejects.toThrow("busy-2")
    expect(attempts).toBe(2)
  })

  it("does not retry non-retryable errors even with a policy", async () => {
    let attempts = 0
    await expect(runOperation({
      operation: environment(),
      definition: mutation({
        execution: { kind: "retryable-transaction", maxAttempts: 4, delay: 0, backoff: 1, maxDelay: 0 },
        execute: async () => { attempts += 1; throw new ValidationError("bad input") },
      }),
      input: {},
    })).rejects.toThrow(ValidationError)
    expect(attempts).toBe(1)
  })

  it("retries after a commit-time rollback report", async () => {
    let commits = 0
    const tx = txProvider()
    tx.runInTransaction = async (work) => {
      const result = await work(tx)
      commits += 1
      if (commits === 1) throw new TransactionRolledBackError("serialization failure at commit")
      return result
    }
    await expect(runOperation({
      operation: environment({ persistence: tx }),
      definition: mutation({ execution: { kind: "retryable-transaction", maxAttempts: 2, delay: 0, backoff: 1, maxDelay: 0 } }),
      input: {},
    })).resolves.toEqual({ ok: true })
    expect(commits).toBe(2)
  })

  it("waits the capped, exponentially growing, jittered delay between attempts", async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0)
    try {
      let attempts = 0
      const run = runOperation({
        operation: environment(),
        definition: mutation({
          execution: { kind: "retryable-transaction", maxAttempts: 3, delay: 100, backoff: 3, maxDelay: 120 },
          execute: async () => { attempts += 1; if (attempts < 3) throw new RetryablePersistenceError("busy"); return { ok: attempts } },
        }),
        input: {},
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(49)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(2)
      // Second retry: min(120, 100 * 3) = 120, halved by the jitter floor at zero draw.
      await vi.advanceTimersByTimeAsync(59)
      expect(attempts).toBe(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(3)
      await expect(run).resolves.toEqual({ ok: 3 })
    } finally {
      randomSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe("execution flow", () => {
  it("rejects a plan whose dynamic facts need a revalidator that the operation lacks", async () => {
    const operationPlan = createAuthorizedExecutionPlan({
      identity: { actor: { id: "user-1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }, subject: { id: "user-1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } } },
      scope: { kind: "application", applicationKey: "operation-tests" }, action: "records.write", operationKind: "mutation",
      readableFields: new Set(["ok"]), writableFields: new Set(["status"]), obligations: [],
      dynamicFacts: [{ factKey: "membership", version: "1", observedAt: "2026-09-10T00:00:00.000Z", revalidation: { kind: "transaction-check", checkKey: "membership" } }],
      policy: { key: "policy", version: 1, digest: "a".repeat(64) },
    } as never)
    const authorization = { authorize: async () => ({ allowed: true, plan: operationPlan }) }
    await expect(runOperation({
      operation: environment({ request: requestContext({ actorId: "user-1" }) }),
      definition: mutation({ authorization }),
      input: {},
    })).rejects.toThrow(new ConfigurationError("Authorization plan requires a dynamic-fact revalidator."))

    const revalidate = vi.fn(async () => true)
    await expect(runOperation({
      operation: environment({ request: requestContext({ actorId: "user-1" }), authorizationFactRevalidator: { revalidate } }),
      definition: mutation({ authorization }),
      input: {},
    })).resolves.toEqual({ ok: true })
    expect(revalidate).toHaveBeenCalledWith(expect.objectContaining({ operationId: expect.any(String) }))
  })

  it("masks the result under the authorization plan obligations", async () => {
    const readPlan = createAuthorizedExecutionPlan({
      identity: { actor: { id: "user-1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }, subject: { id: "user-1", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } } },
      scope: { kind: "application", applicationKey: "operation-tests" }, action: "records.read", operationKind: "read",
      readableFields: new Set(["value", "secret"]), writableFields: new Set(), obligations: [{ kind: "mask", field: "secret", strategy: "redact" }],
      dynamicFacts: [], policy: { key: "policy", version: 1, digest: "a".repeat(64) },
    } as never)
    await expect(runOperation({
      operation: environment({ request: requestContext({ actorId: "user-1" }) }),
      definition: read({
        authorization: { authorize: async () => ({ allowed: true, plan: readPlan }) },
        execute: async () => ({ value: 1, secret: "s3cr3t" }),
      }),
      input: {},
    })).resolves.toEqual({ value: 1, secret: "[REDACTED]" })
  })

  it("runs commit markers with the final result before the transaction commits", async () => {
    const commit = vi.fn(async (_record: unknown) => undefined)
    const persistence = txProvider()
    await runOperation({
      operation: environment({ persistence, commitMarkers: [{ name: "fence", commit }, { name: "no-commit" }] }),
      definition: mutation({ execute: async () => ({ ok: "marked" }) }),
      input: {},
    })
    expect(commit).toHaveBeenCalledWith({ ok: "marked" }, expect.anything())
  })

  it("reports after-commit and business-result failures without failing the committed operation", async () => {
    const failures: Array<{ phase: string; effectName: string }> = []
    const onBusinessResult = vi.fn(async () => { throw new Error("business boom") })
    const detailed = await runOperationDetailed({
      operation: environment({ onCommittedEffectFailure: (failure: { phase: string; effectName: string }) => { failures.push({ phase: failure.phase, effectName: failure.effectName }) } }),
      definition: mutation({
        afterCommit: [async () => { throw new Error("after boom") }],
        execute: async () => ({ ok: true }),
      }),
      input: {},
      onBusinessResult,
    } as never)
    expect(detailed.result).toEqual({ ok: true })
    expect(onBusinessResult).toHaveBeenCalledTimes(1)
    expect(failures.map((failure) => failure.phase)).toEqual(expect.arrayContaining(["onBusinessResult", "afterCommit"]))
  })
})
