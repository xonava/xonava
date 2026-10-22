import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createAnonymousPrincipal, ForbiddenError, type RequestContext } from "@xonava/core/domain"
import type { CompiledRouteBinding, CompiledScopeResolverBinding } from "@xonava/core/bootstrap"
import { defineEntity } from "@xonava/core/entity"
import type { AuditRecord, IdempotencyPort, OutboxRecord } from "@xonava/core/events"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { createVerifiedScopeResolution, type ScopeResolver } from "@xonava/core/security"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import type { CrudScopeConfig } from "../createFrameworkWriteHandler"
import { CRUD } from "../crud"
import type { SerializedResponse } from "../idempotency"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "../../server"
import { allowAllAbacBundle, allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"

// TM8: cross-site request forgery on cookie-authenticated write routes. The
// check is `deps.assertValidCsrf(request)`, run by every write handler built
// on createFrameworkWriteHandler (create, update, delete and custom writes).

const MODULE = "csrf.people"
const CSRF_MESSAGE = "csrf token is invalid"

type Row = { id: string; tenantId: string; name: string; version: number }

const jsonHeaders = { "content-type": "application/json", "Idempotency-Key": "key-1", "if-match": "1" }

/** Everything a refused write must leave untouched, plus the order-sensitive collaborators. */
function probes() {
  const row: Row = { id: "r1", tenantId: "tenant-1", name: "before", version: 1 }
  const repository = {
    findById: vi.fn(async () => ({ ...row })),
    findOneWhere: vi.fn(async () => ({ ...row })),
    findMany: vi.fn(async () => ({ rows: [{ ...row }], rowCount: 1, page: 1, pageSize: 20 })),
    insert: vi.fn(async (data: Row) => ({ ...data })),
    update: vi.fn(async (_id: string, patch: Partial<Row>) => ({ ...row, ...patch })),
    delete: vi.fn(async () => undefined),
    updateOneWhereReturning: vi.fn(async (_filter: unknown, patch: Partial<Row>) => ({ ...row, ...patch, version: 2 })),
    deleteWhere: vi.fn(async () => ({ deletedCount: 1 })),
  }
  const persistence: PersistenceProvider = {
    dialect: "test",
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: true, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: () => repository,
    runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => work(persistence),
  } as unknown as PersistenceProvider
  const createPersistence = vi.fn((_context: RequestContext) => persistence)
  const audit = vi.fn(async (_record: AuditRecord) => undefined)
  const outbox = vi.fn(async (_record: OutboxRecord) => undefined)
  const acquire = vi.fn(async () => ({ outcome: "acquired" as const, token: "token-1" }))
  const idempotencyPort = {
    acquire,
    renew: async () => undefined,
    markCommittedInTransaction: async () => undefined,
    complete: async () => undefined,
  } as unknown as IdempotencyPort<SerializedResponse>
  const createIdempotencyPort = vi.fn()
  const resolveAbacBundle = vi.fn(async ({ moduleKey }: { moduleKey: string }) => allowAllAbacBundle(moduleKey))
  const assertValidCsrf = vi.fn<(request: Request) => void>()
  const deps: FrameworkAdapterDeps = {
    assertValidCsrf,
    resolveAbacBundle,
    resolveModuleAuthorizationFacts: allowAllModuleFacts,
    createIdempotencyPort: <TResult>(args: { context: RequestContext }) => {
      createIdempotencyPort(args)
      return idempotencyPort as unknown as IdempotencyPort<TResult>
    },
  }
  const untouched = () => {
    for (const fn of Object.values(repository)) expect(fn).not.toHaveBeenCalled()
    expect(createPersistence).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    expect(outbox).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(createIdempotencyPort).not.toHaveBeenCalled()
  }
  return { repository, createPersistence, audit, outbox, acquire, createIdempotencyPort, resolveAbacBundle, assertValidCsrf, deps, untouched, persistence }
}

type Probes = ReturnType<typeof probes>

function rejectCsrf(p: Probes): void {
  p.assertValidCsrf.mockImplementation(() => { throw new ForbiddenError(CSRF_MESSAGE) })
}

const entity = defineEntity<Row, { name: string }, { name: string }>({
  moduleKey: MODULE,
  entity: { name: "person", primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" } } },
  entityScope: { kind: "tenant" },
  policy: { skipCapabilityCheck: true },
  cache: false,
  audit: {},
  validation: { createBody: z.object({ name: z.string() }), updateBody: z.object({ name: z.string() }), idParams: z.object({ id: z.string() }) },
})

function crudFor(p: Probes, scope: CrudScopeConfig = { scope: "tenant", idempotency: { required: true } }) {
  return CRUD(entity, {
    adapterDeps: p.deps,
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), MODULE),
    scope,
    createPersistence: p.createPersistence,
    getCacheAdapter: vi.fn(),
    runtimeCapabilities: { deferredExecution: true, cache: true },
    auditSinkFactory: () => ({ write: p.audit }),
  })
}

