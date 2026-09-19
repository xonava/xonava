import { describe, expect, it, vi } from "vitest"
import { ConflictError, ConfigurationError, Predicate, encodeExecutionScopeId, evaluatePredicate, type PredicateNode, type Principal, type RequestContext } from "../../domain"
import type { AtomicBatchItem, AtomicBatchPlan, AtomicBatchProvider, AtomicBatchResult, InteractiveTransactionProvider, PersistenceProvider, UnversionedRepository } from "../../persistence"
import type { RuntimeCapabilities } from "../../bootstrap/runtimeCapabilities"
import { createAuthorizedExecutionPlan } from "../../security"
import { createOperationContext } from "../operationContext"
import { runOperation } from "../operationPipeline"

const runtimeCapabilities: RuntimeCapabilities = { deferredExecution: false, cache: false }
const principal: Principal = {
  id: "user-1",
  kind: "human",
  authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" },
}
const scope = { kind: "tenant", tenantId: "tenant-1" } as const
const scopeId = encodeExecutionScopeId(scope)

function request(operationKey = "records.read"): RequestContext {
  return {
    requestId: "request-1",
    correlationId: "correlation-1",
    identity: { actor: principal, subject: principal },
    scope,
    scopeId,
    authority: {
      identity: { actor: principal, subject: principal },
      correlationId: "correlation-1",
      grant: {
        grantId: "grant-1",
        source: { kind: "route", routeKey: "records.read" },
        target: { scope, scopeId },
        purpose: "test",
        reason: "test",
        issuedAt: "2026-09-10T00:00:00.000Z",
        policy: { policyKey: "test", policyVersion: 1, policyDigest: "test", evaluatedAt: "2026-09-10T00:00:00.000Z", authorizationModel: "snapshot" },
        delegationChain: [],
        impersonation: { kind: "none" },
      },
    },
    route: { routeKey: "records.read", operationKey, definitionVersion: 1 },
    signal: new AbortController().signal,
  }
}

function plan(overrides: Partial<Parameters<typeof createAuthorizedExecutionPlan>[0]> = {}) {
  return createAuthorizedExecutionPlan({
    identity: { actor: principal, subject: principal },
    scope,
    action: "records.read",
    operationKind: "read",
    readableFields: new Set(["id", "tenantId", "secret", "status"]),
    writableFields: new Set(["status"]),
    obligations: [],
    dynamicFacts: [],
    policy: { key: "test", version: 1, digest: "a".repeat(64) },
    ...overrides,
  })
}

function provider(repository: PersistenceProvider["repository"]): PersistenceProvider {
  return {
    dialect: "test",
    capabilities: {
      interactiveTransactions: false, atomicBatch: false, returningInsert: false, readSessions: false,
      jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100,
      maxBindParams: 100, maxStatementBytes: 100_000,
    },
    repository,
  }
}

function transactionProvider(repository: PersistenceProvider["repository"]): InteractiveTransactionProvider {
  const value: InteractiveTransactionProvider = {
    dialect: "test",
    capabilities: {
      interactiveTransactions: true, atomicBatch: false, returningInsert: false, readSessions: false,
      jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100,
      maxBindParams: 100, maxStatementBytes: 100_000,
    },
    repository,
    runInTransaction: async (work) => work(value),
  }
  return value
}

const entity = {
  name: "record",
  fields: {
    id: { type: "string" as const },
    tenantId: { type: "string" as const },
    membershipVersion: { type: "number" as const },
    secret: { type: "string" as const },
    status: { type: "string" as const },
  },
}

