import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  ConfigurationError,
  ForbiddenError,
  Predicate,
  createAbacAuthorizer,
  bindAbacSecurityDigest,
  type RequestContext,
} from "@xonava/core/domain"
import type { EntityScopeDefinition } from "@xonava/core/entity"
import { createTenantScopedPersistenceProvider, encodeTenantCacheTag } from "@xonava/core/persistence"
import {
  assertCrudRouteBinding,
  assertProtectedCreateFields,
  assertProtectedUpdateFields,
  auditEmit,
  authorizeFrameworkModule,
  buildScopeCacheTags,
  buildScopedCreateRecord,
  buildStructuralScope,
  canUseOwnerBypass,
  createShared,
  deriveSecurityCachePartition,
  enforceFinalWrite,
  getProtectedMutationFields,
  getRequestIp,
  loadExistingRecord,
  normalizeCrudRequest,
  normalizeEntityRateLimitSetting,
  resolveActionScopeForContext,
  resolveOperationRequestContext,
  sameMutationVersion,
  tenantIdFromContext,
  toAuditObject,
  toCrudContext,
  toCrudPostCommitContext,
  toCrudReadContext,
  withScopedPersistence,
} from "../shared"
import {
  ALLOW_ALL_SCOPE,
  MODULE_KEY,
  asAnonymous,
  baseOptions,
  contextFor,
  fakeRepo,
  keylessEntity,
  persistenceOf,
  unscopedEntity,
  widgetEntity,
  type Row,
} from "./crudUnitHarness"
import { allowAllAbacBundle, canonicalRequestNormalization, trustedSession } from "../../__tests__/canonicalRequest"

const spy = vi.hoisted(() => ({
  authorization: [] as Array<Record<string, unknown>>,
  rate: [] as Array<Record<string, unknown>>,
  normalized: [] as Array<Record<string, unknown>>,
}))

vi.mock("@xonava/core/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xonava/core/domain")>()
  return {
    ...actual,
    assertFrameworkAuthorization: (input: Parameters<typeof actual.assertFrameworkAuthorization>[0]) => {
      spy.authorization.push(input as never)
      return actual.assertFrameworkAuthorization(input)
    },
  }
})

vi.mock("@xonava/core/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xonava/core/rate-limit")>()
  return { ...actual, enforceRateLimit: vi.fn(async (args: Record<string, unknown>) => { spy.rate.push(args) }) }
})

vi.mock("../../scopeResolution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scopeResolution")>()
  return {
    ...actual,
    normalizeFrameworkRequest: (input: Parameters<typeof actual.normalizeFrameworkRequest>[0]) => {
      spy.normalized.push(input as never)
      return actual.normalizeFrameworkRequest(input)
    },
  }
})

beforeEach(() => {
  spy.authorization.length = 0
  spy.rate.length = 0
  spy.normalized.length = 0
})

const SCOPE_ID = "scope-x"
const tenantCtx = (tenantId = "tenant-1"): RequestContext => ({ scope: { kind: "tenant", tenantId }, scopeId: SCOPE_ID, identity: { actor: { id: "a", kind: "human" }, subject: { id: "a", kind: "human" } } }) as never
const appCtx = (applicationKey = "app-1"): RequestContext => ({ scope: { kind: "application", applicationKey }, scopeId: SCOPE_ID, identity: { actor: { id: "a", kind: "human" }, subject: { id: "a", kind: "human" } } }) as never
const platformCtx = (): RequestContext => ({ scope: { kind: "platform", platformKey: "p" }, scopeId: SCOPE_ID, identity: { actor: { id: "a", kind: "human" }, subject: { id: "a", kind: "human" } } }) as never

describe("tenant id and route binding", () => {
  it("reads the tenant id only from a tenant scope", () => {
    expect(tenantIdFromContext(tenantCtx("t-9"))).toBe("t-9")
    expect(tenantIdFromContext(platformCtx())).toBeUndefined()
    expect(tenantIdFromContext(appCtx())).toBeUndefined()
  })

  it("requires an own route binding for the route", () => {
    const base = canonicalRequestNormalization(trustedSession(), MODULE_KEY)
    expect(() => assertCrudRouteBinding(base, "list", MODULE_KEY)).not.toThrow()
    expect(() => assertCrudRouteBinding({ ...base, routeBindings: {} }, "list", "m.x")).toThrow(new ConfigurationError('CRUD handler for "m.x" has no route binding "list"'))
    expect(() => assertCrudRouteBinding({ ...base, routeBindings: { detail: base.routeBindings.detail } } as never, "list", "m.x")).toThrow(ConfigurationError)
    expect(() => assertCrudRouteBinding({ ...base, routeBindings: { list: base.routeBindings.list } } as never, "detail", "m.x")).toThrow('has no route binding "detail"')
  })
})

