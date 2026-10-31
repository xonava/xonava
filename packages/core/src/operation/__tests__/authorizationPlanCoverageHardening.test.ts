import { describe, expect, it, vi } from "vitest"
import { ConflictError, ConfigurationError, ForbiddenError, Predicate, encodeExecutionScopeId } from "../../domain"
import type { PersistenceProvider } from "../../persistence"
import { createAuthorizedExecutionPlan } from "../../security"
import { createOperationContext, type AuthorizationOperationContext } from "../operationContext"
import {
  applyAuthorizationPlanToResult,
  assertAtomicBatchPlanSupported,
  authorizeOperation,
  createPlanConstrainedPersistenceProvider,
  revalidateAuthorizationFacts,
} from "../authorizationPlanEnforcement"

const principal = {
  id: "user-1", kind: "human",
  authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" },
} as const
const scope = { kind: "tenant", tenantId: "tenant-1" } as const
const request = {
  requestId: "request-1", correlationId: "correlation-1",
  identity: { actor: principal, subject: principal }, scope, scopeId: encodeExecutionScopeId(scope),
  signal: new AbortController().signal,
} as never
const capabilities = {
  interactiveTransactions: false, atomicBatch: false, returningInsert: false, readSessions: false,
  jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100,
  maxBindParams: 100, maxStatementBytes: 100_000,
} as const

function plan(overrides: Record<string, unknown> = {}) {
  return createAuthorizedExecutionPlan({
    identity: { actor: principal, subject: principal }, scope, action: "records.read", operationKind: "read",
    readableFields: new Set(["id", "tenantId", "secret"]), writableFields: new Set(["status"]),
    obligations: [], dynamicFacts: [], policy: { key: "policy", version: 1, digest: "a".repeat(64) },
    ...overrides,
  } as never)
}

function operation() {
  return { ...createOperationContext({
    persistence: { dialect: "test", capabilities, repository: () => { throw new Error("unused") } },
    runtimeCapabilities: { deferredExecution: false, cache: false }, request,
    clock: { now: () => new Date("2026-09-10T00:01:00.000Z") },
  }), operationId: "operation-1", signal: new AbortController().signal } as unknown as AuthorizationOperationContext
}

