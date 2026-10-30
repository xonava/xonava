import { describe, expect, it, vi } from "vitest"
import {
  ConfigurationError,
  createAnonymousPrincipal,
  encodeExecutionScopeId,
  ForbiddenError,
  UnauthorizedError,
  type AuthorityOrigin,
  type ExecutionScope,
  type Principal,
} from "@xonava/core/domain"
import { type CompiledRouteBinding, type CompiledScopeResolverBinding } from "@xonava/core/bootstrap"
import { createVerifiedScopeResolution, type ScopeResolver, type UntrustedScopeResolutionInput } from "@xonava/core/security"
import { normalizeFrameworkRequest, type NormalizeFrameworkRequestInput, type ScopeAdmissionEvidence, type TrustedFrameworkSession } from "../scopeResolution"

const NOW = new Date("2026-09-10T00:00:01.000Z")
const signal = new AbortController().signal
const ISSUED = "2026-09-10T00:00:00.000Z"
const admission: ScopeAdmissionEvidence = {
  grantId: "grant-1", purpose: "route execution", reason: "compiled route admission", issuedAt: ISSUED,
  policy: { policyKey: "catalog.public", policyVersion: 1, policyDigest: "digest", evaluatedAt: ISSUED, authorizationModel: "continuous" },
}
const human = (id: string): Principal => ({ id, kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: ISSUED } })
const tenantScope = (tenantId: string): ExecutionScope => ({ kind: "tenant", tenantId })
const platformScope: ExecutionScope = { kind: "platform", platformKey: "ops" }

function route(overrides: Partial<CompiledRouteBinding> = {}): CompiledRouteBinding {
  return {
    routeKey: "catalog.list", definitionVersion: 1, transport: "http", method: "GET", pathTemplate: "/products",
    exposure: "public", operationKey: "catalog.list", scopeResolution: { kind: "resolver", resolverKey: "directory", allowedTargetKinds: ["tenant"] },
    anonymousPrincipal: { allowed: true, principal: createAnonymousPrincipal() }, inputPolicy: {}, outputPolicy: {}, mutation: { allowed: false },
    authorizationPlanKey: "catalog.public", ...overrides,
  }
}
const authenticatedRoute = (overrides: Partial<CompiledRouteBinding> = {}): CompiledRouteBinding =>
  route({ exposure: "authenticated", anonymousPrincipal: { allowed: false }, ...overrides })

function resolverFor(tenantId: string, seen?: (input: UntrustedScopeResolutionInput) => void): ScopeResolver {
  return {
    key: "directory",
    resolve: async (input) => {
      seen?.(input)
      return createVerifiedScopeResolution("directory", tenantScope(tenantId))
    },
  }
}

function bindings(resolver: ScopeResolver, allowedTargetKinds: CompiledScopeResolverBinding["allowedTargetKinds"] = ["tenant"]): ReadonlyMap<string, CompiledScopeResolverBinding> {
  return new Map([["directory", { key: "directory", definitionVersion: 1, resolver, allowedTargetKinds }]])
}

function base(resolver: ScopeResolver): NormalizeFrameworkRequestInput {
  return { requestId: "request-1", correlationId: "correlation-1", route: route(), resolverBindings: bindings(resolver), admit: async () => admission, signal, now: NOW }
}

describe("scope resolver input", () => {
  it("forwards exactly the supplied untrusted facts as frozen copies and omits the absent ones", async () => {
    const seen: UntrustedScopeResolutionInput[] = []
    const resolver = resolverFor("t1", (input) => seen.push(input))
    const headers = { "x-tenant": "a" }
    const pathParameters = { slug: "s" }
    const resolverFacts = { org: "o" }
    const principal = human("u")
    const session: TrustedFrameworkSession = { identity: { actor: principal, subject: principal }, scope: tenantScope("t1"), resolverFacts }
    await normalizeFrameworkRequest({ ...base(resolver), route: authenticatedRoute(), session, host: "h.example", headers, pathParameters })
    const input = seen[0]!
    expect(input).toStrictEqual({ host: "h.example", pathParameters: { slug: "s" }, headers: { "x-tenant": "a" }, sessionFacts: { org: "o" } })
    expect(Object.isFrozen(input)).toBe(true)
    expect(Object.isFrozen(input.headers)).toBe(true)
    expect(Object.isFrozen(input.pathParameters)).toBe(true)
    expect(Object.isFrozen(input.sessionFacts)).toBe(true)
    expect(input.headers).not.toBe(headers)
    expect(input.pathParameters).not.toBe(pathParameters)
    expect(input.sessionFacts).not.toBe(resolverFacts)

    await normalizeFrameworkRequest({ ...base(resolver) })
    expect(seen[1]).toStrictEqual({})
    expect(Object.keys(seen[1]!)).toEqual([])
    await normalizeFrameworkRequest({ ...base(resolver), route: authenticatedRoute(), session: { identity: session.identity, scope: tenantScope("t1") } })
    expect(Object.keys(seen[2]!)).toEqual([])
  })
})

