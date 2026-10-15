import { describe, expect, it, vi } from "vitest"
import { createAnonymousPrincipal, ForbiddenError, type ExecutionScope, type ExecutionScopeId, type Principal } from "@xonava/core/domain"
import { type CompiledRouteBinding, type CompiledScopeResolverBinding } from "@xonava/core/bootstrap"
import { createVerifiedScopeResolution, type ScopeResolver } from "@xonava/core/security"
import { normalizeFrameworkRequest, type ScopeAdmissionEvidence, type TrustedFrameworkSession } from "../scopeResolution"

const NOW = new Date("2026-09-10T00:00:01.000Z")
const signal = new AbortController().signal
const admission: ScopeAdmissionEvidence = {
  grantId: "grant-1", purpose: "route execution", reason: "compiled route admission", issuedAt: "2026-09-10T00:00:00.000Z",
  policy: { policyKey: "catalog.public", policyVersion: 1, policyDigest: "digest", evaluatedAt: "2026-09-10T00:00:00.000Z", authorizationModel: "continuous" },
}

function route(overrides: Partial<CompiledRouteBinding> = {}): CompiledRouteBinding {
  return {
    routeKey: "catalog.list", definitionVersion: 1, transport: "http", method: "GET", pathTemplate: "/products",
    exposure: "public", operationKey: "catalog.list", scopeResolution: { kind: "resolver", resolverKey: "directory", allowedTargetKinds: ["tenant"] },
    anonymousPrincipal: { allowed: true, principal: createAnonymousPrincipal() }, inputPolicy: {}, outputPolicy: {}, mutation: { allowed: false },
    authorizationPlanKey: "catalog.public", ...overrides,
  }
}

function bindings(resolver: ScopeResolver, allowedTargetKinds: CompiledScopeResolverBinding["allowedTargetKinds"] = ["tenant"]): ReadonlyMap<string, CompiledScopeResolverBinding> {
  return new Map([["directory", { key: "directory", definitionVersion: 1, resolver, allowedTargetKinds }]])
}

function base(resolver: ScopeResolver) {
  return { requestId: "request-1", correlationId: "correlation-1", route: route(), resolverBindings: bindings(resolver), admit: async () => admission, signal, now: NOW }
}

