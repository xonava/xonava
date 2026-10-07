import { describe, expect, it, vi } from "vitest"
import { ForbiddenError, Predicate } from "../../domain"
import type { PredicateNode } from "../../domain/predicate"
import type { PersistenceProvider } from "../../persistence"
import { createAuthorizedExecutionPlan } from "../../security"
import { applyAuthorizationPlanToResult, createPlanConstrainedPersistenceProvider } from "../authorizationPlanEnforcement"

const principal = {
  id: "user-1", kind: "human",
  authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" },
} as const
const scope = { kind: "tenant", tenantId: "tenant-1" } as const
const capabilities = {
  interactiveTransactions: false, atomicBatch: false, returningInsert: false, readSessions: false,
  jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100,
  maxBindParams: 100, maxStatementBytes: 100_000,
} as const

function plan(overrides: Record<string, unknown> = {}) {
  return createAuthorizedExecutionPlan({
    identity: { actor: principal, subject: principal }, scope, action: "records.update", operationKind: "mutation",
    readableFields: new Set(["id", "name"]), writableFields: new Set(["status", "branchId", "region", "tenantId"]),
    obligations: [], dynamicFacts: [], policy: { key: "policy", version: 1, digest: "a".repeat(64) },
    ...overrides,
  } as never)
}

function repo(mandatoryResourcePredicate: PredicateNode) {
  const repository = {
    findById: vi.fn(), findMany: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
    updateOneWhere: vi.fn(async () => ({ updatedCount: 1 })),
    updateOneWhereReturning: vi.fn(async (_f: unknown, data: object) => ({ id: "1", tenantId: "tenant-1", branchId: "A", region: "eu", ...data })),
    updateManyWhere: vi.fn(async () => 1),
  }
  const constrained = createPlanConstrainedPersistenceProvider(
    { dialect: "test", capabilities, repository: () => repository } as PersistenceProvider,
    plan({ mandatoryResourcePredicate }),
  ).repository({ name: "records", fields: {} })
  return { repository, constrained }
}

describe("S2: conditional updates cannot move a row out of the mandatory predicate", () => {
  const required = Predicate.and(Predicate.eq("tenantId", "tenant-1"), Predicate.eq("branchId", "A"), Predicate.or(Predicate.eq("region", "eu"), Predicate.eq("tenantId", "x")))

  it.each(["updateOneWhere", "updateOneWhereReturning", "updateManyWhere"] as const)("%s rejects data violating a fully-covered conjunct", async (method) => {
    const { repository, constrained } = repo(required)
    const call = constrained[method]! as (f: unknown, d: unknown) => Promise<unknown>
    await expect(call(Predicate.eq("id", "1"), { branchId: "B" })).rejects.toThrow(ForbiddenError)
    expect(repository[method]).not.toHaveBeenCalled()
  })

  it("rejects a partial write to a compound conjunct", async () => {
    const { constrained } = repo(required)
    await expect(constrained.updateManyWhere!(Predicate.eq("id", "1"), { region: "eu" } as never)).rejects.toThrow(ForbiddenError)
  })

  it("permits data that keeps every touched conjunct true and untouched conjuncts", async () => {
    const { repository, constrained } = repo(required)
    await expect(constrained.updateManyWhere!(Predicate.eq("id", "1"), { branchId: "A", status: "x" } as never)).resolves.toBe(1)
    await expect(constrained.updateOneWhere!(Predicate.eq("id", "1"), { status: "x" } as never)).resolves.toEqual({ updatedCount: 1 })
    expect(repository.updateManyWhere).toHaveBeenCalled()
  })
})

describe("S5a: result projection does not leak through nesting or envelopes", () => {
  const readPlan = () => plan({ operationKind: "read", action: "records.read" })

  it("projects nested arrays recursively", () => {
    expect(applyAuthorizationPlanToResult(readPlan(), [[{ id: "1", ssn: "x" }]])).toEqual([[{ id: "1" }]])
    expect(applyAuthorizationPlanToResult(readPlan(), { rows: [[{ id: "1", ssn: "x" }]], rowCount: 1 })).toEqual({ rows: [[{ id: "1" }]], rowCount: 1 })
  })

  it("keeps only allowlisted paged envelope keys", () => {
    const result = applyAuthorizationPlanToResult(readPlan(), {
      rows: [{ id: "1", ssn: "x" }], rowCount: 1, page: 1, pageSize: 10,
      pageInfo: { kind: "offset", page: 1, pageSize: 10, rowCount: 1 }, summary: { ssn: "x" },
    })
    expect(result).toEqual({ rows: [{ id: "1" }], rowCount: 1, page: 1, pageSize: 10, pageInfo: { kind: "offset", page: 1, pageSize: 10, rowCount: 1 } })
  })
})
