import { describe, expect, it } from "vitest"
import { assertAuthorityProvenance, freezeAuthorityProvenance, type AuthorityGrant, type AuthorityProvenance, type DelegationHop, type PolicyEvidence, type ScopedAuthorityTarget } from "../authority"
import { decodeExecutionScopeId, encodeExecutionScopeId, executionScopesEqual, isAuthorityNarrowing, isExecutionScopeKind, validateExecutionScope, type ExecutionScope } from "../executionScope"
import { assertPrincipal, createAnonymousPrincipal, isRfc3339UtcInstant, type Principal } from "../principal"
import { assertRequestContext, freezeRequestContext, freezeVerifiedRequestContext, type RequestContext } from "../requestContext"

const instant = "2026-09-10T00:00:00.000Z"
const now = new Date("2026-09-10T01:00:00.000Z")
const human = (id: string): Principal => ({ id, kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: instant } })
const policy: PolicyEvidence = { policyKey: "support", policyVersion: 1, policyDigest: "sha256:abc", evaluatedAt: instant, authorizationModel: "snapshot" }
const target = (scope: ExecutionScope): ScopedAuthorityTarget => ({ scope, scopeId: encodeExecutionScopeId(scope) })

function provenance(overrides: Partial<AuthorityGrant> = {}, actor = human("u1"), subject = actor): AuthorityProvenance {
  const tenant = target({ kind: "tenant", tenantId: "tenant-1" })
  return {
    identity: { actor, subject },
    correlationId: "correlation-1",
    grant: {
      grantId: "grant-1",
      source: { kind: "route", routeKey: "orders.read" },
      target: tenant,
      purpose: "read-orders",
      reason: "request",
      issuedAt: instant,
      expiresAt: "2026-09-11T00:00:00.000Z",
      policy,
      delegationChain: [],
      impersonation: { kind: "none" },
      ...overrides,
    },
  }
}

describe("A1 canonical execution scope", () => {
  const vectors: readonly [ExecutionScope, string][] = [
    [{ kind: "application", applicationKey: "app-main" }, "fscope:v1:eyJhcHBsaWNhdGlvbktleSI6ImFwcC1tYWluIiwia2luZCI6ImFwcGxpY2F0aW9uIn0"],
    [{ kind: "tenant", tenantId: "tenant-42" }, "fscope:v1:eyJraW5kIjoidGVuYW50IiwidGVuYW50SWQiOiJ0ZW5hbnQtNDIifQ"],
    [{ kind: "platform", platformKey: "main" }, "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6Im1haW4ifQ"],
    [{ kind: "system", systemKey: "scheduler" }, "fscope:v1:eyJraW5kIjoic3lzdGVtIiwic3lzdGVtS2V5Ijoic2NoZWR1bGVyIn0"],
  ]

  it.each(vectors)("validates and round-trips $kind using a frozen F1 vector", (scope, encoded) => {
    expect(validateExecutionScope(scope)).toEqual(scope)
    expect(encodeExecutionScopeId(scope)).toBe(encoded)
    expect(decodeExecutionScopeId(encoded)).toEqual(scope)
  })

  it("rejects empty, whitespace, public and extra-key scopes", () => {
    expect(() => validateExecutionScope({ kind: "tenant", tenantId: " " })).toThrow(/non-empty/)
    expect(() => validateExecutionScope({ kind: "public" })).toThrow(/kind/)
    expect(() => validateExecutionScope({ kind: "system", systemKey: "s", tenantId: "t" })).toThrow(/extra/)
  })

  it("supports equality, kind narrowing and only explicit authority narrowing", () => {
    const tenant = { kind: "tenant", tenantId: "t1" } as const
    expect(executionScopesEqual(tenant, { kind: "tenant", tenantId: "t1" })).toBe(true)
    expect(isExecutionScopeKind(tenant, "tenant")).toBe(true)
    expect(isAuthorityNarrowing({ kind: "platform", platformKey: "p" }, tenant)).toBe(true)
    expect(isAuthorityNarrowing(tenant, { kind: "tenant", tenantId: "t2" })).toBe(false)
    expect(isAuthorityNarrowing(tenant, { kind: "platform", platformKey: "p" })).toBe(false)
  })
})