describe("authorization decision and plan enforcement", () => {
  it("fails closed when a standard authorizer returns no decision", async () => {
    const execute = vi.fn(async () => ({ status: "changed" }))
    await expect(runOperation({
      operation: createOperationContext({ persistence: transactionProvider(() => { throw new Error("unused") }), runtimeCapabilities }),
      definition: {
        key: "missing-decision",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => undefined as never },
        execute,
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
    expect(execute).not.toHaveBeenCalled()
  })

  it("fails closed when an atomic-batch authorizer returns no decision", async () => {
    const executeAtomicBatch = vi.fn(async (batch: AtomicBatchPlan<string>): Promise<AtomicBatchResult> => batch.items.map((item) => ({ kind: item.kind, result: item })))
    const atomic: AtomicBatchProvider<string> = {
      dialect: "test",
      capabilities: {
        interactiveTransactions: false, atomicBatch: true, returningInsert: false, readSessions: false,
        jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100,
        maxBindParams: 100, maxStatementBytes: 100_000,
      },
      repository: () => { throw new Error("unused") },
      executeAtomicBatch,
    }
    const prepare = vi.fn(async () => ({ commands: ["write"], result: { status: "changed" } }))
    await expect(runOperation({
      operation: createOperationContext({ persistence: atomic, runtimeCapabilities }),
      definition: {
        key: "missing-batch-decision",
        kind: "mutation",
        atomicity: { kind: "atomic-batch" },
        authorization: { authorize: async () => undefined as never },
        prepare,
      },
      input: {},
    })).rejects.toThrow(ConfigurationError)
    expect(prepare).not.toHaveBeenCalled()
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })

  it("projects and masks fields from a returned framework authorization plan", async () => {
    const authorizationPlan = plan({ obligations: [{ kind: "mask", field: "secret", strategy: "redact" }] })
    const result = await runOperation({
      operation: createOperationContext({ persistence: provider(() => { throw new Error("unused") }), runtimeCapabilities, request: request("masked-read") }),
      definition: {
        key: "masked-read",
        kind: "read",
        authorization: { authorize: async () => ({ allowed: true, plan: authorizationPlan }) },
        execute: async () => ({ id: "1", tenantId: "tenant-1", secret: "private", status: "visible", internal: "never-returned" }),
      },
      input: {},
    })
    expect(result).toEqual({ id: "1", tenantId: "tenant-1", secret: "[REDACTED]", status: "visible" })
  })

  it("rejects a structurally forged plan before operation code runs", async () => {
    const execute = vi.fn(async () => ({ secret: "private" }))
    await expect(runOperation({
      operation: createOperationContext({ persistence: provider(() => { throw new Error("unused") }), runtimeCapabilities, request: request("forged-plan") }),
      definition: {
        key: "forged-plan",
        kind: "read",
        authorization: { authorize: async () => ({ allowed: true, plan: { operationKind: "read" } as never }) },
        execute,
      },
      input: {},
    })).rejects.toThrow(/framework authorization plan/)
    expect(execute).not.toHaveBeenCalled()
  })

  it("filters repository reads with the mandatory resource predicate before handler code receives rows", async () => {
    const repository: UnversionedRepository<{ id: string; tenantId: string; secret: string }> = {
      findById: vi.fn(async () => ({ id: "other", tenantId: "tenant-2", secret: "private" })),
      findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })),
      insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    }
    const seen = vi.fn()
    const result = await runOperation({
      operation: createOperationContext({ persistence: provider(() => repository), runtimeCapabilities, request: request("predicate-read") }),
      definition: {
        key: "predicate-read",
        kind: "read",
        authorization: { authorize: async () => ({ allowed: true, plan: plan({ mandatoryResourcePredicate: Predicate.eq("tenantId", "tenant-1") }) }) },
        execute: async ({ operation }) => {
          const row = await operation.persistence.repository(entity).findById("other")
          seen(row)
          return row
        },
      },
      input: {},
    })
    expect(seen).toHaveBeenCalledWith(null)
    expect(result).toBeNull()
  })

  it("binds mandatory and mutable-fact predicates to conditional mutations", async () => {
    let received: unknown
    const repository: UnversionedRepository<{ id: string; tenantId: string; membershipVersion: number; status: string }> = {
      findById: vi.fn(), findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
      updateOneWhere: vi.fn(async (filter) => { received = filter; return { updatedCount: 1 } }),
    }
    const authorizationPlan = plan({
      operationKind: "mutation",
      action: "records.update",
      mandatoryResourcePredicate: Predicate.eq("tenantId", "tenant-1"),
      dynamicFacts: [{ factKey: "membership", version: "7", observedAt: "2026-09-10T00:00:00.000Z", revalidation: { kind: "mutation-predicate", field: "membershipVersion", expectedValue: 7 } }],
    })
    await runOperation({
      operation: createOperationContext({ persistence: transactionProvider(() => repository), runtimeCapabilities, request: request("predicate-update") }),
      definition: {
        key: "predicate-update",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true, plan: authorizationPlan }) },
        execute: async ({ operation }: { operation: import("../operationContext").MutationOperationContext }) => {
          await operation.persistence.repository(entity).updateOneWhere!(Predicate.eq("id", "1"), { status: "changed" })
          return { status: "changed" }
        },
      },
      input: {},
    })
    expect(evaluatePredicate({ id: "1", tenantId: "tenant-1", membershipVersion: 7 }, received as PredicateNode)).toBe(true)
    expect(evaluatePredicate({ id: "1", tenantId: "tenant-2", membershipVersion: 7 }, received as PredicateNode)).toBe(false)
    expect(evaluatePredicate({ id: "1", tenantId: "tenant-1", membershipVersion: 8 }, received as PredicateNode)).toBe(false)
  })

  it("aborts mutations when a dynamic fact revalidation fails", async () => {
    const revalidate = vi.fn(async () => false)
    const authorizationPlan = plan({
      operationKind: "mutation",
      action: "records.update",
      dynamicFacts: [{ factKey: "membership", version: "7", observedAt: "2026-09-10T00:00:00.000Z", revalidation: { kind: "transaction-check", checkKey: "membership" } }],
    })
    await expect(runOperation({
      operation: createOperationContext({ persistence: transactionProvider(() => { throw new Error("unused") }), runtimeCapabilities, request: request("revalidate-membership"), authorizationFactRevalidator: { revalidate } }),
      definition: {
        key: "revalidate-membership",
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true, plan: authorizationPlan }) },
        execute: async () => ({ status: "changed" }),
      },
      input: {},
    })).rejects.toThrow(ConflictError)
    expect(revalidate).toHaveBeenCalledOnce()
  })

  it("rejects predicate-bearing authorization plans for opaque atomic-batch commands", async () => {
    const executeAtomicBatch = vi.fn(async (batch: AtomicBatchPlan<string>): Promise<AtomicBatchResult> => batch.items.map((item) => ({ kind: item.kind, result: item })))
    const atomic: AtomicBatchProvider<string> = {
      dialect: "test",
      capabilities: {
        interactiveTransactions: false, atomicBatch: true, returningInsert: false, readSessions: false,
        jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100,
        maxBindParams: 100, maxStatementBytes: 100_000,
      },
      repository: () => { throw new Error("unused") },
      executeAtomicBatch,
    }
    const prepare = vi.fn(async () => ({ commands: ["write"], result: { status: "changed" } }))
    await expect(runOperation({
      operation: createOperationContext({ persistence: atomic, runtimeCapabilities, request: request("predicate-batch") }),
      definition: {
        key: "predicate-batch",
        kind: "mutation",
        atomicity: { kind: "atomic-batch" },
        authorization: { authorize: async () => ({ allowed: true, plan: plan({ operationKind: "mutation", mandatoryResourcePredicate: Predicate.eq("tenantId", "tenant-1") }) }) },
        prepare,
      },
      input: {},
    })).rejects.toThrow(/adapter-bound command plan/)
    expect(prepare).not.toHaveBeenCalled()
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })
})