describe("request normalization", () => {
  const trusted = (extra: Record<string, unknown> = {}) => ({ ...canonicalRequestNormalization(trustedSession(), MODULE_KEY), ...extra })
  const call = (normalization: ReturnType<typeof trusted>, over: Record<string, unknown> = {}, request = new Request("https://api.example.test/things?x=1")) =>
    normalizeCrudRequest({ request, routeKey: "create", normalization, requestId: "req-1", correlationId: "corr-1", ...over } as never)

  it("fails closed for a route without a binding, including inherited names", async () => {
    await expect(call(trusted(), { routeKey: "missing" })).rejects.toEqual(new ConfigurationError('No route binding is configured for "missing"'))
    await expect(call(trusted(), { routeKey: "toString" })).rejects.toEqual(new ConfigurationError('No route binding is configured for "toString"'))
  })

  it("resolves the trusted session for the route and hands everything to the request normalizer", async () => {
    const normalization = trusted()
    const resolveTrustedSession = vi.fn(normalization.resolveTrustedSession)
    const resolveAdmissionEvidence = vi.fn(normalization.resolveAdmissionEvidence)
    const request = new Request("https://api.example.test/things?x=1")
    const context = await call({ ...normalization, resolveTrustedSession, resolveAdmissionEvidence }, { pathParameters: { id: "p1" }, metadata: { requestId: "m" } }, request)
    expect(context.requestId).toBe("req-1")
    expect(resolveTrustedSession).toHaveBeenCalledWith({ request, route: normalization.routeBindings.create })
    const input = spy.normalized[0] as Record<string, unknown> & { admit: (a: unknown) => Promise<unknown> }
    expect(input.requestId).toBe("req-1")
    expect(input.correlationId).toBe("corr-1")
    expect(input.route).toBe(normalization.routeBindings.create)
    expect(input.resolverBindings).toBe(normalization.resolverBindings)
    expect(input.signal).toBe(request.signal)
    expect(input.host).toBe("api.example.test")
    expect(input.pathParameters).toEqual({ id: "p1" })
    expect(input.metadata).toEqual({ requestId: "m" })
    expect(input.session).toEqual(expect.objectContaining({ scope: expect.objectContaining({ kind: "platform" }) }))
    await input.admit({ identity: "i", scope: "s", scopeId: "sid" })
    expect(resolveAdmissionEvidence).toHaveBeenLastCalledWith({ request, route: normalization.routeBindings.create, identity: "i", scope: "s", scopeId: "sid", session: input.session })
  })

  it("omits optional inputs that were not supplied", async () => {
    await call(trusted())
    const input = spy.normalized[0] as Record<string, unknown>
    for (const key of ["pathParameters", "headers", "metadata", "verifyDelegationRevocation"]) expect(key in input).toBe(false)
  })

  it("passes the delegation revocation verifier and trusted headers, lower-cased and only when present", async () => {
    const verifyDelegationRevocation = vi.fn()
    await call(trusted({ verifyDelegationRevocation, trustedHeaders: ["X-Tenant-Hint", "x-missing"] }), {}, new Request("https://api.example.test/", { headers: { "X-Tenant-Hint": "abc" } }))
    const input = spy.normalized[0] as Record<string, unknown>
    expect(input.verifyDelegationRevocation).toBe(verifyDelegationRevocation)
    expect(input.headers).toEqual({ "x-tenant-hint": "abc" })
    await call(trusted({ trustedHeaders: ["x-missing"] }))
    expect("headers" in (spy.normalized[1] as Record<string, unknown>)).toBe(false)
  })

  it("offers admission evidence without a session when the normalization yields none", async () => {
    const normalization = trusted({ resolveTrustedSession: async () => undefined })
    const resolveAdmissionEvidence = vi.fn(normalization.resolveAdmissionEvidence)
    await expect(call({ ...normalization, resolveAdmissionEvidence })).rejects.toBeDefined()
    const input = spy.normalized[0] as { admit: (a: unknown) => Promise<unknown> }
    await input.admit({ identity: "i", scope: "s", scopeId: "sid" })
    const offered = resolveAdmissionEvidence.mock.calls[0]?.[0] as Record<string, unknown>
    expect("session" in offered).toBe(false)
    expect(Object.keys(offered).sort()).toEqual(["identity", "request", "route", "scope", "scopeId"])
  })

  it("omits the session when the normalization yields none", async () => {
    const anonymous = trusted({ resolveTrustedSession: async () => undefined })
    await expect(call(anonymous)).rejects.toBeDefined()
    expect("session" in (spy.normalized[0] as Record<string, unknown>)).toBe(false)
  })
})

describe("client address", () => {
  const request = new Request("https://example.test/")
  it("takes the trimmed address from the trusted resolver, with the runtime metadata", () => {
    const resolve = vi.fn(() => "  9.9.9.9  ")
    const metadata = vi.fn(() => ({ peerAddress: "10.0.0.1" }))
    expect(getRequestIp(request, resolve, metadata)).toBe("9.9.9.9")
    expect(resolve).toHaveBeenCalledWith(request, { peerAddress: "10.0.0.1" })
    expect(metadata).toHaveBeenCalledWith(request)
  })

  it("is unknown without a resolver, with a blank answer, or with none", () => {
    expect(getRequestIp(request)).toBe("unknown")
    expect(getRequestIp(request, () => "   ")).toBe("unknown")
    expect(getRequestIp(request, () => null)).toBe("unknown")
    expect(getRequestIp(request, () => undefined)).toBe("unknown")
    const resolve = vi.fn(() => "1.1.1.1")
    expect(getRequestIp(request, resolve)).toBe("1.1.1.1")
    expect(resolve).toHaveBeenCalledWith(request, undefined)
  })
})

describe("security cache partition", () => {
  const bundle = (securityDigest: string) => ({ securityDigest }) as never
  const args = (over: Record<string, unknown> = {}) => ({ context: tenantCtx(), hasRepresentationHook: false, deps: {}, scope: "tenant", ...over }) as never

  it("never shares a representation produced by a hook", () => {
    expect(deriveSecurityCachePartition(args({ hasRepresentationHook: true, bundle: bundle("d"), cacheScopeKey: "k" }))).toEqual({ canCache: false, partition: "" })
    const anonymous = asAnonymous(tenantCtx())
    expect(deriveSecurityCachePartition(args({ hasRepresentationHook: true, context: anonymous }))).toEqual({ canCache: false, partition: "" })
  })

  it("partitions anonymous reads by scope", () => {
    expect(deriveSecurityCachePartition(args({ context: asAnonymous(tenantCtx()) }))).toEqual({ canCache: true, partition: `public:${SCOPE_ID}` })
  })

  it("requires a non-blank security digest", () => {
    for (const bundleValue of [undefined, bundle(""), bundle("   ")]) {
      expect(deriveSecurityCachePartition(args({ bundle: bundleValue, cacheScopeKey: "k" }))).toEqual({ canCache: false, partition: "" })
    }
  })

  it("binds the partition to the digest and the scope key, caching only with a usable key", () => {
    expect(deriveSecurityCachePartition(args({ bundle: bundle("d1"), cacheScopeKey: "k1" }))).toEqual({ canCache: true, partition: "abac:d1:k1" })
    for (const cacheScopeKey of [undefined, "", "   "]) {
      expect(deriveSecurityCachePartition(args({ bundle: bundle("d1"), cacheScopeKey }))).toEqual({ canCache: false, partition: "abac:d1:default" })
    }
    expect(deriveSecurityCachePartition(args({ bundle: bundle("d1"), cacheScopeKey: " k " }))).toEqual({ canCache: true, partition: "abac:d1: k " })
  })

  it("never grants the administrative bypass", () => {
    expect(canUseOwnerBypass({} as never, "tenant", tenantCtx())).toBe(false)
  })
})

