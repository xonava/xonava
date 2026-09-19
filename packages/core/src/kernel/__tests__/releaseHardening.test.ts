import { validateResiliencePolicy } from "../../resilience/resilience"
import { validateBulkMutationResult } from "../../persistence/bulk"
import { assertCapabilityConfigValid } from "../../entity/capabilityCheck"
import { defineOperationDataAccess } from "../../operation/operationResources"
import { createVerifiedScopeResolution, isVerifiedScopeResolution } from "../../security/scopeResolver"
import { createOperationInvoker } from "../../operation/operationInvoker"
import { describe, expect, it, vi } from "vitest"
import { compileFramework } from "../../bootstrap/compiler"
import { FrameworkDefinitionRegistry } from "../../bootstrap/definitionRegistry"
import { FrameworkRuntimeRegistry } from "../../bootstrap/runtimeRegistry"
import { hasObjectStoreCapability, requireCapability, requireRuntimeCapability } from "../../bootstrap/runtimeCapabilities"
import { COMPILED_DURABLE_FORMAT_REGISTRY_V1 } from "../../serialization/formatRegistry"
import { createAuthorizedExecutionPlan, isAuthorizedExecutionPlan } from "../../security/authorizedExecutionPlan"
import { createPlanConstrainedPersistenceProvider } from "../../operation/authorizationPlanEnforcement"
import { createOperationContext } from "../../operation/operationContext"
import { runOperation } from "../../operation/operationPipeline"
import { validateOperationDefinition } from "../../operation/validateOperationDefinition"
import { assertExecutionActive, createExecutionDeadline } from "../../operation/deadline"
import { assertQueryBudget } from "../../query/queryBudget"
import { decodeCursor, encodeCursor } from "../../query/cursorCodec"
import { checkRateLimit, enforceRateLimit } from "../../rate-limit/rateLimit"
import { ConfigurationError, Predicate, RetryablePersistenceError } from "../../domain"
import type { InteractiveTransactionProvider, PersistenceProvider } from "../../persistence/provider"

const caps = { deferredExecution: false, cache: false }
const principal = { id: "u", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-17T00:00:00Z" } } as const
const authorityPlan = () => createAuthorizedExecutionPlan({ identity: { actor: principal, subject: principal }, scope: { kind: "application", applicationKey: "app" }, action: "read", operationKind: "read", readableFields: new Set(["id"]), writableFields: new Set(), obligations: [], dynamicFacts: [], policy: { key: "p", version: 1, digest: "a" }, mandatoryResourcePredicate: Predicate.eq("id", "allowed") })
function provider(): InteractiveTransactionProvider {
  const value: InteractiveTransactionProvider = {
    dialect: "test", capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: false, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false },
    repository: () => ({ findById: async () => ({ id: "forbidden" }), findMany: async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 }), insert: vi.fn(), update: vi.fn(), delete: vi.fn() }) as never,
    runInTransaction: async work => work(value),
  }
  return value
}

