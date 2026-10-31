import { describe, expect, it, vi } from "vitest"
import { bindAbacSecurityDigest, ConfigurationError, type RequestContext } from "@xonava/core/domain"
import type { AuditRecord, IdempotencyPort, OutboxRecord, TransactionalIdempotencyPort } from "@xonava/core/events"
import type { PersistenceProvider } from "@xonava/core/persistence"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import type { SerializedResponse } from "../idempotency"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "../../server"
import { allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"
import { httpCrudFixture } from "./httpCrudFixture"

const MODULE = "test.invoices"

type Grant = { effect?: "allow" | "deny"; priority?: number; actions: string[]; write?: string[] }

/** An ABAC bundle with explicit actions; the tag changes the security digest, so it models a re-issued bundle. */
async function bundleWith(grants: Grant[], tag = "v1") {
  return bindAbacSecurityDigest({
    mode: "platform",
    moduleKey: MODULE,
    policies: grants.map((grant, index) => ({
      source: { policyId: `grant-${tag}-${index}`, scopeType: "platform_default" as const },
      moduleKey: MODULE,
      effect: grant.effect ?? "allow",
      priority: grant.priority ?? 1,
      payload: {
        actions: grant.actions,
        capabilities: [],
        conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
        ...(grant.write ? { fieldAccess: { write: grant.write } } : {}),
      },
      compiledConditions: { kind: "literal", value: true },
    })),
    context: {},
    defaultEffect: "deny",
    fieldCatalog: {},
  } as never)
}

function bindings(tenant = false): FrameworkRequestNormalization {
  const base = canonicalRequestNormalization(tenant ? trustedSession({ kind: "tenant", tenantId: "tenant-1" }) : undefined, MODULE)
  const update = base.routeBindings.update
  const approve = Object.freeze({ ...update, routeKey: "test.approve", method: "POST", operationKey: `${MODULE}.approve` })
  return { ...base, routeBindings: Object.freeze({ ...base.routeBindings, approve }) }
}

/** Persistence with real commit/rollback semantics for rows, audit and outbox. */
function transactionalStore() {
  const committed = { rows: [] as string[], audit: [] as AuditRecord[], outbox: [] as OutboxRecord[] }
  type Staged = typeof committed
  const make = (staged?: Staged): PersistenceProvider => ({
    dialect: "test",
    capabilities: { interactiveTransactions: true, atomicBatch: false, returningInsert: false, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100 },
    repository: vi.fn(),
    runInTransaction: async (work: (provider: PersistenceProvider) => Promise<unknown>) => {
      const tx: Staged = { rows: [], audit: [], outbox: [] }
      const result = await work(make(tx))
      committed.rows.push(...tx.rows); committed.audit.push(...tx.audit); committed.outbox.push(...tx.outbox)
      return result
    },
    __staged: staged,
  } as unknown as PersistenceProvider)
  const target = (persistence?: PersistenceProvider): Staged => (persistence as unknown as { __staged?: Staged } | undefined)?.__staged ?? committed
  return { committed, persistence: make(), target }
}

/** In-memory idempotency store with the real port semantics: scope + key, fingerprint conflict, replay. */
function idempotencyStore() {
  const entries = new Map<string, { fingerprint: string; result?: SerializedResponse }>()
  const scopes: string[] = []
  const port: TransactionalIdempotencyPort<SerializedResponse> = {
    acquire: async ({ scope, key, fingerprint }) => {
      scopes.push(scope)
      const id = `${scope}\0${key}`
      const entry = entries.get(id)
      if (!entry) { entries.set(id, { fingerprint }); return { outcome: "acquired", token: id } }
      if (entry.fingerprint !== fingerprint) return { outcome: "conflict" }
      return entry.result ? { outcome: "replay", result: entry.result } : { outcome: "in-progress" }
    },
    renew: async () => undefined,
    markCommittedInTransaction: async () => undefined,
    complete: async ({ scope, key, result }) => { const entry = entries.get(`${scope}\0${key}`); if (entry) entry.result = result },
  }
  return { port, scopes }
}

const passthrough = { parse: (value: unknown) => value, parseAsync: async (value: unknown) => value }

type Options = {
  action?: string
  routeKey?: string
  bundle?: () => Promise<Awaited<ReturnType<typeof bundleWith>>>
  facts?: FrameworkAdapterDeps["resolveModuleAuthorizationFacts"]
  normalization?: FrameworkRequestNormalization
  fail?: boolean
  fields?: { record: Record<string, unknown>; changed: string[] }
  tenant?: boolean
}

function setup(options: Options = {}) {
  const store = transactionalStore()
  const idem = idempotencyStore()
  const execute = vi.fn(async ({ operation }: { operation: { persistence: PersistenceProvider; request?: RequestContext; enforceAbac?: { enforce(action: string, record: Record<string, unknown>, changed?: string[]): void }; addDurableEffect(entry: { name: string; outbox: Record<string, unknown> }): void } }) => {
    const action = options.action ?? "approve"
    operation.enforceAbac?.enforce(action, options.fields?.record ?? { id: "inv-1", status: "approved" }, options.fields?.changed)
    store.target(operation.persistence).rows.push(`${action}:inv-1`)
    operation.addDurableEffect({ name: "invoice-approved", outbox: {
      type: "invoice.approved", version: 1, tenantId: null,
      scope: operation.request!.scope, scopeId: operation.request!.scopeId,
      aggregateType: "invoice", aggregateId: "inv-1", payload: {}, idempotencyKey: `${action}:inv-1`,
    } })
    if (options.fail) throw new Error("business failure")
    return { id: "inv-1", status: "approved" }
  })
  const deps: FrameworkAdapterDeps = {
    assertValidCsrf: vi.fn(),
    resolveAbacBundle: vi.fn(options.bundle ?? (async () => bundleWith([{ actions: ["read", "approve"] }]))),
    resolveModuleAuthorizationFacts: options.facts ?? allowAllModuleFacts,
    createIdempotencyPort: <TResult>() => idem.port as unknown as IdempotencyPort<TResult>,
  }
  const build = () => createFrameworkWriteHandler({
    adapterDeps: deps,
    requestNormalization: options.normalization ?? bindings(options.tenant),
    scope: { scope: options.tenant ? "tenant" : "platform", idempotency: { required: true } },
    moduleKey: MODULE,
    action: (options.action ?? "approve") as "update",
    ...(options.routeKey !== undefined ? { routeKey: options.routeKey } : {}),
    skipCapabilityCheck: true,
    runtimeCapabilities: { deferredExecution: true, cache: true },
    createPersistence: () => store.persistence,
    auditSinkFactory: (_context, persistence) => ({ write: async (record) => { store.target(persistence).audit.push(record) } }),
    outboxSinkFactory: (_context, persistence) => ({ append: async (record) => { store.target(persistence).outbox.push(record) } }),
    definition: {
      key: `${MODULE}.${options.action ?? "approve"}`,
      kind: "mutation",
      atomicity: { kind: "standard", mode: "required" },
      authorization: { authorize: async () => ({ allowed: true }) },
      audit: { action: "invoice.approve", resourceType: "invoice", resolveResourceId: () => "inv-1" },
      execute,
    } as never,
    validation: { body: passthrough },
    resolveInput: async () => ({}),
    resolveResourceIdentity: () => ({ entity: "invoice", id: "inv-1" }),
    recoverCommittedResponse: async () => ({ id: "inv-1", status: "approved" }),
  })
  const send = (key = "key-1", body: unknown = { note: "ok" }) => build()(new Request("https://example.test/invoices/inv-1/approve", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "Idempotency-Key": key },
  }))
  return { build, send, execute, store, idem, deps }
}