const post = (body: unknown = { name: "after" }) => new Request("https://example.test/items", { method: "POST", body: JSON.stringify(body), headers: jsonHeaders })
const patch = (body: unknown = { name: "after" }) => new Request("https://example.test/items/r1", { method: "PATCH", body: JSON.stringify(body), headers: jsonHeaders })
const remove = () => new Request("https://example.test/items/r1", { method: "DELETE", headers: jsonHeaders })
const params = { params: Promise.resolve({ id: "r1" }) }

async function expectCsrfRefusal(response: Response): Promise<void> {
  const text = await response.clone().text()
  expect(response.status, text).toBe(403)
  expect(text).toContain("FORBIDDEN")
}

/** A custom write handler: the same wrapper CRUD uses, with an application-defined operation. */
function customWrite(p: Probes, options: { scope?: CrudScopeConfig; normalization?: FrameworkRequestNormalization; body?: z.ZodType } = {}) {
  const execute = vi.fn(async () => ({ ok: true }))
  const handler = createFrameworkWriteHandler({
    adapterDeps: p.deps,
    requestNormalization: options.normalization ?? canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), MODULE),
    scope: options.scope ?? { scope: "tenant", idempotency: { required: true } },
    moduleKey: MODULE,
    action: "update",
    skipCapabilityCheck: true,
    runtimeCapabilities: { deferredExecution: true, cache: true },
    createPersistence: p.createPersistence,
    auditSinkFactory: () => ({ write: p.audit }),
    outboxSinkFactory: () => ({ append: p.outbox }),
    definition: {
      key: `${MODULE}.update`,
      kind: "mutation",
      atomicity: { kind: "standard", mode: "required" },
      authorization: { authorize: async () => ({ allowed: true }) },
      audit: { action: "person.custom", resourceType: "person", resolveResourceId: () => "r1" },
      execute,
    } as never,
    validation: { body: options.body ?? { parse: (value: unknown) => value, parseAsync: async (value: unknown) => value } } as never,
    resolveInput: async () => ({}),
    resolveResourceIdentity: () => ({ entity: "person", id: "r1" }),
    recoverCommittedResponse: async () => ({ ok: true }),
  })
  return { handler, execute }
}

const customRequest = (body: unknown = { note: "x" }) =>
  new Request("https://example.test/items/r1/custom", { method: "POST", body: JSON.stringify(body), headers: jsonHeaders })

/** A public route (no session) that resolves a tenant, so the actor is anonymous. */
function anonymousNormalization(): FrameworkRequestNormalization {
  const base = canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), MODULE)
  const resolver: ScopeResolver = { key: "directory", resolve: async () => createVerifiedScopeResolution("directory", { kind: "tenant", tenantId: "tenant-1" }) }
  const binding: CompiledScopeResolverBinding = { key: "directory", definitionVersion: 1, resolver, allowedTargetKinds: ["tenant"] }
  const route: CompiledRouteBinding = {
    ...base.routeBindings.update,
    exposure: "public",
    scopeResolution: { kind: "resolver", resolverKey: "directory", allowedTargetKinds: ["tenant"] },
    anonymousPrincipal: { allowed: true, principal: createAnonymousPrincipal() },
  }
  return { ...base, routeBindings: Object.freeze({ ...base.routeBindings, update: route }), resolverBindings: new Map([["directory", binding]]), resolveTrustedSession: async () => undefined }
}

