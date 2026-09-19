import { describe, expect, it, beforeEach } from "vitest"
import {
  Predicate,
  bindAbacSecurityDigest,
  createAbacAuthorizer,
  type NormalizedAbacPolicy,
  type VerifiedAbacPolicyBundle,
} from "core/domain"
import type { PersistenceProvider, VersionedRepository, UnversionedEntityDescriptor, VersionedEntityDescriptor } from "core/persistence"

interface TenantRow {
  id: string
  tenantId: string
  ownerId: string
  title: string
  secret: string
  version: number
}

const tenantEntity: VersionedEntityDescriptor<TenantRow> = {
  name: "framework_tenant_conformance_rows",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  immutableFields: ["tenantId"],
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    ownerId: { type: "string" },
    title: { type: "string" },
    secret: { type: "string" },
    version: { type: "number" },
  },
}

const globalEntity: UnversionedEntityDescriptor<{ id: string; value: string }> = {
  name: "framework_global_conformance_rows",
  primaryKey: "id",
  fields: { id: { type: "string" }, value: { type: "string" } },
}

export interface TenantAbacConformanceOptions {
  createProvider: () => PersistenceProvider
  createTenantProvider: (provider: PersistenceProvider, tenantId: string) => PersistenceProvider
}

function policy(overrides: Partial<NormalizedAbacPolicy> = {}): NormalizedAbacPolicy {
  return {
    source: { policyId: "tenant-conformance-policy", scopeType: "tenant_default" },
    moduleKey: "tenant.records",
    effect: "allow",
    priority: 10,
    payload: {
      actions: ["read", "update", "delete"],
      capabilities: ["export", "approve"],
      conditions: {
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
      },
      fieldAccess: {
        read: { secret: "mask", title: "allow" },
        write: ["title"],
      },
    },
    compiledConditions: Predicate.eq("ownerId", "user-1"),
    ...overrides,
  }
}

async function verifiedOwnerBundle(): Promise<VerifiedAbacPolicyBundle> {
  return bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: "tenant.records",
    policies: [policy()],
    context: { userId: "user-1", tenantId: "tenant-a" },
    defaultEffect: "deny",
    fieldCatalog: {},
  })
}

export function runTenantAbacConformanceTests(
  label: string,
  options: TenantAbacConformanceOptions,
): void {
  describe(`1.0-F tenant/ABAC conformance: ${label}`, () => {
    let provider: PersistenceProvider
    let unscoped: VersionedRepository<TenantRow, string>
    let scoped: VersionedRepository<TenantRow, string>
    let foreign: TenantRow

    beforeEach(async () => {
      provider = options.createProvider()
      unscoped = provider.repository(tenantEntity)
      scoped = options.createTenantProvider(provider, "tenant-a").repository(tenantEntity)
      await unscoped.insert({ id: "row-a", tenantId: "tenant-a", ownerId: "user-1", title: "A", secret: "a-secret", version: 1 })
      foreign = await unscoped.insert({ id: "row-b", tenantId: "tenant-b", ownerId: "user-2", title: "B", secret: "b-secret", version: 1 })
    })

    it("applies the tenant predicate to every read path", async () => {
      expect(await scoped.findById(foreign.id)).toBeNull()
      expect(await scoped.findOneWhere?.(Predicate.eq("id", foreign.id))).toBeNull()
      const result = await scoped.findMany({ filter: Predicate.alwaysTrue() })
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]?.tenantId).toBe("tenant-a")
    })

    it("applies the tenant predicate to every mutation path", async () => {
      await expect(scoped.update(foreign.id, { title: "blocked" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toThrow()
      await expect(scoped.delete(foreign.id, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toThrow()
      await expect(scoped.updateOneWhere?.(Predicate.eq("id", foreign.id), { title: "blocked" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toThrow()
      await expect(scoped.updateOneWhereReturning?.(Predicate.eq("id", foreign.id), { title: "blocked" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toThrow()
      await expect(scoped.deleteWhere?.(Predicate.eq("id", foreign.id), { optimisticConcurrency: { expectedVersion: 1 } })).resolves.toEqual({ deletedCount: 0 })
      expect((await unscoped.findById(foreign.id))?.title).toBe("B")
    })

    it("normalizes tenant inserts and rejects cross-tenant inserts", async () => {
      const normalized = await scoped.insert({ ownerId: "user-1", title: "normalized", secret: "secret", version: 1 })
      expect(normalized.tenantId).toBe("tenant-a")
      await expect(scoped.insert({ tenantId: "tenant-b", ownerId: "user-1", title: "wrong", secret: "secret", version: 1 })).rejects.toThrow()
    })

    it("rejects tenant-field mutation and global entities", async () => {
      await expect(scoped.update("row-a", { tenantId: "tenant-a" }, { optimisticConcurrency: { expectedVersion: 1 } })).rejects.toThrow()
      expect(() => options.createTenantProvider(provider, "tenant-a").repository(globalEntity)).toThrow()
    })

    it("makes module and action decisions fail closed", async () => {
      const authorizer = createAbacAuthorizer(await verifiedOwnerBundle())
      expect(authorizer.canRecordAction("read", { id: "row-a", ownerId: "user-1" })).toBe(true)
      expect(authorizer.canRecordAction("publish", { id: "row-a", ownerId: "user-1" })).toBe(false)
      const mismatchedPolicyBundle = await bindAbacSecurityDigest({
        mode: "tenant",
        moduleKey: "tenant.records",
        policies: [policy({ moduleKey: "other.module" })],
        context: { userId: "user-1", tenantId: "tenant-a" },
        defaultEffect: "deny",
        fieldCatalog: {},
      })
      expect(createAbacAuthorizer(mismatchedPolicyBundle).canRecordAction("read", { ownerId: "user-1" })).toBe(false)
      expect(authorizer.canRecordAction("read", { ownerId: "user-1" })).toBe(true)
    })

    it("enforces owner semantics and global versus record capabilities", async () => {
      const authorizer = createAbacAuthorizer(await verifiedOwnerBundle())
      expect(authorizer.canRecordAction("update", { ownerId: "user-1" })).toBe(true)
      expect(authorizer.canRecordAction("update", { ownerId: "user-2" })).toBe(false)
      expect(authorizer.canGlobalCapability("export")).toBe(false)
      expect(authorizer.canRecordCapability("approve", { ownerId: "user-1" })).toBe(true)
      expect(authorizer.canRecordCapability("approve", { ownerId: "user-2" })).toBe(false)
    })

    it("enforces field read and write access", async () => {
      const authorizer = createAbacAuthorizer(await verifiedOwnerBundle())
      expect(authorizer.fieldReadPlan({ ownerId: "user-1", title: "A", secret: "s" })).toMatchObject({ secret: "mask", title: "allow" })
      expect(() => authorizer.assertWrite({ action: "update", record: { ownerId: "user-1" }, changedFields: ["title"] })).not.toThrow()
      expect(() => authorizer.assertWrite({ action: "update", record: { ownerId: "user-1" }, changedFields: ["secret"] })).toThrow()
    })

    it("rejects unverified policy bundles", () => {
      const raw = {
        mode: "tenant" as const,
        moduleKey: "tenant.records",
        policies: [policy()],
        context: { userId: "user-1", tenantId: "tenant-a" },
        defaultEffect: "deny" as const,
        fieldCatalog: {},
      }
      expect(() => createAbacAuthorizer(raw as unknown as VerifiedAbacPolicyBundle)).toThrow("not a verified production bundle")
    })
  })
}