describe("business action writes", () => {
  it("an approve-only grant succeeds without update", async () => {
    const { send, execute, store } = setup({ bundle: () => bundleWith([{ actions: ["read", "approve"] }]) })
    const response = await send()
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ id: "inv-1", status: "approved" })
    expect(execute).toHaveBeenCalledOnce()
    expect(store.committed.rows).toEqual(["approve:inv-1"])
  })

  it("an update-only grant cannot run approve", async () => {
    const { send, execute } = setup({ bundle: () => bundleWith([{ actions: ["read", "update"] }]) })
    const response = await send()
    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it("an approve grant does not authorize update (no implicit update)", async () => {
    // The mirror image: the same bundle admits approve but refuses a handler configured for update.
    const { send, execute } = setup({ action: "update", routeKey: "update", bundle: () => bundleWith([{ actions: ["read", "approve"] }]) })
    const response = await send()
    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it("a deny on approve wins", async () => {
    const { send, execute } = setup({ bundle: () => bundleWith([{ actions: ["read", "approve"], priority: 1 }, { effect: "deny", actions: ["approve"], priority: 2 }]) })
    const response = await send()
    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it("field write restrictions apply to approve", async () => {
    const bundle = () => bundleWith([{ actions: ["read", "approve"], write: ["status"] }])
    const allowed = setup({ bundle, fields: { record: { id: "inv-1", status: "approved" }, changed: ["status"] } })
    expect((await allowed.send()).status).toBe(200)
    const denied = setup({ bundle, fields: { record: { id: "inv-1", status: "approved", amount: 0 }, changed: ["status", "amount"] } })
    const response = await denied.send()
    expect(response.status).toBe(403)
    expect(denied.store.committed.rows).toEqual([])
  })

  it("protectedFields blocks a generic update of a reserved field", async () => {
    const row = { id: "r1", tenantId: "tenant-1", name: "a", version: 1 }
    const request = () => new Request("https://x/people/r1", { method: "PATCH", body: JSON.stringify({ name: "b" }), headers: { "content-type": "application/json", "if-match": '"1"' } })
    const reserved = httpCrudFixture({ protectedFields: ["name"] })
    reserved.rows.set("r1", { ...row })
    const blocked = await reserved.handlers.update(request(), { params: Promise.resolve({ id: "r1" }) })
    expect(blocked.status).toBe(403)
    expect(reserved.rows.get("r1")?.name).toBe("a")

    const open = httpCrudFixture()
    open.rows.set("r1", { ...row })
    const allowed = await open.handlers.update(request(), { params: Promise.resolve({ id: "r1" }) })
    expect(allowed.status).toBe(200)
    expect(open.rows.get("r1")?.name).toBe("b")
  })

  it("protectedFields must name entity fields", () => {
    expect(() => httpCrudFixture({ protectedFields: ["nope"] })).toThrow(ConfigurationError)
  })

  it("an idempotent retry of approve replays, and a key reused for update conflicts", async () => {
    const { send, execute, idem } = setup()
    const first = await send("same-key")
    const retry = await send("same-key")
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(await first.json())
    expect(execute).toHaveBeenCalledOnce()

    // The same key with a different request is a conflict, never a replay of the approve receipt.
    const different = await send("same-key", { note: "different" })
    expect(different.status).toBe(409)
    expect(execute).toHaveBeenCalledOnce()

    // The idempotency scope carries the action, so an update handler uses a distinct scope for that key
    // and can never replay or inherit the approve receipt.
    const update = setup({ action: "update", routeKey: "update", bundle: () => bundleWith([{ actions: ["read", "update"] }]) })
    const updateResponse = await update.send("same-key")
    expect(updateResponse.status, await updateResponse.clone().text()).toBe(200)
    const approveScope = idem.scopes[0]!
    const updateScope = update.idem.scopes[0]!
    expect(approveScope).toContain(`:${MODULE}:approve:`)
    expect(updateScope).toContain(`:${MODULE}:update:`)
    expect(approveScope).not.toBe(updateScope)
    expect(update.execute).toHaveBeenCalledOnce()
  })

  it("rate-limit keys include the action", async () => {
    const increments: string[] = []
    const bucket = async (key: string) => { increments.push(key); return { count: 1, resetAt: Date.now() + 60_000 } }
    const rateLimitStore = { increment: bucket, incrementAtomically: bucket }
    const { deps, store } = setup()
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: bindings(),
      scope: { scope: "platform", idempotency: { required: false } },
      moduleKey: MODULE,
      action: "approve",
      skipCapabilityCheck: true,
      runtimeCapabilities: { deferredExecution: true, cache: true },
      createPersistence: () => store.persistence,
      rateLimit: { config: { max: 5, timeWindow: "1 minute" }, consistency: "atomic" },
      getRateLimitStore: async () => rateLimitStore,
      definition: { key: `${MODULE}.approve`, kind: "mutation", atomicity: { kind: "standard", mode: "required" }, authorization: { authorize: async () => ({ allowed: true }) }, execute: async () => ({ ok: true }) } as never,
      validation: { body: passthrough },
      resolveInput: async () => ({}),
    })
    const response = await handler(new Request("https://example.test/x", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))
    expect(response.status, await response.clone().text()).toBe(200)
    expect(increments.length).toBeGreaterThan(0)
    expect(increments[0]).toContain(`:${MODULE}:approve:`)
  })

  it("a rollback in the business action leaves no audit or outbox rows", async () => {
    const ok = setup()
    expect((await ok.send()).status).toBe(200)
    expect(ok.store.committed.audit).toHaveLength(1)
    expect(ok.store.committed.outbox).toHaveLength(1)

    const failing = setup({ fail: true })
    const response = await failing.send()
    expect(response.status).toBe(500)
    expect(failing.execute).toHaveBeenCalledOnce()
    expect(failing.store.committed).toEqual({ rows: [], audit: [], outbox: [] })
  })

  it("revoking the grant (a new bundle digest) refuses the next call", async () => {
    let current = await bundleWith([{ actions: ["read", "approve"] }], "v1")
    const { send, execute } = setup({ bundle: async () => current })
    expect((await send("k1")).status).toBe(200)
    const revoked = await bundleWith([{ actions: ["read"] }], "v2")
    expect(revoked.securityDigest).not.toBe(current.securityDigest)
    current = revoked
    const response = await send("k2")
    expect(response.status).toBe(403)
    expect(execute).toHaveBeenCalledOnce()
    // The old receipt is bound to the old digest: retrying k1 is refused, not replayed.
    expect((await send("k1")).status).toBe(403)
  })

  it("module admission checks the business action name, and a manage entry still allows every action", async () => {
    const tenant = (actions: string[]) => setup({
      tenant: true,
      facts: ({ moduleKey }) => ({ enabledModuleKeys: [moduleKey], enabledModuleActions: { [moduleKey]: actions } }),
    })
    const withoutApprove = tenant(["read", "update"])
    expect((await withoutApprove.send()).status).toBe(403)
    expect(withoutApprove.execute).not.toHaveBeenCalled()
    expect((await tenant(["read", "approve"]).send()).status).toBe(200)
    expect((await tenant(["manage"]).send()).status).toBe(200)
  })

  it("construction fails for action read, manage and malformed names", () => {
    for (const action of ["read", "manage", "Approve", "1approve", "has space", "", "a".repeat(65)]) {
      expect(() => setup({ action }).build(), action).toThrow(ConfigurationError)
    }
  })

  it("construction fails for a missing route binding", () => {
    expect(() => setup({ action: "reject" }).build()).toThrow(ConfigurationError)
    expect(() => setup({ action: "approve", routeKey: "nope" }).build()).toThrow(ConfigurationError)
    // An explicit routeKey may reuse an existing binding.
    expect(() => setup({ action: "reject", routeKey: "approve" }).build()).not.toThrow()
  })

  it("keeps create, update and delete handlers working with their default route binding", () => {
    for (const action of ["create", "update", "delete"]) {
      expect(() => setup({ action }).build(), action).not.toThrow()
    }
  })
})
