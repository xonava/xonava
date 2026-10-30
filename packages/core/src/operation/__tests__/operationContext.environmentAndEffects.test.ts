import { describe, expect, it, vi } from "vitest"
import {
  assertRequestBoundToOperation,
  createAuthorizationOperationContext,
  createMutationOperationContext,
  createOperationContext,
  createOperationRunContext,
  createPostCommitOperationContext,
  createReadOperationContext,
  createRepresentationContext,
  createRetryableOperationContext,
} from "../operationContext"
import { runOperation } from "../operationPipeline"
import { DEFAULT_EXECUTION_BUDGET } from "../executionBudget"
import { createExecutionDeadline } from "../deadline"
import { defaultAuditSanitizer } from "../../events/durability/audit"
import { ConfigurationError, RuntimeCapabilityError, createAnonymousPrincipal, encodeExecutionScopeId, type RequestContext } from "../../domain"
import type { PersistenceProvider } from "../../persistence/provider"
import type { RuntimeCapabilities } from "../../bootstrap/runtimeCapabilities"

const capabilities = {
  interactiveTransactions: false, atomicBatch: false, returningInsert: false, readSessions: false,
  jsonQueries: false, exactDecimal: false, persistentConnection: false,
  maxPageSize: 100, maxBindParams: 100, maxStatementBytes: 100_000,
} as const
const persistence = { dialect: "memory", capabilities, repository: () => { throw new Error("unused") } } as unknown as PersistenceProvider
const enabled: RuntimeCapabilities = { deferredExecution: true, cache: true }
const fixedNow = new Date("2026-09-10T00:00:00.000Z")
const clock = { now: () => fixedNow }

function request(overrides: Record<string, unknown> = {}): RequestContext {
  const actor = createAnonymousPrincipal()
  const scope = { kind: "application", applicationKey: "ctx-tests" } as const
  return {
    requestId: "request-7",
    correlationId: "correlation-7",
    identity: { actor, subject: actor },
    scope,
    scopeId: encodeExecutionScopeId(scope),
    signal: new AbortController().signal,
    ...overrides,
  } as never
}

const contextScope = { kind: "application", applicationKey: "ctx-tests" } as const

function outbox(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope: contextScope, scopeId: encodeExecutionScopeId(contextScope), tenantId: null,
    aggregateType: "order", aggregateId: "o-1", payload: {}, idempotencyKey: "k-1",
    ...extra,
  }
}

function environment(overrides: Record<string, unknown> = {}) {
  return createOperationContext({ persistence, runtimeCapabilities: enabled, clock, idGenerator: () => "gen-1", ...overrides } as never)
}