describe("framework authorization", () => {
  const deps = (facts?: Record<string, unknown>) => ({ resolveModuleAuthorizationFacts: vi.fn(() => facts) }) as never

  it("evaluates module facts merged with the trusted scope, without owner authority", async () => {
    const resolve = vi.fn(() => ({ enabledModuleKeys: [MODULE_KEY], enabledModuleActions: { [MODULE_KEY]: ["manage"] }, enabledModuleCapabilities: { [MODULE_KEY]: ["manage"] }, scope: "public", ownerAuthority: true, impersonated: true }))
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const context = tenantCtx()
    authorizeFrameworkModule({ deps: { resolveModuleAuthorizationFacts: resolve } as never, moduleKey: MODULE_KEY, action: "create", context, bundle })
    expect(resolve).toHaveBeenCalledWith({ moduleKey: MODULE_KEY, context })
    const input = spy.authorization[0] as { facts: Record<string, unknown>; moduleKey: string; action: string }
    expect(input.facts).toMatchObject({ scope: "tenant", ownerAuthority: false, impersonated: false })
    expect(input.moduleKey).toBe(MODULE_KEY)
    expect(input.action).toBe("create")
  })

  it("treats a differing subject id or kind as impersonation, and non-tenant scopes as platform", async () => {
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const facts = { enabledModuleKeys: [MODULE_KEY], enabledModuleActions: { [MODULE_KEY]: ["manage"] }, enabledModuleCapabilities: { [MODULE_KEY]: ["manage"] } }
    const byId = { ...platformCtx(), identity: { actor: { id: "a", kind: "human" }, subject: { id: "b", kind: "human" } } } as never
    authorizeFrameworkModule({ deps: deps(facts), moduleKey: MODULE_KEY, action: "create", context: byId, bundle })
    expect(spy.authorization[0]?.facts).toMatchObject({ scope: "platform", impersonated: true })
    const byKind = { ...platformCtx(), identity: { actor: { id: "a", kind: "human" }, subject: { id: "a", kind: "service" } } } as never
    authorizeFrameworkModule({ deps: deps(facts), moduleKey: MODULE_KEY, action: "create", context: byKind, bundle })
    expect(spy.authorization[1]?.facts).toMatchObject({ impersonated: true })
    authorizeFrameworkModule({ deps: deps(facts), moduleKey: MODULE_KEY, action: "create", context: appCtx(), bundle })
    expect(spy.authorization[2]?.facts).toMatchObject({ scope: "platform", impersonated: false })
  })

  it("passes the optional capability, bundle and action-evaluation switches only when given", async () => {
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const facts = { enabledModuleKeys: [MODULE_KEY], enabledModuleActions: { [MODULE_KEY]: ["manage"] }, enabledModuleCapabilities: { [MODULE_KEY]: ["manage"] } }
    authorizeFrameworkModule({ deps: deps(facts), moduleKey: MODULE_KEY, action: "read", context: tenantCtx(), bundle })
    const plain = spy.authorization[0] as Record<string, unknown>
    expect("capabilityKey" in plain).toBe(false)
    expect("evaluateAbacAction" in plain).toBe(false)
    expect(plain.bundle).toBe(bundle)
    authorizeFrameworkModule({ deps: deps(facts), moduleKey: MODULE_KEY, action: "read", context: tenantCtx(), capabilityKey: "manage", bundle, evaluateAbacAction: false })
    const full = spy.authorization[1] as Record<string, unknown>
    expect(full.capabilityKey).toBe("manage")
    expect(full.evaluateAbacAction).toBe(false)
    expect(() => authorizeFrameworkModule({ deps: deps(facts), moduleKey: MODULE_KEY, action: "read", context: tenantCtx() })).toThrow()
    expect("bundle" in (spy.authorization[2] as Record<string, unknown>)).toBe(false)
    expect(() => authorizeFrameworkModule({ deps: deps(facts), moduleKey: MODULE_KEY, action: "read", context: tenantCtx(), bundle: null })).toThrow()
    expect("bundle" in (spy.authorization[3] as Record<string, unknown>)).toBe(true)
  })

  it("works without a facts resolver", async () => {
    expect(() => authorizeFrameworkModule({ deps: {} as never, moduleKey: MODULE_KEY, action: "read", context: tenantCtx() })).toThrow()
    expect((spy.authorization[0]?.facts as Record<string, unknown>).scope).toBe("tenant")
  })
})

describe("audit emission", () => {
  const options = (audit: unknown) => ({ audit }) as never
  it("emits unless disabled or excluded", () => {
    expect(auditEmit(options(undefined), "create")).toBe(true)
    expect(auditEmit(options({ enabled: true }), "update")).toBe(true)
    expect(auditEmit(options({ enabled: false }), "update")).toBe(false)
    expect(auditEmit(options({ enabled: false, emitOn: ["update"] }), "update")).toBe(false)
    expect(auditEmit(options({ emitOn: ["update"] }), "update")).toBe(true)
    expect(auditEmit(options({ emitOn: ["update"] }), "delete")).toBe(false)
    expect(auditEmit(options({ emitOn: [] }), "create")).toBe(false)
  })
})

describe("structural scope", () => {
  const tenantEntity = widgetEntity()
  it("filters a tenant entity by its tenant column or the scope's explicit field", () => {
    expect(buildStructuralScope(tenantEntity, tenantCtx("t1"), { kind: "tenant" })).toEqual(Predicate.eq("tenantId", "t1"))
    expect(buildStructuralScope(tenantEntity, tenantCtx("t1"), { kind: "tenant", field: "name" } as EntityScopeDefinition)).toEqual(Predicate.eq("name", "t1"))
    expect(buildStructuralScope(unscopedEntity(), tenantCtx("t1"), { kind: "tenant" })).toBeUndefined()
    expect(buildStructuralScope(unscopedEntity(), tenantCtx("t1"), { kind: "tenant", field: "name" } as EntityScopeDefinition)).toEqual(Predicate.eq("name", "t1"))
  })

  it("filters an application entity by its application field", () => {
    expect(buildStructuralScope(tenantEntity, appCtx("app-7"), { kind: "application", field: "name" } as EntityScopeDefinition)).toEqual(Predicate.eq("name", "app-7"))
  })

  it("refuses to span partitions when the request is outside the entity's scope", () => {
    expect(() => buildStructuralScope(tenantEntity, platformCtx(), { kind: "application", field: "name" } as EntityScopeDefinition)).toThrow(new ForbiddenError("This operation requires an application scope"))
    expect(() => buildStructuralScope(tenantEntity, platformCtx(), { kind: "tenant" })).toThrow(new ForbiddenError("This operation requires a tenant scope"))
    expect(() => buildStructuralScope(tenantEntity, appCtx(), { kind: "tenant" })).toThrow(ForbiddenError)
    expect(() => buildStructuralScope(tenantEntity, tenantCtx(), { kind: "application", field: "name" } as EntityScopeDefinition)).toThrow(ForbiddenError)
  })

  it("adds the platform scope filter and the active-row filter", () => {
    const scopeFilter = Predicate.eq("name", "scoped")
    const active = Predicate.eq("deletedAt", null)
    expect(buildStructuralScope(unscopedEntity(), platformCtx(), { kind: "platform", scopeFilter } as EntityScopeDefinition)).toEqual(scopeFilter)
    expect(buildStructuralScope(unscopedEntity(), platformCtx(), { kind: "system", scopeFilter } as EntityScopeDefinition)).toEqual(scopeFilter)
    expect(buildStructuralScope(unscopedEntity(), platformCtx(), { kind: "platform" } as EntityScopeDefinition)).toBeUndefined()
    expect(buildStructuralScope(tenantEntity, tenantCtx("t1"), { kind: "tenant" })).toEqual(Predicate.eq("tenantId", "t1"))
    expect(buildStructuralScope(unscopedEntity({ activeRowFilter: active }), platformCtx(), { kind: "platform", scopeFilter } as EntityScopeDefinition)).toEqual(Predicate.and(scopeFilter, active))
    expect(buildStructuralScope(unscopedEntity({ activeRowFilter: active }), platformCtx(), undefined)).toEqual(active)
    expect(buildStructuralScope(widgetEntity({ activeRowFilter: active }), tenantCtx("t1"), { kind: "tenant" })).toEqual(Predicate.and(Predicate.eq("tenantId", "t1"), active))
    expect(buildStructuralScope(unscopedEntity(), platformCtx(), undefined)).toBeUndefined()
  })
})