describe("A1 canonical principal and authority", () => {
  it("uses an explicit anonymous principal and rejects inconsistent authentication", () => {
    expect(createAnonymousPrincipal()).toEqual({ id: "anonymous", kind: "anonymous", authentication: { kind: "anonymous" } })
    expect(() => assertPrincipal({ id: "x", kind: "human", authentication: { kind: "anonymous" } })).toThrow(/authenticated/)
    expect(() => assertPrincipal({ id: "x", kind: "anonymous", authentication: { kind: "authenticated", method: "none", authenticatedAt: instant } })).toThrow(/anonymous authentication/)
    expect(() => assertPrincipal({ id: "x", kind: "operator", authentication: { kind: "authenticated", method: "session", authenticatedAt: instant } } as never)).toThrow(/kind is invalid/)
    expect(() => assertPrincipal({ id: "x", kind: "human", authentication: null } as never)).toThrow(/authentication is invalid/)
  })

  it("accepts actor equals subject without impersonation", () => {
    const value = provenance()
    expect(() => assertAuthorityProvenance(value, value.grant.target.scope, value.grant.target.scopeId, now)).not.toThrow()
  })

  it("requires exact impersonation evidence when actor differs from subject", () => {
    const actor = human("operator")
    const subject = human("customer")
    const missing = provenance({}, actor, subject)
    expect(() => assertAuthorityProvenance(missing, missing.grant.target.scope, missing.grant.target.scopeId, now)).toThrow(/without explicit impersonation/)
    const valid = provenance({ impersonation: { kind: "explicit", actorId: actor.id, subjectId: subject.id, grantId: "grant-1" } }, actor, subject)
    expect(() => assertAuthorityProvenance(valid, valid.grant.target.scope, valid.grant.target.scopeId, now)).not.toThrow()
    const forged = provenance({ impersonation: { kind: "explicit", actorId: "other", subjectId: subject.id, grantId: "grant-1" } }, actor, subject)
    expect(() => assertAuthorityProvenance(forged, forged.grant.target.scope, forged.grant.target.scopeId, now)).toThrow(/does not match/)
  })

  it("rejects a mismatched request target and noncanonical target ID", () => {
    const value = provenance()
    const other = target({ kind: "tenant", tenantId: "tenant-2" })
    expect(() => assertAuthorityProvenance(value, other.scope, other.scopeId, now)).toThrow(/scope identity mismatch/)
    const malformed = provenance({ target: { scope: value.grant.target.scope, scopeId: other.scopeId } })
    expect(() => assertAuthorityProvenance(malformed, malformed.grant.target.scope, malformed.grant.target.scopeId, now)).toThrow(/scope identity mismatch/)
  })

  it("binds route grants to the request route", () => {
    const value = provenance()
    expect(() => assertAuthorityProvenance(value, value.grant.target.scope, value.grant.target.scopeId, now, { routeKey: "admin.delete" })).toThrow(/source route/)
  })

  it("rejects expired delegation hops", () => {
    const platform = target({ kind: "platform", platformKey: "main" })
    const tenant = target({ kind: "tenant", tenantId: "tenant-1" })
    const hop: DelegationHop = { grantId: "hop-expired", issuer: human("support"), source: { kind: "authority", target: platform }, target: tenant, purpose: "read", reason: "old", issuedAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-02T00:00:00.000Z", policy, permittedOperationKeys: ["orders.read"], revocation: { kind: "not-revocable-before-expiry" } }
    const value = provenance({ source: { kind: "authority", target: platform }, delegationChain: [hop] })
    expect(() => assertAuthorityProvenance(value, tenant.scope, tenant.scopeId, now, { routeKey: "orders.read" })).toThrow(/expired/)
  })

  it("checks delegation operation restrictions against the operation, not the route", () => {
    const platform = target({ kind: "platform", platformKey: "main" })
    const tenant = target({ kind: "tenant", tenantId: "tenant-1" })
    const hop: DelegationHop = { grantId: "hop-operation", issuer: human("support"), source: { kind: "authority", target: platform }, target: tenant, purpose: "read", reason: "case", issuedAt: instant, policy, permittedOperationKeys: ["orders.read"], revocation: { kind: "not-revocable-before-expiry" } }
    const value = provenance({ source: hop.source, delegationChain: [hop] })
    expect(() => assertAuthorityProvenance(value, tenant.scope, tenant.scopeId, now, { routeKey: "orders-route", operationKey: "orders.delete" })).toThrow(/does not permit this operation/)
    expect(() => assertAuthorityProvenance(value, tenant.scope, tenant.scopeId, now, { routeKey: "orders-route", operationKey: "orders.read" })).not.toThrow()
  })

  it("enforces delegation action and resource restrictions and rejects incomplete validation context", () => {
    const platform = target({ kind: "platform", platformKey: "main" })
    const tenant = target({ kind: "tenant", tenantId: "tenant-1" })
    const hop: DelegationHop = {
      grantId: "hop-restricted", issuer: human("support"), source: { kind: "authority", target: platform }, target: tenant,
      purpose: "read", reason: "case", issuedAt: instant, policy, permittedOperationKeys: ["orders.read"],
      permittedActions: ["read"], permittedResourceIds: ["row-1"], revocation: { kind: "not-revocable-before-expiry" },
    }
    const value = provenance({ source: hop.source, delegationChain: [hop] })
    expect(() => assertAuthorityProvenance(value, tenant.scope, tenant.scopeId, now, { operationKey: "orders.read" })).toThrow(/action restriction/)
    expect(() => assertAuthorityProvenance(value, tenant.scope, tenant.scopeId, now, { operationKey: "orders.read", action: "delete", resourceIds: ["row-1"] })).toThrow(/does not permit this action/)
    expect(() => assertAuthorityProvenance(value, tenant.scope, tenant.scopeId, now, { operationKey: "orders.read", action: "read", resourceIds: ["row-2"] })).toThrow(/does not permit one or more resources/)
    expect(() => assertAuthorityProvenance(value, tenant.scope, tenant.scopeId, now, { operationKey: "orders.read", action: "read", resourceIds: [] })).toThrow(/does not permit an unspecified resource collection/)
    expect(() => assertAuthorityProvenance(value, tenant.scope, tenant.scopeId, now, { operationKey: "orders.read", action: "read", resourceIds: ["row-1"] })).not.toThrow()
  })

  it("rejects nonexistent calendar dates in authority timestamps", () => {
    expect(isRfc3339UtcInstant("2026-02-31T00:00:00.000Z")).toBe(false)
    expect(isRfc3339UtcInstant("2026-02-28T00:00:00.123456789Z")).toBe(true)
    const value = provenance({ expiresAt: "2026-02-31T00:00:00.000Z" })
    expect(() => assertAuthorityProvenance(value, value.grant.target.scope, value.grant.target.scopeId, now)).toThrow(/expired or has an invalid expiry/)
  })

  it("rejects delegation source mismatch, tenant rebinding and depth above one", () => {
    const platform = target({ kind: "platform", platformKey: "main" })
    const tenant = target({ kind: "tenant", tenantId: "tenant-1" })
    const hop: DelegationHop = { grantId: "hop-1", issuer: human("support"), source: { kind: "authority", target: platform }, target: tenant, purpose: "support", reason: "case-1", issuedAt: instant, policy, revocation: { kind: "not-revocable-before-expiry" } }
    const sourceMismatch = provenance({ source: { kind: "route", routeKey: "wrong" }, delegationChain: [hop] })
    expect(() => assertAuthorityProvenance(sourceMismatch, tenant.scope, tenant.scopeId, now)).toThrow(/first delegation source/)
    const tenantRebind: DelegationHop = { ...hop, source: { kind: "authority", target: target({ kind: "tenant", tenantId: "tenant-2" }) } }
    const rebound = provenance({ source: tenantRebind.source, delegationChain: [tenantRebind] })
    expect(() => assertAuthorityProvenance(rebound, tenant.scope, tenant.scopeId, now)).toThrow(/cannot widen or rebind/)
    const nested = provenance({ source: hop.source, delegationChain: [hop, { ...hop, grantId: "hop-2" }] })
    expect(() => assertAuthorityProvenance(nested, tenant.scope, tenant.scopeId, now)).toThrow(/maximum delegation depth/)
  })

  it("rejects impersonation nested under tenant authority", () => {
    const actor = human("operator")
    const subject = human("customer")
    const tenant = target({ kind: "tenant", tenantId: "tenant-1" })
    const source = { kind: "authority", target: tenant } as const
    const hop: DelegationHop = { grantId: "hop-1", issuer: actor, source, target: tenant, purpose: "support", reason: "case-1", issuedAt: instant, policy, revocation: { kind: "not-revocable-before-expiry" } }
    const value = provenance({ source, delegationChain: [hop], impersonation: { kind: "explicit", actorId: actor.id, subjectId: subject.id, grantId: "grant-1" } }, actor, subject)
    expect(() => assertAuthorityProvenance(value, tenant.scope, tenant.scopeId, now)).toThrow(/nested impersonation/)
  })

  it("deep-freezes authority provenance", () => {
    const value = freezeAuthorityProvenance(provenance())
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.grant)).toBe(true)
    expect(Object.isFrozen(value.grant.target.scope)).toBe(true)
  })
})