describe("operation environment", () => {
  it("uses explicitly supplied services over the individual service arguments", () => {
    const explicitClock = { now: () => new Date("2030-01-01T00:00:00.000Z") }
    const env = environment({ services: { clock: explicitClock, idGenerator: () => "explicit", telemetry: undefined } })
    expect(env.services.clock).toBe(explicitClock)
    expect(env.services.idGenerator()).toBe("explicit")
    expect(Object.isFrozen(env.services)).toBe(true)
  })

  it("includes optional collaborators only when they are supplied", () => {
    const bare = environment()
    for (const key of ["request", "auditSink", "enforceAbac", "authorizationFactRevalidator", "auditSinkFactory", "outboxSinkFactory", "onCommittedEffectFailure", "maskingKey", "commitMarkers", "deadline"]) {
      expect(key in bare).toBe(false)
    }
    expect(bare.auditSanitizer).toBe(defaultAuditSanitizer)
    expect(bare.executionBudget).toEqual(DEFAULT_EXECUTION_BUDGET)
    expect(bare.nestingDepth).toBe(0)
    expect(bare.signal?.aborted).toBe(false)

    const auditSink = { write: async () => undefined }
    const onCommittedEffectFailure = () => undefined
    const full = environment({
      request: request(), auditSink, enforceAbac: {}, authorizationFactRevalidator: { revalidate: async () => true },
      auditSinkFactory: { create: () => auditSink }, outboxSinkFactory: { create: () => ({ append: async () => undefined }) },
      onCommittedEffectFailure, maskingKey: new Uint8Array(16), commitMarkers: [{ name: "fence" }],
      deadline: createExecutionDeadline(new Date(fixedNow.getTime() + 1_000)),
    })
    expect(full).toMatchObject({ auditSink, onCommittedEffectFailure, enforceAbac: {} })
    expect(full.request?.requestId).toBe("request-7")
    expect(full.maskingKey).toBeInstanceOf(Uint8Array)
    expect((full as unknown as { commitMarkers: unknown }).commitMarkers).toEqual([{ name: "fence" }])
    expect(full.deadline?.expiresAt.getTime()).toBe(fixedNow.getTime() + 1_000)
    expect("authorizationFactRevalidator" in full).toBe(true)
  })

  it("rejects an invalid execution budget", () => {
    expect(() => environment({ executionBudget: { maxDurationMs: -1 } })).toThrow()
  })

  it("derives identifiers from the request and the id generator", async () => {
    const seen = await runOperation({
      operation: environment({ request: request() }),
      definition: {
        key: "ctx-ids", kind: "read", execute: async ({ operation }: { operation: { operationId: string; correlationId?: string } }) => ({ operationId: operation.operationId, correlationId: operation.correlationId }),
      } as never,
      input: {},
    })
    expect(seen).toEqual({ operationId: "gen-1", correlationId: "correlation-7" })

    const withoutRequest = await runOperation({
      operation: environment(),
      definition: {
        key: "ctx-bare", kind: "read", execute: async ({ operation }: { operation: object }) => Object.keys(operation).sort(),
      } as never,
      input: {},
    })
    expect(withoutRequest).not.toContain("request")
    expect(withoutRequest).not.toContain("correlationId")
  })

  it("combines environment and request cancellation", () => {
    const envController = new AbortController()
    const requestController = new AbortController()
    const run = createOperationRunContext(environment({ signal: envController.signal, request: request({ signal: requestController.signal }) }))
    expect(run.signal.aborted).toBe(false)
    requestController.abort(new Error("request cancelled"))
    expect(run.signal.aborted).toBe(true)

    const second = new AbortController()
    const other = new AbortController()
    const secondRun = createOperationRunContext(environment({ signal: second.signal, request: request({ signal: other.signal }) }))
    second.abort(new Error("environment cancelled"))
    expect(secondRun.signal.aborted).toBe(true)
    expect(envController.signal.aborted).toBe(false)

    const pre = new AbortController()
    pre.abort(new Error("already"))
    const preRun = createOperationRunContext(environment({ request: request({ signal: pre.signal }) }))
    expect(preRun.signal.aborted).toBe(true)
  })

  it("never shortens the deadline with an invalid or later request deadline", () => {
    const budgetEnd = fixedNow.getTime() + DEFAULT_EXECUTION_BUDGET.maxDurationMs
    const later = createOperationRunContext(environment({ request: request({ deadline: "2030-01-01T00:00:00.000Z" }) }))
    expect(later.deadline.expiresAt.getTime()).toBe(budgetEnd)

    const invalid = createOperationRunContext(environment({ request: request({ deadline: "not-a-date" }) }))
    expect(invalid.deadline.expiresAt.getTime()).toBe(budgetEnd)

    const earlier = createOperationRunContext(environment({ request: request({ deadline: "2026-09-10T00:00:05.000Z" }) }))
    expect(earlier.deadline.expiresAt.getTime()).toBe(Date.parse("2026-09-10T00:00:05.000Z"))

    const explicit = createOperationRunContext(environment({
      deadline: createExecutionDeadline(new Date(fixedNow.getTime() + 2_000)),
      request: request({ deadline: "2030-01-01T00:00:00.000Z" }),
    }))
    expect(explicit.deadline.expiresAt.getTime()).toBe(fixedNow.getTime() + 2_000)
  })

  it("uses the supplied operation and correlation identifiers when provided", () => {
    const run = createOperationRunContext(environment({ request: request() }), { operationId: "op-explicit", correlationId: "corr-explicit" })
    expect(run.operationId).toBe("op-explicit")
    expect(run.correlationId).toBe("corr-explicit")
    const fallback = createOperationRunContext(environment({ request: request() }))
    expect(fallback.correlationId).toBe("correlation-7")
    expect(createOperationRunContext(environment()).correlationId).toBeUndefined()
  })
})

describe("request route binding", () => {
  it("accepts operations without a route and matching routes, and rejects mismatches", () => {
    expect(() => assertRequestBoundToOperation({ request: request() } as never, "any")).not.toThrow()
    const bound = request({ route: { routeKey: "orders.create", definitionVersion: 1, operationKey: "orders.create" } })
    expect(() => assertRequestBoundToOperation({ request: bound } as never, "orders.create")).not.toThrow()
    expect(() => assertRequestBoundToOperation({ request: bound } as never, "orders.cancel")).toThrow(
      new ConfigurationError('Request route "orders.create" is bound to operation "orders.create", not "orders.cancel".'),
    )
  })
})

