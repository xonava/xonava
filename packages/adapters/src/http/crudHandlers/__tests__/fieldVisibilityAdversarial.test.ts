/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from "vitest"
import type { EntityDescriptor, PersistenceProvider } from "core/persistence"
import {
  Predicate,
  bindAbacSecurityDigest,
  type AbacPolicyBundle,
  type NormalizedAbacPolicy,
} from "core/domain"
import { createDetailHandler } from "../detail"
import { createListHandler } from "../list"
import type { CrudShared } from "../types"
import { canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

type TestRow = { id: string; classification: string; secretValue: string }
type TestShared = CrudShared<TestRow, TestRow, Partial<TestRow>, TestRow, TestRow>

const entity: EntityDescriptor<TestRow> = {
  name: "visibility-test",
  primaryKey: "id",
  fields: {
    id: { type: "string" },
    classification: { type: "string" },
    secretValue: { type: "string" },
  },
}

const DURABLE_ROW: TestRow = { id: "row-1", classification: "secret", secretValue: "1234" }

const policy: NormalizedAbacPolicy = {
  source: { policyId: "secret-policy", scopeType: "tenant_default" },
  moduleKey: "test.visibility",
  effect: "allow",
  priority: 100,
  payload: {
    actions: ["read"],
    capabilities: [],
    conditions: {
      version: 2,
      systemScope: { logic: "AND", conditions: [{ field: "classification", operator: "equals", value: "secret" }] },
      userFilters: { logic: "AND", conditions: [] },
    },
    fieldAccess: { read: { id: "allow", classification: "allow", secretValue: "omit" } },
  },
  compiledConditions: Predicate.eq("classification", "secret"),
}

const abacBundle: Promise<AbacPolicyBundle> = bindAbacSecurityDigest({
  mode: "tenant",
  moduleKey: "test.visibility",
  policies: [policy],
  context: { tenantId: "tenant-1" },
  defaultEffect: "deny",
  fieldCatalog: {},
})

type ListHookArgs = {
  result: { rows: TestRow[]; rowCount: number; page: number; pageSize: number }
  context: Record<string, unknown>
}

function makeSession() {
  return {
    scope: "tenant" as const,
    actor: { id: "actor-1", type: "tenant" as const, tenantId: "tenant-1" },
    tenant: { id: "tenant-1", enabledModuleKeys: [], enabledModuleActions: {} },
    raw: {} as never,
  }
}

function makeShared(config: {
  detailRewrite?: (row: TestRow, context?: Record<string, unknown>) => Record<string, unknown>
  listAfter?: (args: ListHookArgs) => ListHookArgs["result"] | Promise<ListHookArgs["result"]>
} = {}) {
  const currentSession = { value: makeSession() }
  const persistence = {
    dialect: "test",
    capabilities: {} as PersistenceProvider["capabilities"],
    repository: () => ({
      findMany: async () => ({ rows: [DURABLE_ROW], rowCount: 1, page: 1, pageSize: 10 }),
      findById: async () => DURABLE_ROW,
      findOneWhere: async () => DURABLE_ROW,
    }),
  } as unknown as PersistenceProvider
  const options = {
    adapterDeps: {
      resolveAbacBundle: async () => abacBundle,
    },
    requestNormalization: canonicalRequestNormalization(() => trustedSession({ kind: "tenant", tenantId: "tenant-1" }, currentSession.value.actor.id), "test.visibility"),
    scope: { scope: "tenant" as const },
    moduleKey: "test.visibility",
    entity,
    policy: { skipCapabilityCheck: true },
    // Query allowlists must be declared; an undeclared list allows nothing.
    filterableColumns: ["id", "classification", "secretValue"],
    cache: { enabled: false, tag: "test", keyPrefix: "test" },
    getCacheAdapter: async () => null as never,
    createPersistence: () => persistence,
    crud: {
      ...(config.detailRewrite
        ? {
               detail: {
                 projectResult: async ({ row, context }: { row: TestRow; context: Record<string, unknown> }) => config.detailRewrite!(row, context),
            },
          }
        : {}),
      ...(config.listAfter
        ? {
            list: {
                 projectResult: async (args: ListHookArgs) => config.listAfter!(args),
            },
          }
        : {}),
    },
  } as unknown as TestShared["options"]
  const shared = {
    options,
    entity,
    deps: options.adapterDeps,
    routes: { list: true, detail: true, create: false, update: false, delete: false },
    enforceReadAccess: async () => abacBundle,
    buildReadScope: () => ({ filter: undefined }),
    enforceReadRateLimit: async () => undefined,
    buildReadTags: () => [],
    resolveDefaultSort: () => undefined,
  } as unknown as TestShared
  options.createPersistence = () => persistence
  return shared
}

const ID = "00000000-0000-4000-8000-000000000001"

describe("field-read visibility is decided from the durable row", () => {
  it("omits a sensitive declared field even when a detail hook rewrites its policy-driving attribute", async () => {
    const shared = makeShared({ detailRewrite: (row) => ({ ...row, classification: "public" }) })
    const response = await createDetailHandler(shared)(new Request(`https://example.test/items/${ID}`), { id: ID })

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.classification).toBe("public")
    expect(body.secretValue).toBeUndefined()
  })

  it("does not expose hidden fields to a detail representation hook", async () => {
    let observed: Record<string, unknown> | undefined
    const shared = makeShared({
      detailRewrite: (row) => {
        observed = row
        return row
      },
    })

    const response = await createDetailHandler(shared)(new Request(`https://example.test/items/${ID}`), { id: ID })
    expect(response.status).toBe(200)
    expect(observed?.secretValue).toBeUndefined()
  })

  it("does not expose generic persistence through a detail hook context", async () => {
    let context: Record<string, unknown> | undefined
    const shared = makeShared({
      detailRewrite: (row, hookContext) => {
        context = hookContext
        return row
      },
    })

    const response = await createDetailHandler(shared)(new Request(`https://example.test/items/${ID}`), { id: ID })
    expect(response.status).toBe(200)
    expect(context).toEqual(expect.not.objectContaining({ persistence: expect.anything() }))
    expect(context?.operation).toBeDefined()
    expect(context?.operation).toEqual(expect.not.objectContaining({ persistence: expect.anything() }))
    expect(context?.operation).toEqual(expect.objectContaining({ operationId: expect.any(String), services: expect.anything() }))
  })

  it("cannot copy a hidden detail field into the visible response", async () => {
    const shared = makeShared({
      detailRewrite: () => ({ id: ID, classification: "public", secretValue: "copied" }),
    })

    const response = await createDetailHandler(shared)(new Request(`https://example.test/items/${ID}`), { id: ID })
    expect(response.status).toBe(200)
    expect((await response.json() as Record<string, unknown>).secretValue).toBeUndefined()
  })

  it("does not let a list enrichment hook change the visibility decision", async () => {
    const shared = makeShared({
      listAfter: async ({ result }) => ({
        ...result,
        rows: result.rows.map((row) => ({ ...row, classification: "public" })),
      }),
    })

    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { rows: Array<Record<string, unknown>> }
    expect(body.rows[0]?.classification).toBe("public")
    expect(body.rows[0]?.secretValue).toBeUndefined()
  })

  it("passes already-masked rows to the list after hook so the hook cannot observe sensitive values", async () => {
    const observed: Array<Array<Record<string, unknown>>> = []
    const shared = makeShared({
      listAfter: async ({ result }) => {
        observed.push(result.rows)
        return result
      },
    })

    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(200)
    expect(observed[0]?.[0]).toBeDefined()
    expect(observed[0]?.[0]?.secretValue).toBeUndefined()
    const body = (await response.json()) as { rows: Array<Record<string, unknown>> }
    expect(body.rows[0]?.secretValue).toBeUndefined()
  })

  it("does not expose generic persistence through a list hook context", async () => {
    let context: Record<string, unknown> | undefined
    const shared = makeShared({
      listAfter: async (args) => {
        context = args.context
        return args.result
      },
    })

    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(200)
    expect(context).toEqual(expect.not.objectContaining({ persistence: expect.anything() }))
    expect(context?.operation).toEqual(expect.not.objectContaining({ persistence: expect.anything() }))
  })

  it("cannot copy a hidden list field into the visible response", async () => {
    const shared = makeShared({
      listAfter: async ({ result }) => ({
        ...result,
        rows: result.rows.map((row) => ({ ...row, secretValue: "copied" })),
      }),
    })

    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(200)
    const body = await response.json() as { rows: Array<Record<string, unknown>> }
    expect(body.rows[0]?.secretValue).toBeUndefined()
  })

  it("throws when a list after hook changes a row's primary key", async () => {
    const shared = makeShared({
      listAfter: async ({ result }) => ({
        ...result,
        rows: result.rows.map((row) => ({ ...row, id: "fabricated-id" })),
      }),
    })

    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(403)
  })

  it("throws when a list after hook adds rows", async () => {
    const shared = makeShared({
      listAfter: async ({ result }) => ({
        ...result,
        rows: [...result.rows, { id: "extra-row", classification: "secret", secretValue: "9999" }],
      }),
    })

    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(403)
  })

  it("throws when a list after hook removes rows", async () => {
    const shared = makeShared({
      listAfter: async ({ result }) => ({
        ...result,
        rows: result.rows.slice(1),
      }),
    })

    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(403)
  })

  it("throws when a list after hook duplicates rows", async () => {
    const shared = makeShared({
      listAfter: async ({ result }) => ({
        ...result,
        rows: [result.rows[0]!, result.rows[0]!],
      }),
    })

    const response = await createListHandler(shared)(new Request("https://example.test/items"))
    expect(response.status).toBe(403)
  })

  it("rejects a caller filter on a masked field with a ValidationError", async () => {
    const shared = makeShared()
    const filters = encodeURIComponent(JSON.stringify({
      conditions: [{ field: "secretValue", operator: "eq", value: "1234" }],
    }))

    const response = await createListHandler(shared)(
      new Request(`https://example.test/items?filters=${filters}`),
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: string; code?: string }
    expect(body.code).toBe("VALIDATION_ERROR")
  })

  it("allows a caller filter on a field that is visible under the policy", async () => {
    const shared = makeShared()
    const filters = encodeURIComponent(JSON.stringify({
      conditions: [{ field: "classification", operator: "eq", value: "secret" }],
    }))

    const response = await createListHandler(shared)(
      new Request(`https://example.test/items?filters=${filters}`),
    )
    expect(response.status).toBe(200)
  })
})