describe("A1 canonical request context", () => {
  function context(): RequestContext {
    const authority = provenance()
    return { requestId: "request-1", correlationId: authority.correlationId, identity: authority.identity, scope: authority.grant.target.scope, scopeId: authority.grant.target.scopeId, authority, route: { routeKey: "orders.read", definitionVersion: 1, operationKey: "orders.read" }, signal: new AbortController().signal, deadline: "2026-09-11T00:00:00.000Z", metadata: { display: true } }
  }

  it("validates all canonical links and freezes the normalized context", () => {
    const value = context()
    expect(() => assertRequestContext(value, now)).not.toThrow()
    expect(Object.isFrozen(freezeRequestContext(value, now))).toBe(true)
    expect(Object.isFrozen(value.metadata)).toBe(true)
  })

  it("snapshots authority before asynchronous revocation verification", async () => {
    const value = context()
    const hop: DelegationHop = { ...value.authority.grant, issuer: human("u1"), permittedOperationKeys: ["orders.read"], revocation: { kind: "authoritative-store", verifierKey: "store", grantVersion: "1" } }
    const input = { ...value, authority: { ...value.authority, grant: { ...value.authority.grant, delegationChain: [hop] } } }
    let release!: (value: boolean) => void
    const pending = freezeVerifiedRequestContext(input, () => new Promise<boolean>(resolve => { release = resolve }), now)
    input.route = { ...input.route, operationKey: "orders.delete" }
    input.authority.grant.delegationChain = []
    release(true)
    const result = await pending
    expect(result.route.operationKey).toBe("orders.read")
    expect(result.authority.grant.delegationChain).toHaveLength(1)
    expect(result.signal).toBe(value.signal)
    expect(Object.isFrozen(result.authority.grant.delegationChain[0])).toBe(true)
  })

  it("requires and snapshots delegation targets for restricted delegations", async () => {
    const value = context()
    const hop: DelegationHop = {
      ...value.authority.grant, issuer: human("u1"), permittedActions: ["read"], permittedResourceIds: ["row-1"],
      revocation: { kind: "authoritative-store", verifierKey: "store", grantVersion: "1" },
    }
    const resourceIds = ["row-1"]
    const input = {
      ...value,
      delegationTarget: { action: "read", resourceIds },
      authority: { ...value.authority, grant: { ...value.authority.grant, delegationChain: [hop] } },
    }
    const result = await freezeVerifiedRequestContext(input, async () => true, now)
    resourceIds[0] = "row-2"
    expect(result.delegationTarget?.resourceIds).toEqual(["row-1"])
    expect(Object.isFrozen(result.delegationTarget?.resourceIds)).toBe(true)
  })

  it("rejects unknown revocation modes before synchronous admission", () => {
    const value = context()
    const hop = { ...value.authority.grant, issuer: human("u1"), revocation: { kind: "unknown" } } as unknown as DelegationHop
    expect(() => freezeRequestContext({ ...value, authority: { ...value.authority, grant: { ...value.authority.grant, delegationChain: [hop] } } }, now)).toThrow(/revocation mode/)
  })

  it("rejects accessor-backed authority snapshots without calling the getter", async () => {
    const value = context()
    let reads = 0
    Object.defineProperty(value.route, "operationKey", { enumerable: true, get() { reads++; return "orders.read" } })
    await expect(freezeVerifiedRequestContext(value, undefined, now)).rejects.toThrow(/accessors/)
    expect(reads).toBe(0)
  })

  it("requires an explicit true revocation result", async () => {
    const value = context()
    const hop: DelegationHop = { ...value.authority.grant, issuer: human("u1"), revocation: { kind: "authoritative-store", verifierKey: "store", grantVersion: "1" } }
    await expect(freezeVerifiedRequestContext({ ...value, authority: { ...value.authority, grant: { ...value.authority.grant, delegationChain: [hop] } } }, async () => "false" as unknown as boolean, now)).rejects.toThrow(/revoked/)
  })

  it("rejects non-UTC deadlines and identity/correlation mismatches", () => {
    expect(() => assertRequestContext({ ...context(), deadline: "2026-09-11T05:30:00+05:30" }, now)).toThrow(/RFC 3339 UTC/)
    expect(() => assertRequestContext({ ...context(), correlationId: "other" }, now)).toThrow(/correlationId mismatch/)
    expect(() => assertRequestContext({ ...context(), identity: { actor: human("other"), subject: human("other") } }, now)).toThrow(/identity mismatch/)
  })
})