describe("protected fields", () => {
  it("lists the key, tenant, version and immutable fields once", () => {
    expect(getProtectedMutationFields(widgetEntity({ immutableFields: ["name", "id"] }))).toEqual(["id", "tenantId", "version", "name"])
    expect(getProtectedMutationFields(unscopedEntity())).toEqual(["id"])
    expect(getProtectedMutationFields(keylessEntity())).toEqual(["tenantId", "version"])
  })

  it("refuses an update that touches a protected or reserved field, naming each", () => {
    const entity = widgetEntity()
    expect(() => assertProtectedUpdateFields(entity, { name: "x" })).not.toThrow()
    expect(() => assertProtectedUpdateFields(entity, { id: "x", version: 2, name: "y" })).toThrow(new ForbiddenError("Cannot modify protected fields on widget: id, version", { fields: ["id", "version"] }))
    expect(() => assertProtectedUpdateFields(entity, { name: "x" }, ["name"])).toThrow(new ForbiddenError("Cannot modify protected fields on widget: name"))
    expect(() => assertProtectedUpdateFields(entity, { deletedAt: "x" }, ["name"])).not.toThrow()
    expect(() => assertProtectedUpdateFields(entity, { id: "x" }, ["id"])).toThrow("widget: id")
    expect(() => assertProtectedUpdateFields(entity, Object.create({ id: "inherited" }) as object)).not.toThrow()
    expect(() => assertProtectedUpdateFields(entity, { "Stryker was here": true })).not.toThrow()
    const detailsOf = (run: () => void): unknown => { try { run() } catch (error) { return (error as ForbiddenError).details } return undefined }
    expect(detailsOf(() => assertProtectedUpdateFields(entity, { id: "x", name: "y" }, ["name"]))).toEqual({ fields: ["id", "name"] })
  })

  it("refuses a create that supplies a protected field, naming each", () => {
    const entity = widgetEntity({ immutableFields: ["name"] })
    expect(() => assertProtectedCreateFields(entity, { deletedAt: "x" })).not.toThrow()
    expect(() => assertProtectedCreateFields(entity, { tenantId: "x", name: "y" })).toThrow(new ForbiddenError("Cannot provide protected fields on widget: tenantId, name"))
    expect(() => assertProtectedCreateFields(entity, Object.create({ id: "inherited" }) as object)).not.toThrow()
    try { assertProtectedCreateFields(entity, { tenantId: "x", name: "y" }) } catch (error) { expect((error as ForbiddenError).details).toEqual({ fields: ["tenantId", "name"] }) }
  })
})