describe("route and session configuration errors", () => {
  const resolver = resolverFor("t1")
  it("names each misconfiguration exactly", async () => {
    const principal = human("u")
    const session: TrustedFrameworkSession = { identity: { actor: principal, subject: principal }, scope: tenantScope("t1") }
    const fixed = { kind: "fixed", scope: tenantScope("t1") } as const
    await expect(normalizeFrameworkRequest({ ...base(resolver), route: route({ scopeResolution: fixed }) })).rejects.toThrow(
      expect.objectContaining({ name: "ConfigurationError", message: "public route cannot use a fixed execution scope" }),
    )
    await expect(normalizeFrameworkRequest({ ...base(resolver), route: route({ exposure: "authenticated" }) })).rejects.toThrow(
      expect.objectContaining({ name: "ConfigurationError", message: "authenticated route requires a trusted session" }),
    )
    await expect(normalizeFrameworkRequest({ ...base(resolver), route: route({ anonymousPrincipal: { allowed: false } }) })).rejects.toThrow(
      expect.objectContaining({ name: "ConfigurationError", message: "public route has no compiled anonymous principal" }),
    )
    await expect(normalizeFrameworkRequest({ ...base(resolver), session })).rejects.toThrow(
      expect.objectContaining({ name: "ConfigurationError", message: "public route cannot inherit authenticated session authority" }),
    )
    await expect(normalizeFrameworkRequest({ ...base(resolver), route: route({ anonymousPrincipal: { allowed: true, principal } }) })).rejects.toThrow(
      expect.objectContaining({ name: "ConfigurationError", message: "public route principal must be anonymous" }),
    )
    await expect(normalizeFrameworkRequest({ ...base(resolver), resolverBindings: new Map() })).rejects.toThrow(
      expect.objectContaining({ name: "ConfigurationError", message: "missing compiled scope resolver binding directory" }),
    )
  })

  it("answers an absent session with 401 and the fixed-scope mismatch with a 403 ForbiddenError", async () => {
    const principal = human("u")
    const fixedRoute = authenticatedRoute({ scopeResolution: { kind: "fixed", scope: tenantScope("t1") } })
    await expect(normalizeFrameworkRequest({ ...base(resolverFor("t1")), route: fixedRoute })).rejects.toBeInstanceOf(UnauthorizedError)
    const wrong: TrustedFrameworkSession = { identity: { actor: principal, subject: principal }, scope: tenantScope("t2") }
    const error = await normalizeFrameworkRequest({ ...base(resolverFor("t1")), route: fixedRoute, session: wrong }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ForbiddenError)
    expect((error as ForbiddenError).message).toBe("session and fixed route scope mismatch")
    const ok = await normalizeFrameworkRequest({ ...base(resolverFor("t1")), route: fixedRoute, session: { identity: wrong.identity, scope: tenantScope("t1") } })
    expect(ok.scope).toEqual(tenantScope("t1"))
    expect(ok.identity).toEqual(wrong.identity)
  })
})

