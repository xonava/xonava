/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/unbound-method */
import { describe, it, expect, vi } from "vitest"
import { Predicate, evaluatePredicate, bindAbacSecurityDigest, createAbacAuthorizer, type VerifiedAbacPolicyBundle } from "@xonava/core/domain"
import { createAuthorizedRepository } from "../authorizedRepository"
import type { AbacAuthorizer, AbacCollectionDecision, NormalizedAbacPolicy } from "@xonava/core/domain"
import type { VersionedEntityDescriptor, VersionedRepository } from "@xonava/core/persistence"

interface TestRow {
  id: string
  tenantId: string
  name: string
  status: string
  version: number
  [key: string]: unknown
}

const testEntity: VersionedEntityDescriptor<TestRow> = {
  name: "test",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  immutableFields: ["id", "tenantId", "createdAt"],
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    version: { type: "number" },
  },
}

function createMockRepo(rows: TestRow[]): VersionedRepository<TestRow, string> {
  const data = [...rows]
  return {
    findMany: vi.fn(async ({ pagination, filter } = {}) => {
      const filtered = filter ? data.filter((r) => evaluatePredicate(r, filter)) : data
      const page = pagination?.page ?? 1
      const pageSize = pagination?.pageSize ?? 100
      const paged = filtered.slice((page - 1) * pageSize, page * pageSize)
      return { rows: paged as any, rowCount: filtered.length, page, pageSize }
    }),
    findById: vi.fn(async (id) => data.find((r) => r.id === id) ?? null),
    findOneWhere: vi.fn(async () => (data[0] ?? null) as any),
    insert: vi.fn(async (row: any) => row as TestRow),
    update: vi.fn(async (id, patch) => {
      const idx = data.findIndex((r) => r.id === id)
      if (idx === -1) throw new Error("not found")
      data[idx] = { ...data[idx], ...patch } as TestRow
      return data[idx]
    }),
     updateOneWhere: vi.fn(async () => ({ updatedCount: 1 })),
     updateOneWhereReturning: vi.fn(async (filter, patch) => {
       const row = data.find((candidate) => evaluatePredicate(candidate, filter))
       if (!row) return null
       Object.assign(row, patch)
       if (typeof row.version === "number") row.version += 1
       return { ...row }
     }),
    delete: vi.fn(async (id) => {
      const idx = data.findIndex((r) => r.id === id)
      if (idx !== -1) data.splice(idx, 1)
    }),
    deleteWhere: vi.fn(async () => ({ deletedCount: 1 })),
  }
}

function createAuthorizer(): AbacAuthorizer {
  return {
    canRecordAction: vi.fn(() => true),
    assertRecordAction: vi.fn(),
    authorizeCollection: vi.fn((): AbacCollectionDecision => ({ allowed: true, scope: Predicate.alwaysTrue(), reasonCode: "ACTION_SCOPE_AVAILABLE", evidence: [] })),
    assertCollectionAction: vi.fn((): AbacCollectionDecision => ({ allowed: true, scope: Predicate.alwaysTrue(), reasonCode: "ACTION_SCOPE_AVAILABLE", evidence: [] })),
    canGlobalCapability: vi.fn(() => true),
    assertGlobalCapability: vi.fn(),
    canRecordCapability: vi.fn(() => true),
    assertRecordCapability: vi.fn(),
    buildActionScope: vi.fn(() => ({ filter: Predicate.alwaysTrue() })),
    assertWrite: vi.fn(),
    fieldReadPlan: vi.fn(() => ({})),
  }
}