describe("run context effects", () => {
  it("validates durable effect names and records outbox identity and time", () => {
    const run = createOperationRunContext(environment())
    expect(() => run.addDurableEffect({ name: "", outbox: { type: "x", version: 1 } } as never)).toThrow(
      "addDurableEffect requires a non-empty effect name.",
    )
    run.addDurableEffect({ name: "notify", outbox: outbox({ type: "orders.created", version: 1 }) } as never)
    expect(run.outboxRecords).toEqual([expect.objectContaining({ type: "orders.created", id: "gen-1", occurredAt: fixedNow })])
  })

  it("keeps explicit outbox identity and time over generated defaults", () => {
    const run = createOperationRunContext(environment())
    const occurredAt = new Date("2026-01-01T00:00:00.000Z")
    run.addOutboxRecord(outbox({ type: "explicit", version: 1, id: "given", occurredAt }) as never)
    run.addOutboxRecord(outbox({ type: "defaulted", version: 1 }) as never)
    expect(run.outboxRecords[0]).toMatchObject({ id: "given", occurredAt })
    expect(run.outboxRecords[1]).toMatchObject({ id: "gen-1", occurredAt: fixedNow })
  })

  it("requires deferred execution for best-effort effects", () => {
    const disabled = createOperationRunContext(environment({ runtimeCapabilities: { deferredExecution: false, cache: false } }))
    expect(() => disabled.addBestEffortEffect("notify", async () => undefined)).toThrow(RuntimeCapabilityError)
    const run = createOperationRunContext(environment())
    run.addBestEffortEffect("notify", async () => undefined)
    expect(run.bestEffortEffects.map((effect: { name: string }) => effect.name)).toEqual(["notify"])
  })

  it("checks runtime capabilities through the run context", () => {
    const run = createOperationRunContext(environment({ runtimeCapabilities: { deferredExecution: true, cache: false } }))
    expect(() => run.requireRuntimeCapability("cache")).toThrow(RuntimeCapabilityError)
    expect(() => run.requireRuntimeCapability("deferredExecution")).not.toThrow()
  })

  it("passes the restricted post-commit context to best-effort effects", async () => {
    const run = createOperationRunContext(environment({ request: request({ metadata: { source: "test" } }) }))
    const post = createPostCommitOperationContext(run)
    expect(post).toMatchObject({ operationId: "gen-1", correlationId: "correlation-7", metadata: { source: "test" } })
    expect(Object.isFrozen(post)).toBe(true)
    const seen = vi.fn()
    post.addBestEffortEffect("after", async (operation) => { seen(operation?.operationId) })
    await run.bestEffortEffects[0]!.execute(undefined)
    expect(seen).toHaveBeenCalledWith("gen-1")
    const bare = createPostCommitOperationContext(createOperationRunContext(environment()))
    expect("metadata" in bare).toBe(false)
    expect("correlationId" in bare).toBe(false)
    expect("request" in bare).toBe(false)
  })
})

describe("context projections", () => {
  it("projects read contexts with correlation and request only when present", () => {
    const run = createOperationRunContext(environment({ request: request() }))
    const read = createReadOperationContext(run)
    expect(read).toMatchObject({ operationId: "gen-1", correlationId: "correlation-7" })
    expect(read.request).toBeDefined()
    expect(Object.isFrozen(read)).toBe(true)
    expect("invoke" in read).toBe(false)
    const bare = createReadOperationContext(createOperationRunContext(environment()))
    expect("request" in bare).toBe(false)
    expect("correlationId" in bare).toBe(false)
  })

  it("exposes enforcement only where it was configured", () => {
    const enforcer = { enforce: () => undefined }
    const withEnforcer = createOperationRunContext(environment({ enforceAbac: enforcer }))
    expect(createAuthorizationOperationContext(withEnforcer).enforceAbac).toBe(enforcer)
    expect(createMutationOperationContext(withEnforcer).enforceAbac).toBe(enforcer)
    expect(createRetryableOperationContext(withEnforcer).enforceAbac).toBe(enforcer)
    const plain = createOperationRunContext(environment())
    expect("enforceAbac" in createAuthorizationOperationContext(plain)).toBe(false)
    expect("enforceAbac" in createMutationOperationContext(plain)).toBe(false)
    expect("enforceAbac" in createRetryableOperationContext(plain)).toBe(false)
  })

  it("keeps nested invocation unavailable unless a factory supplies it", async () => {
    const run = createOperationRunContext(environment())
    const mutation = createMutationOperationContext(run)
    await expect(mutation.invoke({} as never, {} as never)).rejects.toThrow(
      new ConfigurationError("Nested operations are not available in this context."),
    )
    const invoke = vi.fn(async () => "nested")
    const supplied = createMutationOperationContext(run, invoke as never)
    await expect(supplied.invoke({} as never, {} as never)).resolves.toBe("nested")
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("binds mutation effects to the run and omits effect APIs from retryable contexts", () => {
    const run = createOperationRunContext(environment())
    const mutation = createMutationOperationContext(run)
    mutation.addDurableEffect({ name: "bound", outbox: outbox({ type: "bound", version: 1 }) } as never)
    expect(run.outboxRecords).toHaveLength(1)
    expect(typeof mutation.addBestEffortEffect).toBe("function")
    const retryable = createRetryableOperationContext(run)
    expect("addDurableEffect" in retryable).toBe(false)
    expect("addBestEffortEffect" in retryable).toBe(false)
    expect(Object.isFrozen(retryable)).toBe(true)
  })

  it("exposes representation metadata only when the request carries it", () => {
    const withMetadata = createRepresentationContext(createOperationRunContext(environment({ request: request({ metadata: { tenant: "t" } }) })))
    expect(withMetadata.metadata).toEqual({ tenant: "t" })
    const plain = createRepresentationContext(createOperationRunContext(environment()))
    expect("metadata" in plain).toBe(false)
    expect("correlationId" in plain).toBe(false)
    expect(Object.isFrozen(plain)).toBe(true)
  })
})
