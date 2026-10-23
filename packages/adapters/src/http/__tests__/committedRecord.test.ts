// @ts-nocheck
import { describe, expect, it, vi, type Mock } from "vitest"
import { Predicate, bindAbacSecurityDigest, evaluatePredicate, type PredicateNode, type RequestContext } from "@xonava/core/domain"
import type { IdempotencyPort, TransactionalIdempotencyPort } from "@xonava/core/events"
import type { EntityDescriptor, PersistenceProvider } from "@xonava/core/persistence"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import { readCommittedRecord, type ReadCommittedRecordArgs } from "../index"
import { normalizeCrudRequest } from "../crudHandlers/shared"
import type { SerializedResponse } from "../idempotency"
import type { FrameworkAdapterDeps } from "../../server"
import { allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"

const MODULE = "test.invoices"

type Row = { id: string; tenantId: string; ownerId: string; title: string; secret: string; version: number }

const entity: EntityDescriptor<Row> = {
  name: "invoice",
  primaryKey: "id",
  tenantField: "tenantId",
  versionField: "version",
  fields: {
    id: { type: "string" },
    tenantId: { type: "string" },
    ownerId: { type: "string" },
    title: { type: "string" },
    secret: { type: "string" },
    version: { type: "number" },
  },
}

type PolicyOptions = { scope?: PredicateNode; hideSecret?: boolean; actions?: string[] }

async function bundle(options: PolicyOptions = {}) {
  return bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: MODULE,
    policies: [{
      source: { policyId: "p1", scopeType: "tenant_default" as const },
      moduleKey: MODULE,
      effect: "allow",
      priority: 1,
      payload: {
        actions: options.actions ?? ["read", "approve"],
        capabilities: [],
        conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
        ...(options.hideSecret ? { fieldAccess: { read: { id: "allow", tenantId: "allow", ownerId: "allow", title: "allow", version: "allow" } } } : {}),
      },
      compiledConditions: options.scope ?? Predicate.alwaysTrue(),
    }],
    context: { tenantId: "tenant-1" },
    defaultEffect: "deny",
    fieldCatalog: {},
  } as never)
}

/** In-memory rows keyed by id; honours the predicate the framework builds, like a real repository. */
function memoryPersistence(rows: Map<string, Row>) {
  const findMany = vi.fn(async ({ filter }: { filter?: PredicateNode }) => {
    const selected = [...rows.values()].filter((row) => !filter || evaluatePredicate(row, filter))
    return { rows: selected, rowCount: selected.length, page: 1, pageSize: 1 }
  })
  const persistence = {
    dialect: "test",
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: false, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: () => ({ findMany }),
    runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => work(persistence),
  } as unknown as PersistenceProvider
  return { persistence, findMany }
}

const invoice = (overrides: Partial<Row> = {}): Row => ({ id: "inv-1", tenantId: "tenant-1", ownerId: "actor-1", title: "Invoice", secret: "s3cret", version: 2, ...overrides })

async function requestContext(tenantId = "tenant-1"): Promise<RequestContext> {
  const normalization = canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId }, "actor-1"), MODULE)
  return normalizeCrudRequest({
    request: new Request("https://example.test/invoices/inv-1"),
    routeKey: "detail",
    normalization,
    requestId: "req-1",
    correlationId: "corr-1",
  })
}

async function setup(options: { rows?: Row[]; policy?: PolicyOptions } = {}) {
  const rows = new Map((options.rows ?? [invoice()]).map((row) => [row.id, row]))
  const store = memoryPersistence(rows)
  const abac = await bundle(options.policy)
  const resolveAbacBundle = vi.fn(async () => abac)
  const context = await requestContext()
  const args = (overrides: Partial<ReadCommittedRecordArgs<Row>> = {}): ReadCommittedRecordArgs<Row> => ({
    entity,
    moduleKey: MODULE,
    context,
    persistence: store.persistence,
    adapterDeps: { resolveAbacBundle },
    entityScope: { kind: "tenant" },
    id: "inv-1",
    committedVersion: 2,
    ...overrides,
  })
  return { rows, args, resolveAbacBundle, ...store }
}