describe("scope attenuation and authority source", () => {
  const principal = human("support")
  const platformSession: TrustedFrameworkSession = { identity: { actor: principal, subject: principal }, scope: platformScope }
  const attenuatingRoute = authenticatedRoute({ scopeResolution: { kind: "resolver", resolverKey: "directory", allowedTargetKinds: ["tenant"] } })

  function hopFor(session: TrustedFrameworkSession) {
    return (resolved: { scope: ExecutionScope; scopeId: never }): ScopeAdmissionEvidence => ({
      ...admission,
      delegationChain: [{
        grantId: "delegation-1", issuer: session.identity.actor,
        source: { kind: "authority", target: { scope: session.scope, scopeId: undefined as never } },
        target: { scope: resolved.scope, scopeId: resolved.scopeId }, purpose: "support", reason: "customer assistance", issuedAt: ISSUED,
        policy: admission.policy, revocation: { kind: "not-revocable-before-expiry" },
      }],
    })
  }

  async function attenuate(delegation: "none" | "empty" | "chain", sessionSource?: AuthorityOrigin) {
    const session: TrustedFrameworkSession = { ...platformSession, ...(sessionSource ? { source: sessionSource } : {}) }
    const admit = vi.fn(async (resolved: Parameters<NormalizeFrameworkRequestInput["admit"]>[0]): Promise<ScopeAdmissionEvidence> => {
      if (delegation === "none") return admission
      if (delegation === "empty") return { ...admission, delegationChain: [] }
      const hop = hopFor(session)({ scope: resolved.scope, scopeId: resolved.scopeId as never })
      const sourceTarget = { scope: session.scope, scopeId: encodeExecutionScopeId(session.scope) }
      const source = sessionSource ?? { kind: "authority" as const, target: sourceTarget }
      return { ...hop, delegationChain: [{ ...hop.delegationChain![0]!, source }] }
    })
    return normalizeFrameworkRequest({ ...base(resolverFor("t9")), route: attenuatingRoute, session, admit })
  }

  it("refuses attenuation from platform to tenant without compiled delegation evidence", async () => {
    for (const mode of ["none", "empty"] as const) {
      await expect(attenuate(mode)).rejects.toThrow(
        expect.objectContaining({ name: "ConfigurationError", message: "scope attenuation requires compiled delegation evidence" }),
      )
    }
  })

  it("admits attenuation with delegation evidence and records the session scope as the authority source", async () => {
    const context = await attenuate("chain")
    expect(context.scope).toEqual(tenantScope("t9"))
    expect(context.authority.grant.source).toEqual({ kind: "authority", target: { scope: platformScope, scopeId: encodeExecutionScopeId(platformScope) } })
    expect(context.authority.grant.target).toEqual({ scope: tenantScope("t9"), scopeId: context.scopeId })
    expect(context.authority.grant.delegationChain).toHaveLength(1)
  })

  it("keeps an explicit session source instead of deriving one", async () => {
    const explicit: AuthorityOrigin = { kind: "authority", target: { scope: platformScope, scopeId: encodeExecutionScopeId(platformScope) } }
    const context = await attenuate("chain", explicit)
    expect(context.authority.grant.source).toEqual(explicit)
  })

  it("derives the authority source from the session scope when no scope change happens", async () => {
    const session: TrustedFrameworkSession = { identity: { actor: principal, subject: principal }, scope: tenantScope("t1") }
    const context = await normalizeFrameworkRequest({ ...base(resolverFor("t1")), route: attenuatingRoute, session })
    expect(context.authority.grant.source).toEqual({ kind: "authority", target: { scope: tenantScope("t1"), scopeId: encodeExecutionScopeId(tenantScope("t1")) } })
  })

  it("refuses a tenant session that a resolver rebinds to a platform scope", async () => {
    const tenantSession: TrustedFrameworkSession = { identity: platformSession.identity, scope: tenantScope("t1") }
    const resolver: ScopeResolver = { key: "directory", resolve: async () => createVerifiedScopeResolution("directory", platformScope) }
    await expect(normalizeFrameworkRequest({
      ...base(resolver), route: authenticatedRoute({ scopeResolution: { kind: "resolver", resolverKey: "directory", allowedTargetKinds: ["platform"] } }),
      resolverBindings: bindings(resolver, ["platform"]), session: tenantSession,
    })).rejects.toThrow(expect.objectContaining({ name: "ConfigurationError", message: "trusted session authority cannot widen or rebind to resolved scope" }))
  })
})

describe("identity provenance and request fields", () => {
  it("treats same-id principals of different kinds as impersonation", async () => {
    const actor = human("same")
    const subject: Principal = { id: "same", kind: "service", authentication: { kind: "authenticated", method: "session", authenticatedAt: ISSUED } }
    const session: TrustedFrameworkSession = { identity: { actor, subject }, scope: tenantScope("t1") }
    const context = await normalizeFrameworkRequest({ ...base(resolverFor("t1")), route: authenticatedRoute(), session })
    expect(context.authority.grant.impersonation).toEqual({ kind: "explicit", actorId: "same", subjectId: "same", grantId: "grant-1" })
  })

  it("carries every optional request field and copies the mutable ones", async () => {
    const principal = human("u")
    const session: TrustedFrameworkSession = { identity: { actor: principal, subject: principal }, scope: tenantScope("t1") }
    const traceContext = { traceparent: "00-abc" }
    const metadata = { client: "web" }
    const context = await normalizeFrameworkRequest({
      ...base(resolverFor("t1")), route: authenticatedRoute(), session,
      causationId: "cause-1", deadline: "2026-09-10T00:05:00.000Z", locale: "de-DE", timezone: "Europe/Berlin", traceContext, metadata,
      admit: async () => ({ ...admission, expiresAt: "2026-09-10T01:00:00.000Z" }),
    })
    expect(context.requestId).toBe("request-1")
    expect(context.correlationId).toBe("correlation-1")
    expect(context.causationId).toBe("cause-1")
    expect(context.authority.causationId).toBe("cause-1")
    expect(context.authority.correlationId).toBe("correlation-1")
    expect(context.authority.grant.expiresAt).toBe("2026-09-10T01:00:00.000Z")
    expect(context.deadline).toBe("2026-09-10T00:05:00.000Z")
    expect(context.locale).toBe("de-DE")
    expect(context.timezone).toBe("Europe/Berlin")
    expect(context.traceContext).toEqual({ traceparent: "00-abc" })
    expect(context.traceContext).not.toBe(traceContext)
    expect(context.metadata).toEqual({ client: "web" })
    expect(context.metadata).not.toBe(metadata)
    expect(context.signal).toBe(signal)
  })

  it("omits every optional field that was not supplied", async () => {
    const context = await normalizeFrameworkRequest(base(resolverFor("t1")))
    for (const key of ["causationId", "deadline", "locale", "timezone", "traceContext", "metadata"]) expect(key in context).toBe(false)
    expect("causationId" in context.authority).toBe(false)
    expect("expiresAt" in context.authority.grant).toBe(false)
    expect(context.authority.grant.delegationChain).toEqual([])
    expect(context.authority.grant.impersonation).toEqual({ kind: "none" })
  })
})