describe("createAuthorizedRepository", () => {
  it("findMany includes structural scope", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
      { id: "2", tenantId: "tenant-2", name: "B", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()

    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    const _result = await authorized.findMany()
    expect(repo.findMany).toHaveBeenCalled()
    expect(repo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ filter: expect.anything() }),
    )
  })

  it("insert rejects immutable fields", async () => {
    const repo = createMockRepo([])
    const auth = createAuthorizer()

    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    await expect(authorized.insert({
      id: "should-not-allow",
      name: "Test",
      status: "active",
    } as any)).rejects.toThrow("immutable")
  })

  it("update rejects immutable fields in patch", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()

    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    await expect(authorized.update("1", { id: "new-id" } as any, { expectedVersion: 1 })).rejects.toThrow("immutable")
  })

  it("update rejects tenant field changes", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()

    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    await expect(authorized.update("1", { tenantId: "tenant-2" } as any, { expectedVersion: 1 })).rejects.toThrow("tenant")
  })

  it("update with expectedVersion uses versionField", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()

    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    const result = await authorized.update("1", { name: "B" }, { expectedVersion: 1 })
    expect(result.applied).toBe(true)
  })

  it("delete returns applied true for existing row", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()

    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    const result = await authorized.delete("1", { expectedVersion: 1 })
    expect(result.applied).toBe(true)
  })

  it("delete returns not found for nonexistent row", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()

    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    const result = await authorized.delete("nonexistent", { expectedVersion: 1 })
    expect(result.applied).toBe(false)
    expect(result.reason).toBe("NOT_FOUND")
  })

  it("uses structural and action scopes for update and delete predicates", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()
    auth.assertCollectionAction = vi.fn((action: string): AbacCollectionDecision => ({
      allowed: true,
      scope: action === "read" ? Predicate.alwaysTrue() : Predicate.eq("status", "active"),
      reasonCode: "ACTION_SCOPE_AVAILABLE",
      evidence: [],
    }))

    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    await authorized.update("1", { name: "B" }, { expectedVersion: 1 })
     const updateFilter = (repo.updateOneWhereReturning as any).mock.calls[0][0]
    const row = rows[0]!
    expect(evaluatePredicate({ ...row, version: 1 }, updateFilter)).toBe(true)
    expect(evaluatePredicate({ ...row, version: 1, tenantId: "tenant-2" }, updateFilter)).toBe(false)
    expect(evaluatePredicate({ ...row, version: 1, status: "inactive" }, updateFilter)).toBe(false)

    await authorized.delete("1", { expectedVersion: 2 })
    const deleteFilter = (repo.deleteWhere as any).mock.calls[0][0]
    expect(evaluatePredicate({ ...row, version: 2 }, deleteFilter)).toBe(true)
    expect(evaluatePredicate({ ...row, version: 2, status: "inactive" }, deleteFilter)).toBe(false)
  })

  it("re-reads updated rows under the database read scope", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()
    auth.assertCollectionAction = vi.fn((action: string): AbacCollectionDecision => ({
      allowed: true,
      scope: action === "read" ? Predicate.eq("status", "visible") : Predicate.alwaysTrue(),
      reasonCode: "ACTION_SCOPE_AVAILABLE",
      evidence: [],
    }))

    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    const result = await authorized.update("1", { name: "B" }, { expectedVersion: 1 })

    expect(result).toEqual({ applied: true, reason: "UPDATED_OUTSIDE_READ_SCOPE" })
    expect(repo.findMany).toHaveBeenCalledTimes(2)
  })

  it("returns the committed update row when a newer write races response construction", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const findMany = vi.mocked(repo.findMany)
    const originalFindMany = findMany.getMockImplementation()
    if (!originalFindMany) throw new Error("Expected mocked findMany implementation")
    findMany.mockImplementation(async (options = {}) => {
      const result = await originalFindMany(options)
      // Model a newer writer winning immediately after the conditional
      // mutation, while the response path is still being built.
      if (result.rows[0]?.version === 2) rows[0] = { ...rows[0]!, name: "newer", version: 3 }
      return result.rows.length > 0 ? { ...result, rows: [{ ...rows[0] } as TestRow] } : result
    })
    const auth = createAuthorizer()
    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })

    const result = await authorized.update("1", { name: "committed" }, { expectedVersion: 1 })

    expect(result).toEqual({
      applied: true,
      row: { id: "1", tenantId: "tenant-1", name: "committed", status: "active", version: 2 },
    })
  })

  it("refuses to construct when an entity has no version field", async () => {
    const repo = createMockRepo([{ id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 }])
    const auth = createAuthorizer()
    const { versionField: _versionField, ...entityWithoutVersion } = testEntity
    expect(() => createAuthorizedRepository({
      repository: repo,
      entity: entityWithoutVersion,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
    })).toThrow("requires a versionField")
  })

  async function maskedStatusBundle(): Promise<VerifiedAbacPolicyBundle> {
    const policy: NormalizedAbacPolicy = {
      source: { policyId: "mask-status", scopeType: "tenant_default" },
      moduleKey: "test",
      effect: "allow",
      priority: 100,
      payload: {
        actions: ["read"],
        capabilities: [],
        conditions: {
          version: 2,
          systemScope: { logic: "AND", conditions: [] },
          userFilters: { logic: "AND", conditions: [] },
        },
        // The read map is an allowlist: name must be listed to stay readable
        // (and therefore queryable).
        fieldAccess: { read: { status: "mask", name: "allow" } },
      },
      compiledConditions: Predicate.alwaysTrue(),
    }
    return bindAbacSecurityDigest({
      mode: "tenant",
      moduleKey: "test",
      policies: [policy],
      context: { tenantId: "tenant-1" },
      defaultEffect: "deny",
      fieldCatalog: {},
    })
  }

  it("rejects caller filter/sort fields that ABAC masks from responses", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()
    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
      bundle: await maskedStatusBundle(),
    })

    await expect(authorized.findMany({ filter: Predicate.eq("status", "active") }))
      .rejects.toThrow("not permitted")
    await expect(authorized.findMany({ sort: [{ field: "status", direction: "asc" as const }] }))
      .rejects.toThrow("not permitted")
    expect(repo.findMany).not.toHaveBeenCalled()
  })

  it("allows caller filter/sort on fields that are not masked", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()
    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
      bundle: await maskedStatusBundle(),
    })

    const result = await authorized.findMany({
      filter: Predicate.eq("name", "A"),
      sort: [{ field: "name", direction: "asc" as const }],
    })
    expect(result.rows).toHaveLength(1)
  })

  it("rejects nested caller predicates that reference a masked field", async () => {
    const rows: TestRow[] = [
      { id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1 },
    ]
    const repo = createMockRepo(rows)
    const auth = createAuthorizer()
    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: testEntity,
      authorizer: auth,
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
      bundle: await maskedStatusBundle(),
    })

    await expect(authorized.findMany({
      filter: Predicate.or(
        Predicate.eq("name", "A"),
        Predicate.eq("status", "active"),
      ),
    })).rejects.toThrow("not permitted")
  })
})