describe("readCommittedRecord", () => {
  it("returns the committed record projected with the caller's field-read overrides", async () => {
    const { args } = await setup({ policy: { hideSecret: true } })
    const result = await readCommittedRecord(args())
    expect(result).toEqual({ kind: "record", record: { id: "inv-1", tenantId: "tenant-1", ownerId: "actor-1", title: "Invoice", version: 2 } })
    expect(result.kind === "record" && "secret" in result.record).toBe(false)
  })

  it("returns every declared field when no override applies", async () => {
    const { args } = await setup()
    expect(await readCommittedRecord(args())).toEqual({ kind: "record", record: invoice() })
  })

  it("answers outside-read-scope when the read scope excludes an existing row", async () => {
    const { args } = await setup({ policy: { scope: Predicate.eq("ownerId", "someone-else") } })
    expect(await readCommittedRecord(args())).toEqual({ kind: "outside-read-scope" })
  })

  it("answers revision-unavailable (never the newer record) when the stored version moved on", async () => {
    const { args } = await setup({ rows: [invoice({ version: 3, title: "Newer" })] })
    expect(await readCommittedRecord(args({ committedVersion: 2 }))).toEqual({ kind: "revision-unavailable" })
    expect(await readCommittedRecord(args({ committedVersion: 3 }))).toMatchObject({ kind: "record", record: { title: "Newer", version: 3 } })
  })

  it("answers deleted when the row no longer exists", async () => {
    const { args, rows } = await setup()
    rows.delete("inv-1")
    expect(await readCommittedRecord(args())).toEqual({ kind: "deleted" })
  })

  it("never reads outside the structural scope when separating deleted from outside-read-scope", async () => {
    // The same id exists, but only in another tenant: structurally invisible, so it is deleted, not outside-read-scope.
    const { args, findMany } = await setup({ rows: [invoice({ tenantId: "tenant-2" })], policy: { scope: Predicate.eq("ownerId", "someone-else") } })
    expect(await readCommittedRecord(args())).toEqual({ kind: "deleted" })
    const filters = findMany.mock.calls.map(([call]) => JSON.stringify(call.filter))
    expect(filters.length).toBeGreaterThan(0)
    for (const filter of filters) expect(filter).toContain("tenant-1")
  })

  it("does the extra structural read only when the scoped read misses", async () => {
    const hit = await setup()
    await readCommittedRecord(hit.args())
    expect(hit.findMany).toHaveBeenCalledTimes(1)
    const miss = await setup({ rows: [] })
    await readCommittedRecord(miss.args())
    expect(miss.findMany).toHaveBeenCalledTimes(2)
  })

  it("keeps outside-read-scope and revision checks ordered: scope first, then revision", async () => {
    const { args } = await setup({ rows: [invoice({ version: 5 })], policy: { scope: Predicate.eq("ownerId", "someone-else") } })
    expect(await readCommittedRecord(args({ committedVersion: 2 }))).toEqual({ kind: "outside-read-scope" })
  })
})