describe("TM8 CSRF enforcement on write routes", () => {
  describe("a failing check on a non-public scope", () => {
    it("refuses create with no repository call, no audit record and no idempotency reservation", async () => {
      const p = probes()
      rejectCsrf(p)
      const request = post()
      await expectCsrfRefusal(await crudFor(p).create(request))
      expect(p.assertValidCsrf).toHaveBeenCalledExactlyOnceWith(request)
      p.untouched()
    })

    it("refuses update with no repository call, no audit record and no idempotency reservation", async () => {
      const p = probes()
      rejectCsrf(p)
      await expectCsrfRefusal(await crudFor(p).update(patch(), params))
      expect(p.assertValidCsrf).toHaveBeenCalledOnce()
      p.untouched()
    })

    it("refuses delete with no repository call, no audit record and no idempotency reservation", async () => {
      const p = probes()
      rejectCsrf(p)
      await expectCsrfRefusal(await crudFor(p).delete(remove(), params))
      expect(p.assertValidCsrf).toHaveBeenCalledOnce()
      p.untouched()
    })

    it("refuses a custom write handler before its operation, persistence, audit, outbox or idempotency run", async () => {
      const p = probes()
      rejectCsrf(p)
      const { handler, execute } = customWrite(p)
      await expectCsrfRefusal(await handler(customRequest()))
      expect(p.assertValidCsrf).toHaveBeenCalledOnce()
      expect(execute).not.toHaveBeenCalled()
      p.untouched()
    })

    it("answers the same refusal for every write method, whatever the cookies carry", async () => {
      const p = probes()
      rejectCsrf(p)
      const crud = crudFor(p)
      const cookie = { cookie: "session=abc" }
      const withCookie = (request: Request) => new Request(request, { headers: { ...Object.fromEntries(request.headers), ...cookie } })
      await expectCsrfRefusal(await crud.create(withCookie(post())))
      await expectCsrfRefusal(await crud.update(withCookie(patch()), params))
      await expectCsrfRefusal(await crud.delete(withCookie(remove()), params))
      expect(p.assertValidCsrf).toHaveBeenCalledTimes(3)
      p.untouched()
    })
  })

  describe("when the check applies", () => {
    it("is called once per request for create, update, delete and a custom write on a non-public scope", async () => {
      const p = probes()
      const crud = crudFor(p)
      const { handler } = customWrite(p)
      await crud.create(post())
      await crud.update(patch(), params)
      await crud.delete(remove(), params)
      await handler(customRequest())
      expect(p.assertValidCsrf).toHaveBeenCalledTimes(4)
    })

    it("is not called for a public scope", async () => {
      const p = probes()
      const crud = crudFor(p, { scope: "public", idempotency: { required: true } })
      const { handler } = customWrite(p, { scope: { scope: "public", idempotency: { required: true } } })
      rejectCsrf(p)
      await crud.create(post())
      await crud.update(patch(), params)
      await crud.delete(remove(), params)
      const response = await handler(customRequest())
      expect(response.status, await response.clone().text()).toBe(200)
      expect(p.assertValidCsrf).not.toHaveBeenCalled()
    })

    it("is skipped by csrfRequired: false on a non-public scope", async () => {
      const p = probes()
      rejectCsrf(p)
      const scope: CrudScopeConfig = { scope: "tenant", csrfRequired: false, idempotency: { required: true } }
      const crud = crudFor(p, scope)
      const { handler } = customWrite(p, { scope })
      await crud.create(post())
      await crud.update(patch(), params)
      await crud.delete(remove(), params)
      const response = await handler(customRequest())
      expect(response.status, await response.clone().text()).toBe(200)
      expect(p.assertValidCsrf).not.toHaveBeenCalled()
    })

    it("is required on a public scope when csrfRequired: true", async () => {
      const p = probes()
      rejectCsrf(p)
      const { handler, execute } = customWrite(p, { scope: { scope: "public", csrfRequired: true, idempotency: { required: true } } })
      await expectCsrfRefusal(await handler(customRequest()))
      expect(p.assertValidCsrf).toHaveBeenCalledOnce()
      expect(execute).not.toHaveBeenCalled()
      p.untouched()
    })
  })

  describe("order", () => {
    it("runs after the body checks: an invalid body is answered 400 and never reaches the check", async () => {
      const p = probes()
      rejectCsrf(p)
      const response = await crudFor(p).create(post({ name: 42 }))
      expect(response.status, await response.clone().text()).toBe(400)
      expect(p.assertValidCsrf).not.toHaveBeenCalled()
      p.untouched()
    })

    it("runs after the body checks for a custom write handler", async () => {
      const p = probes()
      rejectCsrf(p)
      const { handler, execute } = customWrite(p, { body: z.object({ note: z.string() }) })
      const response = await handler(customRequest({ note: 1 }))
      expect(response.status, await response.clone().text()).toBe(400)
      expect(p.assertValidCsrf).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    })

    it("runs before the anonymous-principal 401: an anonymous forged request is answered with the CSRF refusal", async () => {
      const p = probes()
      rejectCsrf(p)
      const { handler, execute } = customWrite(p, { normalization: anonymousNormalization() })
      await expectCsrfRefusal(await handler(customRequest()))
      expect(p.assertValidCsrf).toHaveBeenCalledOnce()
      expect(p.resolveAbacBundle).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    })

    it("lets the anonymous-principal 401 answer once the check passes, still before the ABAC bundle lookup", async () => {
      const p = probes()
      const { handler, execute } = customWrite(p, { normalization: anonymousNormalization() })
      const response = await handler(customRequest())
      const text = await response.clone().text()
      expect(response.status, text).toBe(401)
      expect(text).toContain("UNAUTHORIZED")
      expect(p.assertValidCsrf).toHaveBeenCalledOnce()
      expect(p.resolveAbacBundle).not.toHaveBeenCalled()
      expect(execute).not.toHaveBeenCalled()
    })

    it("runs before the ABAC bundle lookup for an authenticated request", async () => {
      const p = probes()
      rejectCsrf(p)
      await expectCsrfRefusal(await crudFor(p).update(patch(), params))
      expect(p.resolveAbacBundle).not.toHaveBeenCalled()
    })

    it("consults the ABAC bundle once the check passes", async () => {
      const p = probes()
      const response = await crudFor(p).update(patch(), params)
      expect(response.status, await response.clone().text()).toBe(200)
      expect(p.assertValidCsrf).toHaveBeenCalledOnce()
      expect(p.resolveAbacBundle).toHaveBeenCalled()
      expect(p.acquire).toHaveBeenCalledOnce()
    })
  })
})