describe("A2 trusted scope normalization", () => {
  it("resolves an authoritative public tenant, preserves anonymity, and passes the route ref", async () => {
    const resolve = vi.fn(async (_input, routeRef) => {
      expect(routeRef).toEqual({ routeKey: "catalog.list", definitionVersion: 1, operationKey: "catalog.list" })
      return createVerifiedScopeResolution("directory", { kind: "tenant", tenantId: "tenant-42" })
    }) satisfies ScopeResolver["resolve"]
    const admit = vi.fn(async (resolved) => {
      expect(resolved.scope).toEqual({ kind: "tenant", tenantId: "tenant-42" })
      expect(resolved.identity.actor.kind).toBe("anonymous")
      return admission
    })
    const context = await normalizeFrameworkRequest({ ...base({ key: "directory", resolve }), admit, host: "shop.example.test" })
    expect(context.scope).toEqual({ kind: "tenant", tenantId: "tenant-42" })
    expect(context.identity.actor.kind).toBe("anonymous")
    expect(context.identity.subject).toBe(context.identity.actor)
    expect(context.route).toEqual({ routeKey: "catalog.list", definitionVersion: 1, operationKey: "catalog.list" })
    expect(context.authority.grant.source).toEqual({ kind: "route", routeKey: "catalog.list" })
    expect(admit).toHaveBeenCalledOnce()
  })

  it("requires and honors a fresh verifier for authoritative-store delegations", async () => {
    const resolver: ScopeResolver = { key: "directory", resolve: async () => createVerifiedScopeResolution("directory", { kind: "tenant", tenantId: "tenant-42" }) }
    const admit = async ({ scope, scopeId }: { scope: ExecutionScope; scopeId: ExecutionScopeId }): Promise<ScopeAdmissionEvidence> => ({
      ...admission,
      delegationChain: [{ grantId: "delegation-1", issuer: createAnonymousPrincipal(), source: { kind: "route", routeKey: "catalog.list" }, target: { scope, scopeId }, purpose: "catalog", reason: "support", issuedAt: "2026-09-10T00:00:00.000Z", policy: admission.policy, revocation: { kind: "authoritative-store", verifierKey: "grants", grantVersion: "7" } }],
    })
    await expect(normalizeFrameworkRequest({ ...base(resolver), admit })).rejects.toThrow(/requires a revocation verifier/)
    await expect(normalizeFrameworkRequest({ ...base(resolver), admit, verifyDelegationRevocation: async () => false })).rejects.toBeInstanceOf(ForbiddenError)
    const verify = vi.fn(async () => true)
    await expect(normalizeFrameworkRequest({ ...base(resolver), admit, verifyDelegationRevocation: verify })).resolves.toBeDefined()
    expect(verify).toHaveBeenCalledOnce()
  })

  it("never forwards query, body, or cursor values to the resolver", async () => {
    const resolve = vi.fn(async (input) => {
      expect(input).toEqual({ host: "tenant.example", pathParameters: { tenantSlug: "real" } })
      return createVerifiedScopeResolution("directory", { kind: "tenant", tenantId: "authoritative" })
    }) satisfies ScopeResolver["resolve"]
    await normalizeFrameworkRequest({
      ...base({ key: "directory", resolve }), host: "tenant.example", pathParameters: { tenantSlug: "real" },
      ...({ query: { tenantId: "forged" }, body: { tenantId: "forged" }, cursor: "forged" } as Record<string, unknown>),
    })
  })

  it("rejects forged directory keys and missing compiled bindings", async () => {
    const resolver: ScopeResolver = { key: "directory", resolve: async () => { throw new Error("unknown tenant") } }
    await expect(normalizeFrameworkRequest({ ...base(resolver), host: "forged.example" })).rejects.toThrow(/unknown tenant/)
    await expect(normalizeFrameworkRequest({ ...base(resolver), resolverBindings: new Map() })).rejects.toThrow(/missing compiled scope resolver binding/)
  })

  it("rejects resolver and route target-kind widening", async () => {
    const resolver: ScopeResolver = { key: "directory", resolve: async () => createVerifiedScopeResolution("directory", { kind: "system", systemKey: "root" }) }
    await expect(normalizeFrameworkRequest({ ...base(resolver), resolverBindings: bindings(resolver, ["tenant", "system"]) })).rejects.toThrow(/outside route binding/)
    await expect(normalizeFrameworkRequest({ ...base(resolver) })).rejects.toThrow(/outside resolver binding/)
  })

  it("rejects a spoofed resolver binding identity", async () => {
    const resolver: ScopeResolver = { key: "spoof", resolve: async () => createVerifiedScopeResolution("spoof", { kind: "tenant", tenantId: "t" }) }
    await expect(normalizeFrameworkRequest({ ...base(resolver), resolverBindings: new Map([["directory", { key: "directory", definitionVersion: 1, resolver, allowedTargetKinds: ["tenant"] }]]) })).rejects.toThrow(/binding identity mismatch/)
  })

  it("rejects an unbranded resolver result even when its fields look valid", async () => {
    const resolver = {
      key: "directory",
      resolve: async () => ({
        scope: { kind: "tenant", tenantId: "forged" },
        scopeId: "fscope:v1:forged",
        resolverKey: "directory",
      }),
    } as unknown as ScopeResolver
    await expect(normalizeFrameworkRequest({ ...base(resolver) })).rejects.toThrow(/unverified or mismatched/)
  })

  it("preserves explicit impersonation actor and subject provenance", async () => {
    const authenticated = (id: string): Principal => ({ id, kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } })
    const session: TrustedFrameworkSession = { identity: { actor: authenticated("support"), subject: authenticated("customer") }, scope: { kind: "tenant", tenantId: "tenant-42" } }
    const context = await normalizeFrameworkRequest({
      requestId: "r", correlationId: "c", route: route({ exposure: "authenticated", scopeResolution: { kind: "fixed", scope: session.scope }, anonymousPrincipal: { allowed: false } }),
      resolverBindings: new Map(), session, admit: async () => admission, signal, now: NOW,
    })
    expect(context.identity).toEqual(session.identity)
    expect(context.authority.grant.impersonation).toEqual({ kind: "explicit", actorId: "support", subjectId: "customer", grantId: "grant-1" })
  })

  it("rejects public session inheritance and fixed-scope session mismatch", async () => {
    const resolver: ScopeResolver = { key: "directory", resolve: async () => createVerifiedScopeResolution("directory", { kind: "tenant", tenantId: "t" }) }
    const principal: Principal = { id: "u", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
    const session: TrustedFrameworkSession = { identity: { actor: principal, subject: principal }, scope: { kind: "tenant", tenantId: "other" } }
    await expect(normalizeFrameworkRequest({ ...base(resolver), session })).rejects.toThrow(/cannot inherit authenticated session authority/)
    await expect(normalizeFrameworkRequest({ ...base(resolver), route: route({ exposure: "authenticated", anonymousPrincipal: { allowed: false }, scopeResolution: { kind: "fixed", scope: { kind: "tenant", tenantId: "expected" } } }), session })).rejects.toThrow(/scope mismatch/)
  })

  it("rejects an authenticated tenant resolver attempting to rebind to another tenant", async () => {
    const principal: Principal = { id: "u", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
    const session: TrustedFrameworkSession = { identity: { actor: principal, subject: principal }, scope: { kind: "tenant", tenantId: "tenant-a" } }
    const resolver: ScopeResolver = { key: "directory", resolve: async () => createVerifiedScopeResolution("directory", { kind: "tenant", tenantId: "tenant-b" }) }
    await expect(normalizeFrameworkRequest({
      ...base(resolver), route: route({ exposure: "authenticated", anonymousPrincipal: { allowed: false } }), session,
    })).rejects.toThrow(/cannot widen or rebind/)
  })
})