describe("createAuthorizedRepository ABAC hardening", () => {
  const MODULE = "test.module"
  const salaryEntity: VersionedEntityDescriptor<TestRow> = {
    ...testEntity,
    fields: { ...testEntity.fields, salary: { type: "number" }, locked: { type: "boolean" }, price: { type: "number" } },
  }

  function abacPolicy(id: string, overrides: Partial<NormalizedAbacPolicy>, fieldAccess?: NormalizedAbacPolicy["payload"]["fieldAccess"]): NormalizedAbacPolicy {
    return {
      source: { policyId: id, scopeType: "tenant_default" },
      moduleKey: MODULE,
      effect: "allow",
      priority: 10,
      payload: {
        actions: ["read", "update"],
        capabilities: [],
        conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
        ...(fieldAccess ? { fieldAccess } : {}),
      },
      compiledConditions: Predicate.alwaysTrue(),
      ...overrides,
    }
  }

  async function verifiedBundle(policies: NormalizedAbacPolicy[]): Promise<VerifiedAbacPolicyBundle> {
    return bindAbacSecurityDigest({
      mode: "tenant",
      moduleKey: MODULE,
      policies,
      context: { tenantId: "tenant-1" },
      defaultEffect: "deny",
      fieldCatalog: { id: { key: "id", type: "string", operators: ["equals"] } },
    })
  }

  it("rejects filter and sort on an entity field outside a read allowlist", async () => {
    const bundle = await verifiedBundle([abacPolicy("allowlist", {}, { read: { id: "allow", name: "allow" } })])
    const authorized = createAuthorizedRepository({
      repository: createMockRepo([{ id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1, salary: 10 }]),
      entity: salaryEntity,
      authorizer: createAbacAuthorizer(bundle),
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
      bundle,
    })
    await expect(authorized.findMany({ filter: Predicate.gt("salary", 5) })).rejects.toThrow("not permitted by policy")
    await expect(authorized.findMany({ sort: [{ field: "salary", direction: "asc" }] })).rejects.toThrow("not permitted by policy")
    await expect(authorized.findMany({ filter: Predicate.eq("name", "A") })).resolves.toBeDefined()
  })

  it("decides field writes against the pre-image as well as the post-image", async () => {
    const bundle = await verifiedBundle([
      abacPolicy("locked", { priority: 100, compiledConditions: Predicate.isTrue("locked") }, { write: ["name"] }),
      abacPolicy("all", { priority: 10 }),
    ])
    const repo = createMockRepo([{ id: "1", tenantId: "tenant-1", name: "A", status: "active", version: 1, locked: true, price: 10 }])
    const authorized = createAuthorizedRepository({
      repository: repo,
      entity: salaryEntity,
      authorizer: createAbacAuthorizer(bundle),
      structuralScope: Predicate.eq("tenantId", "tenant-1"),
      bundle,
    })
    await expect(authorized.update("1", { locked: false, price: 0 }, { expectedVersion: 1 })).rejects.toThrow("permission to update one or more fields")
    expect(repo.updateOneWhereReturning).not.toHaveBeenCalled()
    await expect(authorized.update("1", { name: "B" }, { expectedVersion: 1 })).resolves.toMatchObject({ applied: true })
  })
})
