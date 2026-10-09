import { describe, expect, it } from "vitest"
import type { EntityDescriptor, PersistenceProvider } from "core/persistence"
import { Predicate, bindAbacSecurityDigest, type AbacPolicyBundle, type NormalizedAbacPolicy } from "core/domain"
import { createListHandler } from "../list"
import type { CrudShared } from "../types"
import { canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type Row = { id: string; classification: string; secretValue: string }
type Shared = CrudShared<Row, Row, Partial<Row>, Row, Row>

const entity: EntityDescriptor<Row> = {
  name: "allowlist-test",
  primaryKey: "id",
  fields: { id: { type: "string" }, classification: { type: "string" }, secretValue: { type: "string" } },
}

// A read ALLOWLIST: secretValue is never mentioned, so it is hidden from
// responses and must not be usable as a filter/sort oracle either.
const policy: NormalizedAbacPolicy = {
  source: { policyId: "allowlist", scopeType: "tenant_default" },
  moduleKey: "test.allowlist",
  effect: "allow",
  priority: 100,
  payload: {
    actions: ["read"],
    capabilities: [],
    conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
    fieldAccess: { read: { id: "allow", classification: "allow" } },
  },
  compiledConditions: Predicate.literal(true),
}

const bundle: Promise<AbacPolicyBundle> = bindAbacSecurityDigest({
  mode: "tenant",
  moduleKey: "test.allowlist",
  policies: [policy],
  context: { tenantId: "tenant-1" },
  defaultEffect: "deny",
  fieldCatalog: {},
})

function shared(): Shared {
  const persistence = {
    dialect: "test",
    capabilities: {} as PersistenceProvider["capabilities"],
    repository: () => ({ findMany: async () => ({ rows: [{ id: "r1", classification: "c", secretValue: "1234" }], rowCount: 1, page: 1, pageSize: 10 }) }),
  } as unknown as PersistenceProvider
  const options = {
    adapterDeps: { resolveAbacBundle: async () => bundle },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), "test.allowlist"),
    scope: { scope: "tenant" as const },
    moduleKey: "test.allowlist",
    entity,
    policy: { skipCapabilityCheck: true },
    filterableColumns: ["id", "classification", "secretValue"],
    sortableColumns: ["id", "classification", "secretValue"],
    cache: { enabled: false, tag: "test", keyPrefix: "test" },
    getCacheAdapter: async () => null as never,
    createPersistence: () => persistence,
  } as unknown as Shared["options"]
  return {
    options,
    entity,
    deps: options.adapterDeps,
    routes: { list: true, detail: false, create: false, update: false, delete: false },
    enforceReadAccess: async () => bundle,
    buildReadScope: () => ({ filter: undefined }),
    enforceReadRateLimit: async () => undefined,
    buildReadTags: () => [],
    resolveDefaultSort: () => undefined,
  } as unknown as Shared
}

const list = (query: string) => createListHandler(shared())(new Request(`https://example.test/items${query}`))

describe("list query gating under a read allowlist", () => {
  it("rejects filtering on a field omitted by the allowlist", async () => {
    const filters = encodeURIComponent(JSON.stringify({ conditions: [{ field: "secretValue", operator: "eq", value: "1234" }] }))
    const response = await list(`?filters=${filters}`)
    expect(response.status).toBe(400)
  })

  it("rejects sorting on a field omitted by the allowlist", async () => {
    const sorting = encodeURIComponent(JSON.stringify([{ id: "secretValue", desc: false }]))
    const response = await list(`?sorting=${sorting}`)
    expect(response.status).toBe(400)
  })

  it("still allows querying allowlisted fields", async () => {
    const filters = encodeURIComponent(JSON.stringify({ conditions: [{ field: "classification", operator: "eq", value: "c" }] }))
    const sorting = encodeURIComponent(JSON.stringify([{ id: "classification", desc: true }]))
    const response = await list(`?filters=${filters}&sorting=${sorting}`)
    expect(response.status, await response.clone().text()).toBe(200)
  })
})