describe("authorization enforcement defensive convergence", () => {
  it("fails closed for malformed, denied, mismatched, and context-free authorization decisions", async () => {
    await expect(authorizeOperation({ operation: operation(), definition: { key: "open", kind: "read" }, input: {} })).resolves.toBeUndefined()
    await expect(authorizeOperation({ operation: operation(), definition: { key: "invalid", kind: "read", authorization: {} as never }, input: {} })).rejects.toThrow(ConfigurationError)
    await expect(authorizeOperation({ operation: operation(), definition: { key: "denied", kind: "read", authorization: { authorize: async () => ({ allowed: false, reason: "blocked" }) } }, input: {} })).rejects.toThrow(ForbiddenError)
    await expect(authorizeOperation({ operation: operation(), definition: { key: "kind", kind: "mutation", authorization: { authorize: async () => ({ allowed: true, plan: plan() }) } }, input: {} })).rejects.toThrow(/kind does not match/)
    const noRequest = { ...createOperationContext({ persistence: { dialect: "test", capabilities, repository: () => { throw new Error("unused") } }, runtimeCapabilities: { deferredExecution: false, cache: false } }), operationId: "operation-2", signal: new AbortController().signal } as unknown as AuthorizationOperationContext
    await expect(authorizeOperation({ operation: noRequest, definition: { key: "context", kind: "read", authorization: { authorize: async () => ({ allowed: true, plan: plan() }) } }, input: {} })).rejects.toThrow(/verified request context/)
  })

  it("rejects mutation plans for opaque atomic batches while permitting absent and read plans", () => {
    expect(() => assertAtomicBatchPlanSupported(undefined, "batch")).not.toThrow()
    expect(() => assertAtomicBatchPlanSupported(plan(), "batch")).not.toThrow()
    expect(() => assertAtomicBatchPlanSupported(plan({ operationKind: "mutation" }), "batch")).toThrow(/adapter-bound command plan/)
  })

  it("constrains repository reads and every mutation shape", async () => {
    const repository = {
      findById: vi.fn(async () => ({ id: "2", tenantId: "tenant-2", status: "old" })),
      findOneWhere: vi.fn(async () => ({ id: "1", tenantId: "tenant-1", status: "old" })),
      findMany: vi.fn(async () => ({ rows: [{ id: "1", tenantId: "tenant-1" }, { id: "2", tenantId: "tenant-2" }], rowCount: 2, page: 1, pageSize: 10 })),
      insert: vi.fn(async (data: object) => ({ id: "1", tenantId: "tenant-1", ...data })),
      bulkInsert: vi.fn(async (data: object[]) => data.map((entry, index) => ({ id: String(index), tenantId: "tenant-1", ...entry }))),
      update: vi.fn(async (_id: string, data: object) => ({ id: "1", ...data })),
      updateOneWhere: vi.fn(async () => ({ updatedCount: 1 })),
      updateOneWhereReturning: vi.fn(async () => ({ id: "2", tenantId: "tenant-2", status: "changed" })),
      updateManyWhere: vi.fn(async () => 1), delete: vi.fn(async () => undefined),
      deleteWhere: vi.fn(async () => ({ deletedCount: 1 })),
    }
    const authorizationPlan = plan({ operationKind: "mutation", mandatoryResourcePredicate: Predicate.eq("tenantId", "tenant-1") })
    const constrained = createPlanConstrainedPersistenceProvider({ dialect: "test", capabilities, repository: () => repository } as PersistenceProvider, authorizationPlan)
    const repo = constrained.repository({ name: "records", fields: {} })

    await expect(repo.findById("2")).resolves.toBeNull()
    await expect(repo.findOneWhere!(Predicate.eq("id", "1"))).resolves.toMatchObject({ id: "1" })
    const listed = await repo.findMany()
    expect(listed).toMatchObject({ rows: [{ id: "1", tenantId: "tenant-1" }] })
    expect(listed).not.toHaveProperty("rowCount")
    await expect(repo.insert(null as never)).rejects.toThrow(ConfigurationError)
    await expect(repo.insert({ tenantId: "tenant-1", forbidden: true } as never)).rejects.toThrow(ForbiddenError)
    await expect(repo.insert({ status: "new" } as never)).rejects.toThrow(/resource predicate/)
    await expect(repo.update("1", { status: "new" } as never)).rejects.toThrow(/conditional where mutation/)
    expect(() => repo.delete("1")).toThrow(/conditional where mutation/)
    await expect(repo.updateOneWhere!(Predicate.eq("id", "1"), { status: "new" } as never)).resolves.toEqual({ updatedCount: 1 })
    await expect(repo.updateOneWhereReturning!(Predicate.eq("id", "1"), { status: "new" } as never)).resolves.toBeNull()
    await expect(repo.updateManyWhere!(Predicate.eq("id", "1"), { status: "new" } as never)).resolves.toBe(1)
    await expect(repo.deleteWhere!(Predicate.eq("id", "1"))).resolves.toEqual({ deletedCount: 1 })
  })

  it("detects post-write predicate drift for single and bulk inserts", async () => {
    const repository = {
      findById: vi.fn(), findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })),
      insert: vi.fn(async () => ({ id: "1", tenantId: "tenant-2", status: "new" })),
      bulkInsert: vi.fn(async () => [{ id: "1", tenantId: "tenant-2", status: "new" }]),
      update: vi.fn(), delete: vi.fn(),
    }
    const constrained = createPlanConstrainedPersistenceProvider(
      { dialect: "test", capabilities, repository: () => repository } as PersistenceProvider,
      plan({ operationKind: "mutation", mandatoryResourcePredicate: Predicate.eq("tenantId", "tenant-1"), writableFields: new Set(["tenantId", "status"]) }),
    ).repository({ name: "records", fields: {} })
    await expect(constrained.insert({ tenantId: "tenant-1", status: "new" } as never)).rejects.toThrow(ConflictError)
    await expect(constrained.bulkInsert!([{ tenantId: "tenant-1", status: "new" }] as never)).rejects.toThrow(ConflictError)
  })

  it("requires and evaluates dynamic fact revalidation at commit", async () => {
    const mutationPlan = plan({ operationKind: "mutation", dynamicFacts: [{ factKey: "membership", version: "1", observedAt: "2026-09-10T00:00:00.000Z", revalidation: { kind: "transaction-check", checkKey: "membership" } }] })
    const runContext = { persistence: {}, operationId: "operation-1", signal: new AbortController().signal } as never
    await expect(revalidateAuthorizationFacts({ plan: mutationPlan, operation: runContext })).rejects.toThrow(/requires a dynamic-fact revalidator/)
    await expect(revalidateAuthorizationFacts({ plan: mutationPlan, operation: runContext, revalidator: { revalidate: async () => false } })).rejects.toThrow(ConflictError)
    await expect(revalidateAuthorizationFacts({ plan: mutationPlan, operation: runContext, revalidator: { revalidate: async () => true } })).resolves.toBeUndefined()
    await expect(revalidateAuthorizationFacts({ plan: undefined, operation: runContext })).resolves.toBeUndefined()
  })

  it("projects collections and applies every masking strategy", () => {
    const partial = plan({ obligations: [{ kind: "mask", field: "secret", strategy: "partial" }] })
    expect(applyAuthorizationPlanToResult(partial, [{ id: "1", secret: "4111111111111111", hidden: true }])).toEqual([{ id: "1", secret: "****1111" }])
    // Short values reveal nothing: a partial mask must not disclose most of an identifier.
    expect(applyAuthorizationPlanToResult(partial, [{ id: "1", secret: "abcdef" }])).toEqual([{ id: "1", secret: "[REDACTED]" }])
    expect(applyAuthorizationPlanToResult(partial, { rows: [{ id: "1", secret: "x" }], rowCount: 99 })).toEqual({ rows: [{ id: "1", secret: "[REDACTED]" }], rowCount: 1 })
    expect(applyAuthorizationPlanToResult(partial, null)).toBeNull()
    expect(applyAuthorizationPlanToResult(undefined, { untouched: true })).toEqual({ untouched: true })
  })

  it("keys hash masks so they cannot be reversed by dictionary attack, and fails closed without a key", () => {
    const hash = plan({ obligations: [{ kind: "mask", field: "secret", strategy: "hash" }] })
    const key = new TextEncoder().encode("0123456789abcdef-masking-key")
    const otherKey = new TextEncoder().encode("fedcba9876543210-masking-key")
    expect(applyAuthorizationPlanToResult(hash, { id: "1", secret: "555-0100" })).toMatchObject({ secret: "[REDACTED]" })
    const masked = applyAuthorizationPlanToResult(hash, { id: "1", secret: "555-0100" }, { maskingKey: key }) as { secret: string }
    expect(masked.secret).toMatch(/^hmac-sha256:[0-9a-f]{64}$/)
    // Deterministic under one key (joinable), different under another key.
    expect(applyAuthorizationPlanToResult(hash, { id: "2", secret: "555-0100" }, { maskingKey: key })).toMatchObject({ secret: masked.secret })
    expect((applyAuthorizationPlanToResult(hash, { id: "1", secret: "555-0100" }, { maskingKey: otherKey }) as { secret: string }).secret).not.toBe(masked.secret)
    expect(() => applyAuthorizationPlanToResult(hash, { id: "1", secret: "x" }, { maskingKey: new Uint8Array(8) })).toThrow(/at least 16 bytes/)
  })
})

describe("plan-constrained queries with projections", () => {
  it("does not drop rows whose projection omits a predicate field, but still re-checks complete rows", async () => {
    const constrained = plan({ mandatoryResourcePredicate: Predicate.eq("ownerId", "u1") })
    const rows = [{ id: "a", ownerId: "u1" }, { id: "b" }, { id: "c", ownerId: "intruder" }]
    const base = { dialect: "test", capabilities: { interactiveTransactions: false }, repository: () => ({ findById: async () => null, findMany: async () => ({ rows, rowCount: rows.length, page: 1, pageSize: 10 }), insert: async () => ({}), update: async () => ({}), delete: async () => undefined }) } as never
    const provider = createPlanConstrainedPersistenceProvider(base, constrained)
    const result = await provider.repository({ name: "doc", fields: {} } as never).findMany({ projection: { fields: ["id"] } } as never)
    expect(result.rows).toEqual([{ id: "a", ownerId: "u1" }, { id: "b" }])
  })
})