describe("release hardening regression chains", () => {
  it("never exposes sealed compiler maps through forEach", () => {
    const registry = new FrameworkDefinitionRegistry()
    registry.register({ kind: "entity", key: "e", definitionVersion: 1 })
    const plan = compileFramework(registry, { frameworkVersion: "2", sourceRevision: "test" })
    plan.definitions.entities.forEach((_entry, _key, map) => {
      expect((map as Map<string, unknown>).clear).toBeUndefined()
      expect((map as Map<string, unknown>).set).toBeUndefined()
    })
    expect(plan.definitions.entities.size).toBe(1)
  })
  it("seals global durable format entries, versions and indexes", () => {
    const registry = COMPILED_DURABLE_FORMAT_REGISTRY_V1
    expect(Object.isFrozen(registry.entries)).toBe(true)
    expect(Object.isFrozen(registry.entries[0])).toBe(true)
    expect(Object.isFrozen(registry.entries[0]!.readableVersions)).toBe(true)
    registry.byFormatId.forEach((_value, _key, map) => expect((map as Map<string, unknown>).clear).toBeUndefined())
  })
  it("rejects reflected and inherited authorization plan forgeries", () => {
    const original = authorityPlan()
    const reflected = Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(original)))
    expect(isAuthorizedExecutionPlan(original)).toBe(true)
    expect(isAuthorizedExecutionPlan(reflected)).toBe(false)
    expect(isAuthorizedExecutionPlan(Object.freeze(Object.create(original)))).toBe(false)
  })
  it("rejects reflected and inherited scope resolutions", () => {
    const original = createVerifiedScopeResolution("tenant", { kind: "tenant", tenantId: "t" })
    expect(isVerifiedScopeResolution(original)).toBe(true)
    expect(isVerifiedScopeResolution(Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(original))))).toBe(false)
    expect(isVerifiedScopeResolution(Object.freeze(Object.create(original)))).toBe(false)
  })
  it("preserves authorization inside nested transactions without exposing provider prototypes", async () => {
    const raw = provider()
    const constrained = createPlanConstrainedPersistenceProvider(raw, authorityPlan()) as InteractiveTransactionProvider
    expect(Object.getPrototypeOf(constrained)).not.toBe(raw)
    await constrained.runInTransaction(async scoped => {
      await expect(scoped.repository({ name: "record", fields: { id: { type: "string" } } }).findById("forbidden")).resolves.toBeNull()
    })
  })
  it("rejects inherited authorization decision plans before execution", async () => {
    const execute = vi.fn()
    await expect(runOperation({ operation: createOperationContext({ persistence: provider(), runtimeCapabilities: caps }), input: {}, definition: { key: "read", kind: "read", authorization: { authorize: async () => Object.assign(Object.create({ plan: authorityPlan() }), { allowed: true }) }, execute } })).rejects.toThrow(ConfigurationError)
    expect(execute).not.toHaveBeenCalled()
  })
  it.each(["yes", 1, {}, []])("rejects truthy non-boolean capabilities %j", value => {
    expect(() => requireCapability({ cache: value as boolean }, "cache")).toThrow()
    expect(() => requireRuntimeCapability({ ...caps, cache: value as boolean }, "cache")).toThrow()
  })
  it.each([null, {}, { get: () => null }])("rejects incomplete object stores %j", store => {
    expect(hasObjectStoreCapability({ objectStore: store as never })).toBe(false)
    expect(() => requireRuntimeCapability({ ...caps, objectStore: store as never }, "objectStore")).toThrow()
  })
  it("rejects prototype property names as runtime capabilities", () => {
    expect(() => requireRuntimeCapability(caps, "constructor" as never)).toThrow()
  })
  it.each([null, undefined])("rejects empty runtime bindings %s", value => {
    const registry = new FrameworkDefinitionRegistry()
    const runtime = new FrameworkRuntimeRegistry(compileFramework(registry, { frameworkVersion: "2", sourceRevision: "test" }), registry)
    expect(() => runtime.bind("required", value)).toThrow(ConfigurationError)
  })
  it("rejects missing query budget dimensions", () => {
    expect(() => assertQueryBudget({} as never)).toThrow()
  })
  it("does not let a caller mutate the deadline or bypass it with invalid dates", () => {
    const deadline = createExecutionDeadline(new Date(100))
    deadline.expiresAt.setTime(10000)
    expect(() => assertExecutionActive(new AbortController().signal, deadline, { now: () => new Date(101) })).toThrow("deadline")
    expect(() => assertExecutionActive(new AbortController().signal, deadline, { now: () => new Date(NaN) })).toThrow(ConfigurationError)
  })
  it("retains a frozen original error without attaching internal retry state", async () => {
    const error = Object.freeze(new Error("original"))
    await expect(runOperation({ operation: createOperationContext({ persistence: provider(), runtimeCapabilities: caps }), definition: { key: "read", kind: "read", execute: () => { throw error } }, input: {} })).rejects.toBe(error)
  })
  it("does not trust caller-controlled retry flags", async () => {
    const error = Object.assign(new RetryablePersistenceError("retry"), { __hadSideEffects: true })
    const execute = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("ok")
    await expect(runOperation({ operation: createOperationContext({ persistence: provider(), runtimeCapabilities: caps }), definition: { key: "retry", kind: "mutation", authorization: { authorize: async () => ({ allowed: true }) }, atomicity: { kind: "standard", mode: "required" }, execution: { kind: "retryable-transaction", maxAttempts: 2, delay: 0, backoff: 1, maxDelay: 0 }, execute }, input: {} })).resolves.toBe("ok")
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it("rejects missing interactive transaction execution before callbacks", async () => {
    const raw: PersistenceProvider = { ...provider(), capabilities: { ...provider().capabilities, interactiveTransactions: false } }
    const execute = vi.fn()
    await expect(runOperation({ operation: createOperationContext({ persistence: raw, runtimeCapabilities: caps }), definition: { key: "read", kind: "read", atomicity: { kind: "standard", mode: "preferred" }, execution: { kind: "transaction" }, execute }, input: {} })).rejects.toThrow("interactive transaction")
    expect(execute).not.toHaveBeenCalled()
  })
  it("rejects transaction options on atomic fallback", () => {
    expect(() => validateOperationDefinition({ key: "m", kind: "mutation", authorization: { authorize: async () => ({ allowed: true }) }, atomicity: { kind: "standard", mode: "required", transactionOptions: { isolationLevel: "serializable" } }, atomicBatch: { prepare: () => ({ commands: [], result: null }) }, execute: () => null })).toThrow("transaction options")
  })
  it("rechecks cancellation after commit markers and before commit", async () => {
    const abort = new AbortController()
    let committed = false
    const raw = provider()
    raw.runInTransaction = async work => { const value = await work(raw); committed = true; return value }
    await expect(runOperation({ operation: createOperationContext({ persistence: raw, runtimeCapabilities: caps, signal: abort.signal, commitMarkers: [{ name: "cancel", commit: async () => { abort.abort(new Error("cancelled")) } }] }), definition: { key: "m", kind: "mutation", atomicity: { kind: "standard", mode: "required" }, authorization: { authorize: async () => ({ allowed: true }) }, execute: () => "ok" }, input: {} })).rejects.toThrow("cancelled")
    expect(committed).toBe(false)
  })
  it("does not finalize parent commit markers from a child operation", async () => {
    const commit = vi.fn(async () => {})
    const parent = createOperationContext({ persistence: provider(), runtimeCapabilities: caps, commitMarkers: [{ name: "parent", commit }] })
    await expect(createOperationInvoker(parent).invoke({ key: "child", kind: "mutation", atomicity: { kind: "standard", mode: "required" }, authorization: { authorize: async () => ({ allowed: true }) }, execute: () => "child-result" }, {})).resolves.toBe("child-result")
    expect(commit).not.toHaveBeenCalled()
    expect(() => createOperationInvoker({ ...parent, nestingDepth: NaN })).toThrow("nesting depth")
  })
  it("rejects incomplete resilience policies and unknown retry semantics", () => {
    expect(() => validateResiliencePolicy({ retry: {} as never }, { kind: "read" })).toThrow("required")
    expect(() => validateResiliencePolicy({ circuitBreaker: {} as never }, { kind: "read" })).toThrow("required")
    expect(() => validateResiliencePolicy({ bulkhead: {} as never }, { kind: "read" })).toThrow("required")
    expect(() => validateResiliencePolicy({ retry: { maxAttempts: 3 } }, { kind: "typo" } as never)).toThrow("semantics")
  })
  it("rejects malformed bulk result discriminants", () => {
    expect(() => validateBulkMutationResult([{ id: "a" }], { mode: "typo", items: [{ id: "a", status: "rejected", code: "unknown" }], appliedCount: 0, rejectedCount: 1 } as never)).toThrow("mode")
    expect(() => validateBulkMutationResult([{ id: "a" }], { mode: "partial", items: [{ id: "a", status: "typo" }], appliedCount: 0, rejectedCount: 1 } as never)).toThrow("status")
  })
  it("rejects malformed capability bypass flags and resource declaration kinds", () => {
    expect(() => assertCapabilityConfigValid({ skipCapabilityCheck: "false", customCapabilityKey: "read" })).toThrow("boolean")
    expect(() => defineOperationDataAccess({ kind: "raw", datasourceKey: "primary", resources: [{ kind: "entity", key: "e", access: "read" }] } as never)).toThrow("kind")
  })
  it("enforces canonical cursor framing and literal verification success", async () => {
    const payload = { format: "framework.cursor", version: 1, direction: "after", values: [1], routeHash: "r", queryHash: "q", scopeHash: "s", sortHash: "o" } as const
    const integrity = { sign: async () => new Uint8Array([1]), verify: async () => true }
    const cursor = await encodeCursor(payload, integrity)
    await expect(decodeCursor(cursor + ".", integrity)).rejects.toThrow("malformed")
    await expect(decodeCursor(cursor, { ...integrity, verify: async () => "true" as never })).rejects.toThrow("integrity")
    await expect(decodeCursor(cursor, integrity, NaN)).rejects.toThrow("limit")
  })
  it("does not downgrade invalid rate-limit consistency or missing features", async () => {
    const store = { increment: vi.fn(async () => ({ count: 1, resetAt: 1000 })) }
    await expect(checkRateLimit({ store, key: "k", limit: 2, windowMs: 1000, consistency: "typo" as never })).rejects.toThrow("consistency")
    expect(store.increment).not.toHaveBeenCalled()
    await expect(checkRateLimit({ store, key: "k", limit: 2, windowMs: 1000, consistency: "best-effort", failureMode: "fail-open", cost: 2 })).rejects.toThrow()
    await expect(enforceRateLimit({ store, key: "k", config: { max: 2, timeWindow: 1000, consistency: "best-effort" } })).resolves.toMatchObject({ allowed: true })
  })
})