describe("readCommittedRecord from a business-action write handler", () => {
  type Harness = Awaited<ReturnType<typeof harness>>

  async function harness(options: { crashOnFirstComplete?: boolean } = {}) {
    const rows = new Map<string, Row>()
    const store = memoryPersistence(rows)
    const abac = await bundle({ hideSecret: true })
    const execute = vi.fn(async () => {
      rows.set("inv-1", invoice({ version: 2, title: "Approved" }))
      return { id: "inv-1", version: 2 }
    })
    const adapterDeps = { resolveAbacBundle: async () => abac }
    const readArgs = (context: RequestContext, extra: Partial<ReadCommittedRecordArgs<Row>>): ReadCommittedRecordArgs<Row> => ({
      entity, moduleKey: MODULE, context, persistence: store.persistence, adapterDeps, entityScope: { kind: "tenant" }, id: "inv-1", ...extra,
    })

    // Idempotency port: replay once complete() has succeeded; business-committed after a crash in complete().
    let committed = false
    let finalized: SerializedResponse | undefined
    let failComplete = options.crashOnFirstComplete === true
    const port: TransactionalIdempotencyPort<SerializedResponse> = {
      acquire: vi.fn(async () => finalized
        ? { outcome: "replay" as const, result: finalized }
        : committed
          ? { outcome: "business-committed" as const, token: "token-2", resource: { entity: "invoice", id: "inv-1", version: 2 } }
          : { outcome: "acquired" as const, token: "token-1" }),
      renew: vi.fn(async () => undefined),
      markCommittedInTransaction: vi.fn(async () => undefined),
      complete: vi.fn(async ({ result }: { result: SerializedResponse }) => {
        if (failComplete) { failComplete = false; committed = true; throw new Error("crash before finalize") }
        finalized = result
      }),
    } as never
    const deps: FrameworkAdapterDeps = {
      assertValidCsrf: vi.fn(),
      resolveAbacBundle: vi.fn(async () => abac),
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
      createIdempotencyPort: <TResult>() => port as unknown as IdempotencyPort<TResult>,
    }
    const base = canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }, "actor-1"), MODULE)
    const approve = Object.freeze({ ...base.routeBindings.update, routeKey: "test.approve", method: "POST", operationKey: `${MODULE}.approve` })
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: { ...base, routeBindings: Object.freeze({ ...base.routeBindings, approve }) },
      scope: { scope: "tenant", idempotency: { required: true } },
      moduleKey: MODULE,
      action: "approve",
      skipCapabilityCheck: true,
      runtimeCapabilities: { deferredExecution: true, cache: true },
      createPersistence: () => store.persistence,
      definition: {
        key: `${MODULE}.approve`,
        kind: "mutation",
        atomicity: { kind: "standard", mode: "required" },
        authorization: { authorize: async () => ({ allowed: true }) },
        execute,
        after: async ({ operation, result }: { operation: { request?: RequestContext }; result: { id: string; version: number } }) => {
          const committedRecord = await readCommittedRecord(readArgs(operation.request!, { committedVersion: result.version }))
          return committedRecord.kind === "record" ? { record: committedRecord.record } : { success: true }
        },
      } as never,
      validation: { body: { parse: (value: unknown) => value, parseAsync: async (value: unknown) => value } },
      resolveInput: async () => ({}),
      resolveResourceIdentity: () => ({ entity: "invoice", id: "inv-1", version: 2 }),
      recoverCommittedResponse: async ({ resource, context }) => {
        const committedRecord = await readCommittedRecord(readArgs(context, { id: resource.id, ...(resource.version !== undefined ? { committedVersion: resource.version } : {}) }))
        return committedRecord.kind === "record" ? { record: committedRecord.record } : null
      },
      toResponse: (result: unknown) => Response.json("record" in (result as object) ? (result as { record: unknown }).record : result),
    })
    const send = (key = "key-1") => handler(new Request("https://example.test/invoices/inv-1/approve", {
      method: "POST", body: "{}", headers: { "content-type": "application/json", "Idempotency-Key": key },
    }))
    return { send, execute, port, rows }
  }

  const projected = { id: "inv-1", tenantId: "tenant-1", ownerId: "actor-1", title: "Approved", version: 2 }

  it("builds the initial response and an idempotent replay from the same projection", async () => {
    const h: Harness = await harness()
    const first = await h.send()
    expect(first.status, await first.clone().text()).toBe(200)
    expect(await first.json()).toEqual(projected)
    const replay = await h.send()
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual(projected)
    expect(h.execute).toHaveBeenCalledOnce()
  })

  it("recovers a crashed commit through the same function with an identical projection", async () => {
    const h: Harness = await harness({ crashOnFirstComplete: true })
    const crashed = await h.send()
    expect(crashed.status).toBe(500)
    const recovered = await h.send()
    expect(recovered.status, await recovered.clone().text()).toBe(200)
    expect(await recovered.json()).toEqual(projected)
    expect(h.execute).toHaveBeenCalledOnce()
    expect((h.port.complete as Mock)).toHaveBeenCalledTimes(2)
  })
})
