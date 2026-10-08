/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, ForbiddenError, Predicate, evaluatePredicate, type FieldReadOverride } from "core/domain"
import { createAuthorizedRepository } from "../authorizedRepository"
import { TrustedPersistenceRouter } from "../persistenceRouter"

interface Emp extends Record<string, unknown> { id: string; tenantId: string; name: string; salary: number; version: number }

const rows: Emp[] = [
  { id: "1", tenantId: "t", name: "a", salary: 250_000, version: 1 },
  { id: "2", tenantId: "t", name: "b", salary: 50_000, version: 1 },
]

const entity: any = {
  name: "emp",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, salary: { type: "number" }, version: { type: "number" } },
}

function setup(plan: (row: Record<string, unknown>) => Record<string, FieldReadOverride>) {
  const repo: any = {
    findMany: vi.fn(async ({ filter }: any) => {
      const r = rows.filter((x) => evaluatePredicate(x, filter))
      return { rows: r, rowCount: r.length, page: 1, pageSize: 100 }
    }),
    insert: vi.fn(),
    updateOneWhereReturning: vi.fn(),
    deleteWhere: vi.fn(),
  }
  const decision = { allowed: true, scope: Predicate.alwaysTrue(), reasonCode: "x", evidence: [] }
  const authorizer: any = { assertCollectionAction: () => decision, assertWrite: () => undefined, fieldReadPlan: vi.fn(plan) }
  return { repo, repository: createAuthorizedRepository<Emp>({ repository: repo, entity, authorizer, structuralScope: Predicate.eq("tenantId", "t") }) }
}

describe("defect 5: field-query denials without a bundle", () => {
  it("rejects filtering on a field the read plan omits", async () => {
    const { repo, repository } = setup(() => ({ salary: "omit" }))
    await expect(repository.findMany({ filter: Predicate.gt("salary", 200_000) })).rejects.toBeInstanceOf(ForbiddenError)
    expect(repo.findMany).not.toHaveBeenCalled()
  })

  it("rejects sorting on a masked field", async () => {
    const { repository } = setup(() => ({ salary: "mask" }))
    await expect(repository.findMany({ sort: [{ field: "salary", direction: "desc" } as any] })).rejects.toBeInstanceOf(ForbiddenError)
  })

  it("treats an omit default as denying every field not explicitly allowed", async () => {
    const { repository } = setup(() => ({ "*": "omit", name: "allow" }))
    await expect(repository.findMany({ filter: Predicate.gt("salary", 1) })).rejects.toBeInstanceOf(ForbiddenError)
    await expect(repository.findMany({ filter: Predicate.eq("name", "a") })).resolves.toMatchObject({ rowCount: 1 })
  })

  it("fails closed when a row-conditional plan hides a queried field", async () => {
    const { repository } = setup((row) => (typeof row.salary === "number" && row.salary > 100_000 ? { salary: "omit" } : {}))
    await expect(repository.findMany({ filter: Predicate.gt("salary", 200_000) })).rejects.toBeInstanceOf(ForbiddenError)
  })

  it("still allows queries on readable fields", async () => {
    const { repository } = setup(() => ({ salary: "omit" }))
    const result = await repository.findMany({ filter: Predicate.eq("name", "a"), sort: [{ field: "name", direction: "asc" } as any] })
    expect(result.rows).toEqual([{ id: "1", tenantId: "t", name: "a", version: 1 }])
  })
})

describe("defect 6: router verifies the full provider scope", () => {
  const capabilities = { readConsistency: ["strong"], writable: true, localTransactions: true } as const

  it("rejects a provider bound to a different tenant", async () => {
    const provider: any = { scope: { kind: "tenant", tenantId: "tenant-b" } }
    const router = new TrustedPersistenceRouter({ primary: { capabilities, resolve: async () => provider } } as any)
    await expect(router.resolve({ source: "primary", scope: { kind: "tenant", tenantId: "tenant-a" }, access: "write", consistency: "strong" } as any))
      .rejects.toBeInstanceOf(ConfigurationError)
  })

  it("rejects a provider with an invalid scope as ConfigurationError", async () => {
    const provider: any = { scope: { kind: "tenant" } }
    const router = new TrustedPersistenceRouter({ primary: { capabilities, resolve: async () => provider } } as any)
    await expect(router.resolve({ source: "primary", scope: { kind: "tenant", tenantId: "tenant-a" }, access: "read", consistency: "strong" } as any))
      .rejects.toBeInstanceOf(ConfigurationError)
  })

  it("accepts a provider for the same scope", async () => {
    const provider: any = { scope: { kind: "tenant", tenantId: "tenant-a" } }
    const router = new TrustedPersistenceRouter({ primary: { capabilities, resolve: async () => provider } } as any)
    await expect(router.resolve({ source: "primary", scope: { kind: "tenant", tenantId: "tenant-a" }, access: "read", consistency: "strong" } as any))
      .resolves.toBe(provider)
  })
})