describe("action scope and final write enforcement", () => {
  const depsWith = (resolveAbacBundle: unknown) => ({ ...baseOptions().adapterDeps, resolveAbacBundle })
  const optionsWith = (resolveAbacBundle: unknown) => baseOptions({ adapterDeps: depsWith(resolveAbacBundle) })

  it("yields no action scope to anonymous callers, without asking for a bundle", async () => {
    const resolve = vi.fn()
    expect(await resolveActionScopeForContext(optionsWith(resolve), asAnonymous(tenantCtx()), "delete")).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it("resolves the action scope from the verified bundle for this module", async () => {
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const resolve = vi.fn(async () => bundle)
    const context = tenantCtx()
    expect(await resolveActionScopeForContext(optionsWith(resolve), context, "delete")).toEqual(ALLOW_ALL_SCOPE)
    expect(resolve).toHaveBeenCalledWith({ moduleKey: MODULE_KEY, context })
    await expect(resolveActionScopeForContext(optionsWith(async () => null), context, "delete")).rejects.toEqual(new ForbiddenError("ABAC authorization bundle unavailable"))
    await expect(resolveActionScopeForContext(optionsWith(async () => ({ defaultEffect: "deny", securityDigest: "x" })), context, "delete")).rejects.toThrow("ABAC bundle is not a verified production bundle")
  })

  const write = (over: Record<string, unknown>) => enforceFinalWrite({ options: optionsWith(async () => allowAllAbacBundle(MODULE_KEY)), operation: {}, context: tenantCtx(), action: "create", record: { id: "1" }, changedFields: ["id"], ...over } as never)

  it("uses the operation's enforcer when it has one", async () => {
    const enforce = vi.fn()
    const resolve = vi.fn()
    await write({ operation: { enforceAbac: { enforce } }, options: optionsWith(resolve), action: "update" })
    expect(enforce).toHaveBeenCalledWith("update", { id: "1" }, ["id"])
    expect(resolve).not.toHaveBeenCalled()
  })

  it("falls back to the verified bundle when the operation carries no enforcer", async () => {
    await expect(write({ operation: { enforceAbac: undefined } })).resolves.toBeUndefined()
    await expect(write({ operation: {} })).resolves.toBeUndefined()
    await expect(write({ options: optionsWith(async () => null) })).rejects.toEqual(new ForbiddenError("ABAC authorization bundle unavailable"))
    await expect(write({ options: optionsWith(async () => ({ defaultEffect: "deny", securityDigest: "x" })) })).rejects.toThrow("ABAC bundle is not a verified production bundle")
    await expect(write({ action: "approve" as never })).rejects.toBeInstanceOf(ForbiddenError)
    const resolve = vi.fn(async () => allowAllAbacBundle(MODULE_KEY))
    const context = tenantCtx()
    await write({ options: optionsWith(resolve), context })
    expect(resolve).toHaveBeenCalledWith({ moduleKey: MODULE_KEY, context })
  })

  it("lets anonymous callers through without a bundle", async () => {
    const resolve = vi.fn()
    await write({ options: optionsWith(resolve), context: asAnonymous(tenantCtx()) })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("passes the changed fields to the bundle's field-write rules", async () => {
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    await expect(write({ options: optionsWith(async () => bundle), record: { id: "1", name: "x" }, changedFields: ["id", "name"] })).resolves.toBeUndefined()
  })
})

describe("small helpers", () => {
  it("compares versions strictly", () => {
    expect(sameMutationVersion(2, 2)).toBe(true)
    expect(sameMutationVersion(2, 3)).toBe(false)
    expect(sameMutationVersion("2", 2)).toBe(false)
    expect(sameMutationVersion(undefined, undefined)).toBe(true)
  })

  it("scopes persistence to the tenant only for tenant contexts", () => {
    const base = persistenceOf(fakeRepo())
    const scoped = withScopedPersistence(tenantCtx("t7"), base) as unknown as { tenantId?: string }
    expect(scoped.tenantId).toBe("t7")
    expect(withScopedPersistence(platformCtx(), base)).toBe(base)
    expect(withScopedPersistence(appCtx(), base)).toBe(base)
  })

  it("returns audit objects unchanged", () => {
    const value = { a: 1 }
    expect(toAuditObject(value)).toBe(value)
  })

  it("compares equal for equal scope tags and names the tenant tags", () => {
    expect(buildScopeCacheTags("widgets", tenantCtx("t1"))).toEqual([encodeTenantCacheTag("t1", "widgets"), encodeTenantCacheTag("t1", "scope")])
    expect(buildScopeCacheTags("widgets", platformCtx())).toEqual([`widgets:${SCOPE_ID}`, `scope:${SCOPE_ID}`, "widgets"])
    expect(buildScopeCacheTags("scope", platformCtx())).toEqual([`scope:${SCOPE_ID}`, "scope"])
    expect(buildScopeCacheTags("scope", tenantCtx("t1"))).toEqual([encodeTenantCacheTag("t1", "scope")])
  })
})

describe("created record", () => {
  it("adds the id, trusted scope columns and first version over the body", () => {
    expect(buildScopedCreateRecord(widgetEntity(), { id: "w1" }, { name: "n", tenantId: "spoof", id: "spoof", version: 9 }, tenantCtx("t1"), { kind: "tenant" })).toEqual({ name: "n", id: "w1", tenantId: "t1", version: 1 })
    expect(buildScopedCreateRecord(unscopedEntity(), { id: "w1" }, { name: "n" }, platformCtx(), undefined)).toEqual({ name: "n", id: "w1" })
    expect(buildScopedCreateRecord(unscopedEntity(), { id: "w1" }, { name: "n" }, tenantCtx("t1"), undefined)).toEqual({ name: "n", id: "w1" })
    expect(buildScopedCreateRecord(unscopedEntity(), { id: "w1" }, { name: "n" }, appCtx("app-1"), { kind: "application", field: "name" } as EntityScopeDefinition)).toEqual({ name: "app-1", id: "w1" })
    expect(buildScopedCreateRecord(unscopedEntity(), { id: "w1" }, { name: "n" }, appCtx("app-1"), undefined)).toEqual({ name: "n", id: "w1" })
  })

  it("refuses a context outside the entity's scope", () => {
    expect(() => buildScopedCreateRecord(widgetEntity(), { id: "w1" }, {}, platformCtx(), { kind: "tenant" })).toThrow(ForbiddenError)
  })
})

describe("hook contexts", () => {
  const operation = (over: Record<string, unknown> = {}) => ({
    operationId: "op-1",
    correlationId: "op-corr",
    persistence: persistenceOf(fakeRepo()),
    services: { clock: 1 },
    signal: new AbortController().signal,
    deadline: "later",
    request: { requestId: "req-7", correlationId: "req-corr", metadata: { requestId: "meta-req" } },
    ...over,
  })

  it("builds the mutation hook context from the request and a read-only persistence", () => {
    const op = operation()
    const context = toCrudContext(tenantCtx("t1"), op as never)
    expect(context.tenantId).toBe("t1")
    expect(context.requestId).toBe("req-7")
    expect(context.correlationId).toBe("req-corr")
    expect(context.persistence).toBe(op.persistence)
    expect(context.operation?.persistence).toBe(op.persistence)
    expect(context.operation).toEqual({
      operationId: "op-1",
      correlationId: "op-corr",
      request: op.request,
      persistence: op.persistence,
      services: op.services,
      signal: op.signal,
      deadline: "later",
    })
    expect(Object.isFrozen(context.operation?.request)).toBe(true)
    expect(context.operation?.request).not.toBe(op.request)
  })

  it("falls back to the operation's correlation id, and to empty strings", () => {
    const withoutRequest = toCrudContext(platformCtx(), operation({ request: undefined }) as never)
    expect(withoutRequest.tenantId).toBe("")
    expect(withoutRequest.requestId).toBe("")
    expect(withoutRequest.correlationId).toBe("op-corr")
    expect("request" in (withoutRequest.operation ?? {})).toBe(false)
    const bare = toCrudContext(platformCtx(), operation({ request: undefined, correlationId: undefined }) as never)
    expect(bare.correlationId).toBe("")
    expect("correlationId" in (bare.operation ?? {})).toBe(false)
  })

  it("scopes a supplied persistence to the tenant and uses it read-only", () => {
    const supplied = persistenceOf(fakeRepo())
    const context = toCrudContext(tenantCtx("t1"), operation({ persistence: undefined }) as never, supplied)
    expect((context.persistence as unknown as { tenantId?: string }).tenantId).toBe("t1")
    expect(context.operation?.persistence).toBe(context.persistence)
    expect(Object.isFrozen(context.persistence)).toBe(true)
    expect(context.persistence).not.toBe(supplied)
    const platform = toCrudContext(platformCtx(), operation({ persistence: undefined }) as never, supplied)
    expect((platform.persistence as unknown as { tenantId?: string }).tenantId).toBeUndefined()
    expect(() => toCrudContext(platformCtx(), operation({ persistence: undefined }) as never)).toThrow(new ConfigurationError("Mutation hook persistence is unavailable"))
  })

  it("uses the operation's own persistence as given when no override is supplied", () => {
    const own = operation()
    expect(toCrudContext(platformCtx(), own as never).persistence).toBe(own.persistence)
  })

  it("derives the post-commit context from the metadata, then the correlation id", () => {
    expect(toCrudPostCommitContext(tenantCtx("t1"), { metadata: { requestId: "m-1" }, correlationId: "c-1" } as never)).toEqual({ tenantId: "t1", requestId: "m-1", correlationId: "c-1" })
    expect(toCrudPostCommitContext(platformCtx(), { metadata: { requestId: 5 }, correlationId: "c-1" } as never)).toEqual({ tenantId: "", requestId: "c-1", correlationId: "c-1" })
    expect(toCrudPostCommitContext(platformCtx(), {} as never)).toEqual({ tenantId: "", requestId: "", correlationId: "" })
  })

  it("derives the read context from the request, then the metadata", () => {
    const read = toCrudReadContext(tenantCtx("t1"), operation() as never)
    expect(read.tenantId).toBe("t1")
    expect(read.requestId).toBe("req-7")
    expect(read.correlationId).toBe("req-corr")
    expect(read.operation).toEqual({ operationId: "op-1", correlationId: "op-corr", services: { clock: 1 }, metadata: { requestId: "meta-req" } })
    expect(Object.isFrozen(read.operation?.metadata)).toBe(true)

    const fromMetadata = toCrudReadContext(platformCtx(), { operationId: "o", correlationId: "c", services: {}, metadata: { requestId: "m-req" } } as never)
    expect(fromMetadata.requestId).toBe("m-req")
    expect(fromMetadata.correlationId).toBe("c")
    expect(fromMetadata.tenantId).toBe("")
    expect(fromMetadata.operation?.metadata).toEqual({ requestId: "m-req" })

    const bare = toCrudReadContext(platformCtx(), { operationId: "o", services: {} } as never)
    expect(bare).toEqual({ tenantId: "", requestId: "", correlationId: "", operation: { operationId: "o", services: {} } })
    expect("correlationId" in (bare.operation ?? {})).toBe(false)
    expect("metadata" in (bare.operation ?? {})).toBe(false)

    const absentRequest = toCrudReadContext(platformCtx(), { operationId: "o", services: {}, request: undefined, metadata: { requestId: "m-1" }, correlationId: "oc" } as never)
    expect(absentRequest.requestId).toBe("")
    expect(absentRequest.correlationId).toBe("oc")
    expect(absentRequest.operation).toEqual({ operationId: "o", correlationId: "oc", services: {} })
    const noRequestMeta = toCrudReadContext(platformCtx(), { operationId: "o", services: {}, request: { requestId: undefined, correlationId: undefined, metadata: undefined } } as never)
    expect(noRequestMeta.requestId).toBe("")
    const nonStringMeta = toCrudReadContext(platformCtx(), { operationId: "o", services: {}, metadata: { requestId: 3 } } as never)
    expect(nonStringMeta.requestId).toBe("")
    const requestWins = toCrudReadContext(platformCtx(), { operationId: "o", services: {}, request: { requestId: "r", correlationId: "rc" }, metadata: { requestId: "m" }, correlationId: "oc" } as never)
    expect(requestWins.requestId).toBe("r")
    expect(requestWins.correlationId).toBe("rc")
  })

  it("resolves the request context from the operation or its metadata", () => {
    const context = tenantCtx()
    expect(resolveOperationRequestContext({ request: context } as never)).toBe(context)
    expect(resolveOperationRequestContext({ metadata: { requestContext: context } } as never)).toBe(context)
    expect(resolveOperationRequestContext({ request: undefined, metadata: { requestContext: context } } as never)).toBe(context)
    expect(() => resolveOperationRequestContext({} as never)).toThrow(new ConfigurationError("Canonical request context metadata missing for CRUD hook context"))
    expect(() => resolveOperationRequestContext({ metadata: {} } as never)).toThrow(ConfigurationError)
  })
})

describe("rate limit settings", () => {
  it("separates the limit from its consistency and failure policy", () => {
    expect(normalizeEntityRateLimitSetting({ max: 5, timeWindow: "1 minute", consistency: "atomic" })).toEqual({ config: { max: 5, timeWindow: "1 minute" }, consistency: "atomic" })
    const full = normalizeEntityRateLimitSetting({ max: 5, timeWindow: "1 minute", consistency: "best-effort", failureMode: "fail-open", algorithm: "token-bucket", cost: 2 } as never)
    expect(full).toEqual({ config: { max: 5, timeWindow: "1 minute", algorithm: "token-bucket", cost: 2 }, consistency: "best-effort", policy: { failureMode: "fail-open" } })
    const plain = normalizeEntityRateLimitSetting({ max: 5, timeWindow: "1 minute", consistency: "atomic" })
    for (const key of ["algorithm", "cost"]) expect(key in plain.config).toBe(false)
    expect("policy" in plain).toBe(false)
    expect(normalizeEntityRateLimitSetting({ max: 5, timeWindow: "1 minute", consistency: "atomic", cost: 0 } as never).config).toMatchObject({ cost: 0 })
  })
})

describe("existing record lookup", () => {
  const optionsFor = (repo: object, over: Record<string, unknown> = {}) => baseOptions({ createPersistence: () => persistenceOf(repo), ...over })
  const row = (): Row => ({ id: "w1", tenantId: "tenant-1", version: 3, name: "n" })

  it("reads a scoped entity by key under the structural scope and the extra filter", async () => {
    const repo = fakeRepo({ findOneWhere: vi.fn(async () => row()) })
    const extra = Predicate.eq("name", "x")
    const context = await contextFor("tenant")
    expect(await loadExistingRecord(optionsFor(repo), "w1", context, extra)).toEqual(row())
    const filter = repo.findOneWhere?.mock.calls[0]?.[0]
    expect(filter).toEqual(Predicate.and(Predicate.and(Predicate.eq("id", "w1"), Predicate.and(Predicate.eq("tenantId", "tenant-1"), extra)), Predicate.eq("tenantId", "tenant-1")))
  })

  it("applies the extra filter alone when there is no structural scope", async () => {
    const repo = fakeRepo({ findOneWhere: vi.fn(async () => row()) })
    const extra = Predicate.eq("name", "x")
    const options = optionsFor(repo, { entity: unscopedEntity(), entityScope: undefined })
    await loadExistingRecord(options, "w1", await contextFor("platform"), extra)
    expect(repo.findOneWhere?.mock.calls[0]?.[0]).toEqual(Predicate.and(Predicate.eq("id", "w1"), extra))
  })

  it("applies the structural scope alone without an extra filter", async () => {
    const repo = fakeRepo({ findOneWhere: vi.fn(async () => row()) })
    await loadExistingRecord(optionsFor(repo), "w1", await contextFor("tenant"))
    expect(repo.findOneWhere?.mock.calls[0]?.[0]).toEqual(Predicate.and(Predicate.and(Predicate.eq("id", "w1"), Predicate.eq("tenantId", "tenant-1")), Predicate.eq("tenantId", "tenant-1")))
  })

  it("reads by id when nothing scopes the entity", async () => {
    const repo = fakeRepo({ findById: vi.fn(async () => row()) })
    const options = optionsFor(repo, { entity: unscopedEntity(), entityScope: undefined })
    expect(await loadExistingRecord(options, "w1", await contextFor("platform"))).toEqual(row())
    expect(repo.findById?.mock.calls[0]).toEqual(["w1"])
    expect(repo.findOneWhere).not.toHaveBeenCalled()
  })

  it("falls back to a filtered read for repositories without keyed lookup", async () => {
    const findMany = vi.fn(async () => ({ rows: [row()], rowCount: 1, page: 1, pageSize: 1 }))
    const repo = fakeRepo({ findOneWhere: undefined, findMany })
    const extra = Predicate.eq("name", "x")
    const options = optionsFor(repo, { entity: unscopedEntity(), entityScope: undefined })
    expect(await loadExistingRecord(options, "w1", await contextFor("platform"), extra)).toEqual(row())
    expect(findMany.mock.calls[0]).toEqual([{ filter: Predicate.and(Predicate.eq("id", "w1"), extra) }])
    const none = fakeRepo({ findOneWhere: undefined, findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 1 })) })
    expect(await loadExistingRecord(optionsFor(none, { entity: unscopedEntity(), entityScope: undefined }), "w1", await contextFor("platform"), extra)).toBeNull()
  })

  it("keys the lookup by the declared primary key, defaulting to id", async () => {
    const repo = fakeRepo({ findById: vi.fn(async () => row()) })
    await loadExistingRecord(optionsFor(repo, { entity: unscopedEntity({ primaryKey: "name" }), entityScope: undefined }), "w1", await contextFor("platform"))
    expect(repo.findById?.mock.calls[0]).toEqual(["w1"])
    const scoped = fakeRepo({ findOneWhere: vi.fn(async () => row()) })
    const extra = Predicate.eq("name", "x")
    await loadExistingRecord(optionsFor(scoped, { entity: unscopedEntity({ primaryKey: "name" }), entityScope: undefined }), "w1", await contextFor("platform"), extra)
    expect(scoped.findOneWhere?.mock.calls[0]?.[0]).toEqual(Predicate.and(Predicate.eq("name", "w1"), extra))
    const keyless = fakeRepo({ findOneWhere: vi.fn(async () => row()) })
    await loadExistingRecord(optionsFor(keyless, { entity: { ...keylessEntity(), tenantField: undefined }, entityScope: undefined }), "w1", await contextFor("platform"), extra)
    expect(keyless.findOneWhere?.mock.calls[0]?.[0]).toEqual(Predicate.and(Predicate.eq("id", "w1"), extra))
  })

  it("scopes persistence to the tenant only for tenant entities", async () => {
    const seen: unknown[] = []
    const repo = fakeRepo({ findById: vi.fn(async () => row()) })
    const persistence = persistenceOf(repo)
    const probe = new Proxy(persistence, { get: (target, key, receiver) => { if (key === "repository") seen.push(receiver); return Reflect.get(target, key, receiver) } })
    await loadExistingRecord(baseOptions({ createPersistence: () => probe, entity: unscopedEntity(), entityScope: undefined }), "w1", await contextFor("tenant"))
    expect(seen[0]).toBe(probe)
    expect(createTenantScopedPersistenceProvider).toBeTypeOf("function")
  })
})

describe("read access and rate limits", () => {
  const optionsOf = (over: Record<string, unknown> = {}) => baseOptions(over)
  const routes = { list: true, detail: true, create: false, update: false, delete: false }

  it("limits reads by scope, actor, module, route and client address", async () => {
    const getRateLimitStore = vi.fn(async () => ({}) as never)
    const options = optionsOf({ getRateLimitStore, adapterDeps: { ...baseOptions().adapterDeps, resolveClientIp: () => "8.8.8.8" } })
    const { enforceReadRateLimit } = createShared(options, routes, { enabled: false, key: undefined })
    const context = await contextFor("tenant", "list")
    await enforceReadRateLimit("list", { max: 5, timeWindow: "1 minute", consistency: "atomic", failureMode: "fail-open" } as never, new Request("https://example.test/"), context)
    expect(spy.rate).toHaveLength(1)
    expect(spy.rate[0]).toEqual({
      store: await getRateLimitStore.mock.results[0]?.value,
      key: `${context.scopeId}:actor-1:${MODULE_KEY}:list:8.8.8.8`,
      config: { max: 5, timeWindow: "1 minute" },
      consistency: "atomic",
      policy: { failureMode: "fail-open" },
    })
  })

  it("skips enforcement without a setting, and uses the cache-backed store for best-effort limits", async () => {
    const adapter = {} as never
    const getCacheAdapter = vi.fn(async () => adapter)
    const getRateLimitStore = vi.fn(async () => ({}) as never)
    const { enforceReadRateLimit } = createShared(optionsOf({ getCacheAdapter, getRateLimitStore }), routes, { enabled: false, key: undefined })
    const context = await contextFor("tenant", "detail")
    await enforceReadRateLimit("detail", undefined, new Request("https://example.test/"), context)
    expect(spy.rate).toHaveLength(0)
    await enforceReadRateLimit("detail", { max: 1, timeWindow: "1 minute", consistency: "best-effort" } as never, new Request("https://example.test/"), context)
    expect(getCacheAdapter).toHaveBeenCalledOnce()
    expect(getRateLimitStore).not.toHaveBeenCalled()
    expect((spy.rate[0]?.store as object).constructor.name).toBe("CacheBackedRateLimitStore")
    expect(spy.rate[0]?.key).toBe(`${context.scopeId}:actor-1:${MODULE_KEY}:detail:unknown`)
    expect(spy.rate[0]?.consistency).toBe("best-effort")
  })

  it("needs no atomic store for best-effort read limits", async () => {
    const adapter = {} as never
    const { enforceReadRateLimit } = createShared(optionsOf({ getCacheAdapter: async () => adapter }), routes, { enabled: false, key: undefined })
    await expect(enforceReadRateLimit("list", { max: 1, timeWindow: "1 minute", consistency: "best-effort" } as never, new Request("https://example.test/"), await contextFor("tenant", "list"))).resolves.toBeUndefined()
    expect(spy.rate).toHaveLength(1)
  })

  it("requires an atomic store for atomic read limits", async () => {
    const { enforceReadRateLimit } = createShared(optionsOf(), routes, { enabled: false, key: undefined })
    await expect(enforceReadRateLimit("list", { max: 1, timeWindow: "1 minute", consistency: "atomic" } as never, new Request("https://example.test/"), await contextFor("tenant", "list"))).rejects.toEqual(new ConfigurationError("Atomic rate limiting requires an atomic rate-limit store"))
  })

  it("authorizes reads against the verified bundle and returns it", async () => {
    const options = optionsOf()
    const { enforceReadAccess } = createShared(options, routes, { enabled: false, key: undefined })
    const context = await contextFor("tenant", "list")
    const bundle = await enforceReadAccess(new Request("https://example.test/"), context)
    expect(bundle?.moduleKey).toBe(MODULE_KEY)
    const input = spy.authorization[0] as Record<string, unknown>
    expect(input.action).toBe("read")
    expect(input.evaluateAbacAction).toBe(false)
    expect(input.moduleKey).toBe(MODULE_KEY)
    expect("capabilityKey" in input).toBe(false)
  })

  it("passes the capability key when capability mode is on, and fails closed without a bundle", async () => {
    const { enforceReadAccess } = createShared(optionsOf(), routes, { enabled: true, key: "manage" })
    const context = await contextFor("tenant", "list")
    await enforceReadAccess(new Request("https://example.test/"), context)
    expect(spy.authorization[0]?.capabilityKey).toBe("manage")
    const base = baseOptions()
    const missing = createShared(optionsOf({ adapterDeps: { ...base.adapterDeps, resolveAbacBundle: async () => null } }), routes, { enabled: false, key: undefined })
    await expect(missing.enforceReadAccess(new Request("https://example.test/"), context)).rejects.toEqual(new ForbiddenError("ABAC authorization bundle unavailable"))
    const unverified = createShared(optionsOf({ adapterDeps: { ...base.adapterDeps, resolveAbacBundle: async () => ({ defaultEffect: "deny", securityDigest: "x" }) } }), routes, { enabled: false, key: undefined })
    await expect(unverified.enforceReadAccess(new Request("https://example.test/"), context)).rejects.toThrow("ABAC bundle is not a verified production bundle")
  })

  it("refuses anonymous reads of capability-gated modules, and lets public ones through", async () => {
    const context = asAnonymous(await contextFor("tenant", "list"))
    const gated = createShared(optionsOf(), routes, { enabled: true, key: "manage" })
    await expect(gated.enforceReadAccess(new Request("https://example.test/"), context)).rejects.toEqual(new ForbiddenError("This operation is not permitted"))
    const resolve = vi.fn()
    const base = baseOptions()
    const open = createShared(optionsOf({ adapterDeps: { ...base.adapterDeps, resolveAbacBundle: resolve } }), routes, { enabled: false, key: undefined })
    await expect(open.enforceReadAccess(new Request("https://example.test/"), context)).rejects.toEqual(new ForbiddenError("An ABAC policy bundle is required for this operation"))
    expect(resolve).not.toHaveBeenCalled()
    const input = spy.authorization.at(-1) as Record<string, unknown>
    expect(input.evaluateAbacAction).toBe(false)
    expect("bundle" in input).toBe(false)
  })

  it("builds the read scope from the bundle, or an open scope without one", async () => {
    const { buildReadScope } = createShared(optionsOf(), routes, { enabled: false, key: undefined })
    expect(buildReadScope(undefined)).toEqual({ filter: undefined })
    expect("cacheScopeKey" in buildReadScope(undefined)).toBe(false)
    const bundle = await allowAllAbacBundle(MODULE_KEY)
    const expected = createAbacAuthorizer(bundle).buildActionScope("read")
    const scope = buildReadScope(bundle)
    expect(scope.filter).toEqual(expected.filter)
    expect(scope.filter).toBeDefined()
    expect("cacheScopeKey" in scope).toBe(expected.cacheScopeKey !== undefined)
    const keyedBundle = await bindAbacSecurityDigest({
      mode: "platform",
      moduleKey: MODULE_KEY,
      policies: [],
      context: {},
      defaultEffect: "deny",
      fieldCatalog: {},
      cacheScopeKey: "scope-k",
    } as never)
    const keyed = buildReadScope(keyedBundle)
    expect(keyed.cacheScopeKey).toBe("scope-k")
    expect("cacheScopeKey" in keyed).toBe(true)
  })

  it("resolves the read scope per context", async () => {
    const options = optionsOf()
    const { resolveReadScopeForContext } = createShared(options, routes, { enabled: false, key: undefined })
    const context = await contextFor("tenant", "list")
    const expected = createAbacAuthorizer(await allowAllAbacBundle(MODULE_KEY)).buildActionScope("read")
    expect((await resolveReadScopeForContext(context)).filter).toEqual(expected.filter)
    expect(await resolveReadScopeForContext(asAnonymous(context))).toStrictEqual({ filter: undefined })
    const base = baseOptions()
    const none = createShared(optionsOf({ adapterDeps: { ...base.adapterDeps, resolveAbacBundle: async () => null } }), routes, { enabled: false, key: undefined })
    await expect(none.resolveReadScopeForContext(context)).rejects.toEqual(new ForbiddenError("ABAC authorization bundle unavailable"))
    const unverified = createShared(optionsOf({ adapterDeps: { ...base.adapterDeps, resolveAbacBundle: async () => ({ defaultEffect: "deny", securityDigest: "x" }) } }), routes, { enabled: false, key: undefined })
    await expect(unverified.resolveReadScopeForContext(context)).rejects.toThrow("ABAC bundle is not a verified production bundle")
  })

  it("builds the read tags from the cache tag and the context", async () => {
    const { buildReadTags } = createShared(optionsOf({ cache: { enabled: true, tag: "people", keyPrefix: "p" } }), routes, { enabled: false, key: undefined })
    expect(buildReadTags(tenantCtx("t1"))).toEqual([encodeTenantCacheTag("t1", "people"), encodeTenantCacheTag("t1", "scope")])
  })
})
