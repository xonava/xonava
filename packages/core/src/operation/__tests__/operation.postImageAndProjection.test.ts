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
    readableFields: new Set(["id", "name"]), writableFields: new Set(["status", "branchId", "region", "tenantId", "ownerId", "assigneeId"]),
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

describe("conditional updates cannot move a row out of the mandatory predicate", () => {
  const required = Predicate.and(Predicate.eq("tenantId", "tenant-1"), Predicate.eq("branchId", "A"), Predicate.or(Predicate.eq("region", "eu"), Predicate.eq("tenantId", "x")))

  it.each(["updateOneWhere", "updateOneWhereReturning", "updateManyWhere"] as const)("%s rejects data violating a fully-covered conjunct", async (method) => {
    const { repository, constrained } = repo(required)
    const call = constrained[method]! as (f: unknown, d: unknown) => Promise<unknown>
    await expect(call(Predicate.eq("id", "1"), { branchId: "B" })).rejects.toThrow(ForbiddenError)
    expect(repository[method]).not.toHaveBeenCalled()
  })

  it("decides a compound conjunct on the post-image: written fields by data, the rest in the WHERE", async () => {
    const { repository, constrained } = repo(required)
    // region "eu" keeps the OR true outright.
    await expect(constrained.updateManyWhere!(Predicate.eq("id", "1"), { region: "eu" } as never)).resolves.toBe(1)
    // region "us" leaves the OR depending on tenantId, which the WHERE must now require.
    await constrained.updateManyWhere!(Predicate.eq("id", "1"), { region: "us" } as never)
    const where = JSON.stringify((repository.updateManyWhere.mock.calls.at(-1) as unknown[])[0])
    expect(where).toContain('"field":"tenantId","op":"eq","value":"x"')
  })

  it("allows an owner to reassign while an OR on an unwritten field still holds", async () => {
    const { repository, constrained } = repo(Predicate.or(Predicate.eq("ownerId", "u1"), Predicate.eq("assigneeId", "u1")))
    await expect(constrained.updateOneWhere!(Predicate.eq("id", "1"), { status: "x" } as never)).resolves.toEqual({ updatedCount: 1 })
    expect(JSON.stringify((repository.updateOneWhere.mock.calls.at(-1) as unknown[])[0])).toContain('"ownerId"')
  })

  it("rejects writing NULL into a compared field", async () => {
    const { constrained } = repo(required)
    await expect(constrained.updateManyWhere!(Predicate.eq("id", "1"), { branchId: null } as never)).rejects.toThrow(ForbiddenError)
  })

  it("treats dynamic-fact equalities as pre-image guards so compare-and-set transitions work", async () => {
    const repository = {
      findById: vi.fn(), findMany: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(),
      updateOneWhereReturning: vi.fn(async (_f: unknown, data: object) => ({ id: "1", tenantId: "tenant-1", status: "draft", ...data })),
    }
    const constrained = createPlanConstrainedPersistenceProvider(
      { dialect: "test", capabilities, repository: () => repository } as PersistenceProvider,
      plan({ mandatoryResourcePredicate: Predicate.eq("tenantId", "tenant-1"), dynamicFacts: [{ factKey: "status", version: "1", observedAt: "2026-09-10T00:00:00.000Z", revalidation: { kind: "mutation-predicate", field: "status", expectedValue: "draft" } }] }),
    ).repository({ name: "records", fields: {} })
    await expect(constrained.updateOneWhereReturning!(Predicate.eq("id", "1"), { status: "submitted" } as never)).resolves.toMatchObject({ status: "submitted" })
    expect(JSON.stringify(repository.updateOneWhereReturning.mock.calls[0]![0])).toContain('"value":"draft"')
  })

  it("permits data that keeps every touched conjunct true and untouched conjuncts", async () => {
    const { repository, constrained } = repo(required)
    await expect(constrained.updateManyWhere!(Predicate.eq("id", "1"), { branchId: "A", status: "x" } as never)).resolves.toBe(1)
    await expect(constrained.updateOneWhere!(Predicate.eq("id", "1"), { status: "x" } as never)).resolves.toEqual({ updatedCount: 1 })
    expect(repository.updateManyWhere).toHaveBeenCalled()
  })
})

describe("result projection does not leak through nesting or envelopes", () => {
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
