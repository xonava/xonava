import { describe, expect, it } from "vitest"
import {
  assertAuthorityProvenance,
  assertDurableAuthorityProvenance,
  freezeAuthorityProvenance,
  MAX_AUTHORITY_CLOCK_SKEW_MS,
  type AuthorityGrant,
  type AuthorityProvenance,
  type AuthorityValidationOptions,
  type DelegationHop,
  type DurableAuthorityProvenanceV1,
  type PolicyEvidence,
  type ScopedAuthorityTarget,
} from "../authority"
import { ConfigurationError, ForbiddenError, UnauthorizedError } from "../errors"
import { encodeExecutionScopeId, type ExecutionScope } from "../executionScope"
import type { Principal } from "../principal"

const instant = "2026-09-10T00:00:00.000Z"
const nowMs = Date.parse("2026-09-10T01:00:00.000Z")
const now = new Date(nowMs)
const human = (id: string, kind: Principal["kind"] = "human"): Principal => ({ id, kind, authentication: { kind: "authenticated", method: "session", authenticatedAt: instant } })
const policy: PolicyEvidence = { policyKey: "support", policyVersion: 1, policyDigest: "sha256:abc", evaluatedAt: instant, authorizationModel: "snapshot" }
const target = (scope: ExecutionScope): ScopedAuthorityTarget => ({ scope, scopeId: encodeExecutionScopeId(scope) })
const tenant1 = target({ kind: "tenant", tenantId: "tenant-1" })
const tenant2 = target({ kind: "tenant", tenantId: "tenant-2" })
const platform = target({ kind: "platform", platformKey: "main" })
const platform2 = target({ kind: "platform", platformKey: "other" })
const withIso = (offsetMs: number): string => new Date(nowMs + offsetMs).toISOString()

type Loose<T> = { [K in keyof T]?: T[K] | undefined }

function hopOf(overrides: Loose<DelegationHop> = {}): DelegationHop {
  return {
    grantId: "hop-1", issuer: human("support"), source: { kind: "authority", target: platform }, target: tenant1,
    purpose: "support", reason: "case", issuedAt: instant, policy, revocation: { kind: "not-revocable-before-expiry" }, ...overrides,
  } as DelegationHop
}

function provenanceOf(overrides: Loose<AuthorityGrant> = {}, actor: Principal = human("u1"), subject: Principal = actor): AuthorityProvenance {
  return {
    identity: { actor, subject },
    correlationId: "correlation-1",
    grant: {
      grantId: "grant-1", source: { kind: "route", routeKey: "orders.read" }, target: tenant1, purpose: "read", reason: "request",
      issuedAt: instant, expiresAt: "2026-09-11T00:00:00.000Z", policy, delegationChain: [], impersonation: { kind: "none" }, ...overrides,
    } as AuthorityGrant,
  }
}

function delegated(hop: DelegationHop, extra: Loose<AuthorityGrant> = {}): AuthorityProvenance {
  return provenanceOf({ source: hop.source, delegationChain: [hop], ...extra })
}

function catchError(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the call to throw")
}

function live(value: AuthorityProvenance, options?: AuthorityValidationOptions, at: Date = now): () => void {
  return () => assertAuthorityProvenance(value, tenant1.scope, tenant1.scopeId, at, options)
}

function expectFailure(run: () => unknown, type: new (...args: never[]) => Error, message: string): void {
  const error = catchError(run)
  expect(error).toBeInstanceOf(type)
  expect(error.message).toBe(message)
}

function durableOf(overrides: Loose<DurableAuthorityProvenanceV1> = {}): DurableAuthorityProvenanceV1 {
  return {
    format: "framework.authority-provenance", formatVersion: 1, actor: human("u1"), subject: human("u1"),
    source: { kind: "route", routeKey: "orders.read" }, target: tenant1, grantId: "grant-1", purpose: "read", reason: "request",
    delegationChain: [], policy, issuedAt: instant, expiresAt: "2026-09-11T00:00:00.000Z", correlationId: "correlation-1", ...overrides,
  } as DurableAuthorityProvenanceV1
}
const durable = (value: DurableAuthorityProvenanceV1) => (): void => assertDurableAuthorityProvenance(value)

describe("live authority: required text fields and identity", () => {
  it("names the exact blank field", () => {
    expectFailure(live({ ...provenanceOf(), correlationId: " " }), ConfigurationError, "authority.correlationId must be non-empty")
    expectFailure(live(provenanceOf({ grantId: "" })), ConfigurationError, "grant.grantId must be non-empty")
    expectFailure(live(provenanceOf({ purpose: " " })), ConfigurationError, "grant.purpose must be non-empty")
    expectFailure(live(provenanceOf({ reason: "\t" })), ConfigurationError, "grant.reason must be non-empty")
  })

  it("validates the actor and the subject principals", () => {
    const bad = { id: " ", kind: "human", authentication: { kind: "anonymous" } } as never
    expectFailure(live(provenanceOf({}, bad, human("u1"))), ConfigurationError, "principal.id must be non-empty")
    const inconsistent = provenanceOf()
    expectFailure(live({ ...inconsistent, identity: { actor: human("u1"), subject: bad } }), ConfigurationError, "principal.id must be non-empty")
  })

  it("rejects an invalid validation time", () => {
    expectFailure(live(provenanceOf(), undefined, new Date(Number.NaN)), ConfigurationError, "authority validation time is invalid")
  })

  it("treats same id with different kind as different principals", () => {
    const value = provenanceOf({}, human("u1", "human"), human("u1", "service"))
    expectFailure(live(value), ForbiddenError, "actor and subject differ without explicit impersonation")
  })
})

describe("live authority: targets and origins", () => {
  it("names the failing target", () => {
    const broken: ScopedAuthorityTarget = { scope: tenant1.scope, scopeId: tenant2.scopeId }
    expectFailure(live(provenanceOf({ target: broken })), ConfigurationError, "grant.target scope identity mismatch")
    expectFailure(live(provenanceOf({ source: { kind: "authority", target: broken } })), ConfigurationError, "grant.source.target scope identity mismatch")
    expectFailure(live(delegated(hopOf({ target: broken }))), ConfigurationError, "delegation.target scope identity mismatch")
    expectFailure(
      live(provenanceOf({ source: { kind: "route", routeKey: "r" }, delegationChain: [hopOf({ source: { kind: "route", routeKey: "r" }, target: broken })] })),
      ConfigurationError, "delegation.target scope identity mismatch",
    )
  })

  it("rejects a request whose scope id is not canonical", () => {
    expectFailure(() => assertAuthorityProvenance(provenanceOf(), tenant1.scope, tenant2.scopeId, now), ConfigurationError, "request scope identity mismatch")
  })

  it("rejects a request target that differs from the grant target", () => {
    expectFailure(() => assertAuthorityProvenance(provenanceOf(), tenant2.scope, tenant2.scopeId, now), ForbiddenError, "request and authority target scope identity mismatch")
  })

  it("validates bootstrap and route origin keys", () => {
    expectFailure(live(provenanceOf({ source: { kind: "bootstrap", bootstrapKey: " " } })), ConfigurationError, "grant.source.bootstrapKey must be non-empty")
    expectFailure(live(provenanceOf({ source: { kind: "route", routeKey: " " } })), ConfigurationError, "grant.source.routeKey must be non-empty")
    expect(live(provenanceOf({ source: { kind: "bootstrap", bootstrapKey: "boot" } }))).not.toThrow()
    const hop = hopOf({ source: { kind: "bootstrap", bootstrapKey: " " } })
    expectFailure(live(provenanceOf({ source: hop.source, delegationChain: [hop] })), ConfigurationError, "grant.source.bootstrapKey must be non-empty")
    const hopRoute = hopOf({ source: { kind: "route", routeKey: " " } })
    expectFailure(live(provenanceOf({ source: { kind: "route", routeKey: "ok" }, delegationChain: [hopRoute] })), ForbiddenError, "first delegation source does not match grant source")
    expectFailure(live(provenanceOf({ source: hopRoute.source, delegationChain: [hopRoute] })), ConfigurationError, "grant.source.routeKey must be non-empty")
  })

  it("names the delegation source field", () => {
    const sourceBroken: ScopedAuthorityTarget = { scope: platform.scope, scopeId: tenant2.scopeId }
    const hop = hopOf({ source: { kind: "authority", target: sourceBroken } })
    // The grant source is checked first with the grant prefix.
    expectFailure(live(delegated(hop)), ConfigurationError, "grant.source.target scope identity mismatch")
  })

  it("compares delegation sources to the grant source by kind and value", () => {
    const sameBootstrap = hopOf({ source: { kind: "bootstrap", bootstrapKey: "b1" } })
    expect(live(delegated(sameBootstrap))).not.toThrow()
    const otherBootstrap = hopOf({ source: { kind: "bootstrap", bootstrapKey: "b2" } })
    expectFailure(live(provenanceOf({ source: { kind: "bootstrap", bootstrapKey: "b1" }, delegationChain: [otherBootstrap] })), ForbiddenError, "first delegation source does not match grant source")

    const sameRoute = hopOf({ source: { kind: "route", routeKey: "r1" } })
    expect(live(delegated(sameRoute))).not.toThrow()
    const otherRoute = hopOf({ source: { kind: "route", routeKey: "r2" } })
    expectFailure(live(provenanceOf({ source: { kind: "route", routeKey: "r1" }, delegationChain: [otherRoute] })), ForbiddenError, "first delegation source does not match grant source")

    const sameAuthority = hopOf()
    expect(live(delegated(sameAuthority))).not.toThrow()
    const otherAuthority = hopOf({ source: { kind: "authority", target: platform2 } })
    expectFailure(live(provenanceOf({ source: { kind: "authority", target: platform }, delegationChain: [otherAuthority] })), ForbiddenError, "first delegation source does not match grant source")

    const kindMismatch = hopOf({ source: { kind: "route", routeKey: "r1" } })
    expectFailure(live(provenanceOf({ source: { kind: "bootstrap", bootstrapKey: "r1" }, delegationChain: [kindMismatch] })), ForbiddenError, "first delegation source does not match grant source")
    expectFailure(live(provenanceOf({ source: { kind: "authority", target: platform }, delegationChain: [kindMismatch] })), ForbiddenError, "first delegation source does not match grant source")
    const authorityHop = hopOf()
    expectFailure(live(provenanceOf({ source: { kind: "route", routeKey: "r1" }, delegationChain: [authorityHop] })), ForbiddenError, "first delegation source does not match grant source")
  })

  it("names the delegation fields that are blank or invalid", () => {
    expectFailure(live(delegated(hopOf({ grantId: " " }))), ConfigurationError, "delegation.grantId must be non-empty")
    expectFailure(live(delegated(hopOf({ purpose: " " }))), ConfigurationError, "delegation.purpose must be non-empty")
    expectFailure(live(delegated(hopOf({ reason: " " }))), ConfigurationError, "delegation.reason must be non-empty")
    expectFailure(live(delegated(hopOf({ issuer: { id: "", kind: "human", authentication: { kind: "anonymous" } } as never }))), ConfigurationError, "principal.id must be non-empty")
    expectFailure(live(delegated(hopOf({ policy: { ...policy, policyKey: " " } }))), ConfigurationError, "policy.policyKey must be non-empty")
  })

  it("rejects the hop target that is not the grant target", () => {
    const hop = hopOf({ source: { kind: "route", routeKey: "orders.read" }, target: tenant2 })
    expectFailure(live(delegated(hop)), ForbiddenError, "delegation chain target does not match grant target")
  })

  it("rejects a delegation that widens authority", () => {
    const hop = hopOf({ source: { kind: "authority", target: tenant2 }, target: tenant1 })
    expectFailure(live(delegated(hop)), ForbiddenError, "delegation cannot widen or rebind authority")
    const sameScope = hopOf({ source: { kind: "authority", target: tenant1 }, target: tenant1 })
    expect(live(delegated(sameScope))).not.toThrow()
    const system = target({ kind: "system", systemKey: "scheduler" })
    expect(live(delegated(hopOf({ source: { kind: "authority", target: system } }))).bind(null)).not.toThrow()
    const widening = hopOf({ source: { kind: "authority", target: tenant1 }, target: platform })
    expectFailure(live(provenanceOf({ source: widening.source, target: platform, delegationChain: [widening] }), undefined), ForbiddenError, "request and authority target scope identity mismatch")
  })
})

describe("live authority: policy evidence", () => {
  const withPolicy = (overrides: Partial<PolicyEvidence>) => live(provenanceOf({ policy: { ...policy, ...overrides } }))

  it("names the failing policy field", () => {
    expectFailure(withPolicy({ policyKey: " " }), ConfigurationError, "policy.policyKey must be non-empty")
    expectFailure(withPolicy({ policyDigest: " " }), ConfigurationError, "policy.policyDigest must be non-empty")
    expectFailure(withPolicy({ policyVersion: 0 }), ConfigurationError, "policy.policyVersion must be a positive safe integer")
    expectFailure(withPolicy({ policyVersion: 1.5 }), ConfigurationError, "policy.policyVersion must be a positive safe integer")
    expectFailure(withPolicy({ policyVersion: -3 }), ConfigurationError, "policy.policyVersion must be a positive safe integer")
    expectFailure(withPolicy({ policyVersion: Number.MAX_SAFE_INTEGER + 1 }), ConfigurationError, "policy.policyVersion must be a positive safe integer")
    expectFailure(withPolicy({ evaluatedAt: "yesterday" }), ConfigurationError, "policy.evaluatedAt must be an RFC 3339 UTC instant")
    expect(withPolicy({ policyVersion: 1 })).not.toThrow()
    expect(withPolicy({ policyVersion: Number.MAX_SAFE_INTEGER })).not.toThrow()
  })
})

describe("live authority: validity window", () => {
  it("bounds clock skew inclusively", () => {
    const value = provenanceOf()
    expect(live(value, { clockSkewToleranceMs: 0 })).not.toThrow()
    expect(live(value, { clockSkewToleranceMs: MAX_AUTHORITY_CLOCK_SKEW_MS })).not.toThrow()
    const message = `clockSkewToleranceMs must be an integer between 0 and ${MAX_AUTHORITY_CLOCK_SKEW_MS}`
    expectFailure(live(value, { clockSkewToleranceMs: MAX_AUTHORITY_CLOCK_SKEW_MS + 1 }), ConfigurationError, message)
    expectFailure(live(value, { clockSkewToleranceMs: -1 }), ConfigurationError, message)
    expectFailure(live(value, { clockSkewToleranceMs: 1.5 }), ConfigurationError, message)
    expectFailure(live(value, { clockSkewToleranceMs: Number.NaN }), ConfigurationError, message)
    expect(message).toBe("clockSkewToleranceMs must be an integer between 0 and 300000")
  })

  it("accepts issuedAt exactly at now plus skew and rejects one millisecond later", () => {
    const options = { clockSkewToleranceMs: 1000 }
    expect(live(provenanceOf({ issuedAt: withIso(1000) }), options)).not.toThrow()
    expectFailure(live(provenanceOf({ issuedAt: withIso(1001) }), options), UnauthorizedError, "grant.issuedAt is in the future")
    expect(live(provenanceOf({ issuedAt: withIso(30_000), expiresAt: withIso(60_000) }))).not.toThrow()
    expectFailure(live(provenanceOf({ issuedAt: withIso(30_001), expiresAt: withIso(60_000) })), UnauthorizedError, "grant.issuedAt is in the future")
  })

  it("rejects a malformed issuedAt with the field name", () => {
    expectFailure(live(provenanceOf({ issuedAt: "not-a-date" })), ConfigurationError, "grant.issuedAt must be an RFC 3339 UTC instant")
    expectFailure(live(delegated(hopOf({ issuedAt: "not-a-date" }))), ConfigurationError, "delegation.issuedAt must be an RFC 3339 UTC instant")
  })

  it("treats expiry at exactly now as expired and one millisecond later as valid", () => {
    expectFailure(live(provenanceOf({ expiresAt: withIso(0) })), UnauthorizedError, "authority grant has expired")
    expect(live(provenanceOf({ expiresAt: withIso(1) }))).not.toThrow()
    expect(live(provenanceOf({ expiresAt: undefined }))).not.toThrow()
  })

  it("distinguishes delegation expiry and delegation validity messages", () => {
    expectFailure(live(delegated(hopOf({ issuedAt: "2026-09-09T00:00:00.000Z", expiresAt: withIso(0) }))), UnauthorizedError, "delegation has expired")
    expectFailure(live(delegated(hopOf({ issuedAt: withIso(31_000), expiresAt: withIso(60_000) }))), UnauthorizedError, "delegation.issuedAt is in the future")
    expectFailure(live(delegated(hopOf({ expiresAt: instant }))), ConfigurationError, "delegation has an invalid expiry")
    expectFailure(live(provenanceOf({ expiresAt: "bad" })), ConfigurationError, "grant has an invalid expiry")
  })

  it("caps a delegation expiry at the grant expiry, inclusive", () => {
    const grantExpiry = "2026-09-11T00:00:00.000Z"
    expect(live(delegated(hopOf({ expiresAt: grantExpiry }), { expiresAt: grantExpiry }))).not.toThrow()
    expectFailure(live(delegated(hopOf({ expiresAt: "2026-09-11T00:00:00.001Z" }), { expiresAt: grantExpiry })), ForbiddenError, "delegation expiry cannot exceed grant expiry")
    expect(live(delegated(hopOf({ expiresAt: "2030-01-01T00:00:00.000Z" }), { expiresAt: undefined }))).not.toThrow()
    expect(live(delegated(hopOf({ expiresAt: undefined }), { expiresAt: grantExpiry }))).not.toThrow()
  })
})

describe("live authority: delegation revocation and restrictions", () => {
  it("validates the authoritative-store revocation fields", () => {
    const base = { kind: "authoritative-store", verifierKey: "store", grantVersion: "1" } as const
    expect(live(delegated(hopOf({ revocation: base })))).not.toThrow()
    expectFailure(live(delegated(hopOf({ revocation: { ...base, verifierKey: " " } }))), ConfigurationError, "delegation.revocation.verifierKey must be non-empty")
    expectFailure(live(delegated(hopOf({ revocation: { ...base, grantVersion: " " } }))), ConfigurationError, "delegation.revocation.grantVersion must be non-empty")
    expectFailure(live(delegated(hopOf({ revocation: { kind: "other" } as never }))), ConfigurationError, "delegation revocation mode is invalid")
    expectFailure(live(delegated(hopOf({ revocation: undefined as never }))), ConfigurationError, "delegation revocation mode is invalid")
  })

  it("rejects malformed restriction lists naming the field", () => {
    const names = ["permittedOperationKeys", "permittedActions", "permittedResourceIds"] as const
    for (const name of names) {
      const message = `delegation.${name} must contain only non-empty strings`
      expectFailure(live(delegated(hopOf({ [name]: "orders.read" } as never))), ConfigurationError, message)
      expectFailure(live(delegated(hopOf({ [name]: ["ok", " "] } as never))), ConfigurationError, message)
      expectFailure(live(delegated(hopOf({ [name]: [""] } as never))), ConfigurationError, message)
      expectFailure(live(delegated(hopOf({ [name]: [5] } as never))), ConfigurationError, message)
      expectFailure(live(delegated(hopOf({ [name]: ["ok", 5] } as never))), ConfigurationError, message)
    }
  })

  it("requires validation context for each restriction, even without options", () => {
    expectFailure(live(delegated(hopOf({ permittedOperationKeys: ["a"] }))), ConfigurationError, "delegation operation restriction requires an operation key")
    expectFailure(live(delegated(hopOf({ permittedActions: ["a"] }))), ConfigurationError, "delegation action restriction requires an action")
    expectFailure(live(delegated(hopOf({ permittedResourceIds: ["a"] }))), ConfigurationError, "delegation resource restriction requires resource identities")
    expectFailure(live(delegated(hopOf({ permittedActions: ["a"] })), {}), ConfigurationError, "delegation action restriction requires an action")
    expectFailure(live(delegated(hopOf({ permittedResourceIds: ["a"] })), {}), ConfigurationError, "delegation resource restriction requires resource identities")
  })

  it("checks every requested resource against the permitted list", () => {
    const hop = hopOf({ permittedResourceIds: ["row-1", "row-2"] })
    const run = (resourceIds: readonly string[]) => live(delegated(hop), { resourceIds })
    expect(run(["row-1", "row-2"])).not.toThrow()
    expectFailure(run(["row-1", "row-3"]), ForbiddenError, "delegation does not permit one or more resources")
    expectFailure(run(["row-3", "row-1"]), ForbiddenError, "delegation does not permit one or more resources")
    expectFailure(run([5 as never]), ForbiddenError, "delegation does not permit one or more resources")
    expectFailure(run([]), ForbiddenError, "delegation resource restriction does not permit an unspecified resource collection")
  })

  it("matches operation and action membership exactly", () => {
    const hop = hopOf({ permittedOperationKeys: ["orders.read"], permittedActions: ["read"] })
    expectFailure(live(delegated(hop), { operationKey: "orders.read", action: "write" }), ForbiddenError, "delegation does not permit this action")
    expectFailure(live(delegated(hop), { operationKey: "orders.write", action: "read" }), ForbiddenError, "delegation does not permit this operation")
    expect(live(delegated(hop), { operationKey: "orders.read", action: "read" })).not.toThrow()
  })
})

describe("live authority: impersonation", () => {
  const actor = human("operator")
  const subject = human("customer")
  const explicit = { kind: "explicit", actorId: "operator", subjectId: "customer", grantId: "grant-1" } as const

  it("rejects impersonation evidence on an ordinary identity", () => {
    expectFailure(live(provenanceOf({ impersonation: explicit })), ForbiddenError, "ordinary identity cannot contain impersonation evidence")
  })

  it("requires every evidence field to match", () => {
    const message = "impersonation evidence does not match identity and grant"
    expect(live(provenanceOf({ impersonation: explicit }, actor, subject))).not.toThrow()
    expectFailure(live(provenanceOf({ impersonation: { ...explicit, actorId: "x" } }, actor, subject)), ForbiddenError, message)
    expectFailure(live(provenanceOf({ impersonation: { ...explicit, subjectId: "x" } }, actor, subject)), ForbiddenError, message)
    expectFailure(live(provenanceOf({ impersonation: { ...explicit, grantId: "x" } }, actor, subject)), ForbiddenError, message)
    expectFailure(live(provenanceOf({ impersonation: { kind: "none" } }, actor, subject)), ForbiddenError, "actor and subject differ without explicit impersonation")
  })

  it("forbids nested impersonation only under tenant authority", () => {
    const tenantHop = hopOf({ source: { kind: "authority", target: tenant1 }, target: tenant1 })
    const platformHop = hopOf()
    const routeHop = hopOf({ source: { kind: "route", routeKey: "orders.read" } })
    const routeValue = provenanceOf({ delegationChain: [routeHop], impersonation: explicit }, actor, subject)
    expect(live(routeValue)).not.toThrow()
    const platformValue = provenanceOf({ source: platformHop.source, delegationChain: [platformHop], impersonation: explicit }, actor, subject)
    expect(live(platformValue)).not.toThrow()
    const tenantValue = provenanceOf({ source: tenantHop.source, delegationChain: [tenantHop], impersonation: explicit }, actor, subject)
    expectFailure(live(tenantValue), ForbiddenError, "nested impersonation is forbidden")
  })
})

describe("live authority: delegation depth", () => {
  it("allows exactly one hop and rejects two", () => {
    expect(live(delegated(hopOf()))).not.toThrow()
    expectFailure(live(delegated(hopOf(), { delegationChain: [hopOf(), hopOf({ grantId: "hop-2" })] })), ForbiddenError, "maximum delegation depth is one")
  })
})

describe("deepFreeze", () => {
  it("terminates on cyclic graphs and freezes shared children once", () => {
    const value = provenanceOf()
    const cyclic = value as unknown as { self?: unknown; grant: { back?: unknown } }
    cyclic.self = cyclic
    cyclic.grant.back = cyclic
    const frozen = freezeAuthorityProvenance(value)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.grant)).toBe(true)
  })

  it("returns primitives and null-valued fields untouched", () => {
    const value = provenanceOf({ expiresAt: undefined })
    const frozen = freezeAuthorityProvenance(value)
    expect(frozen.grant.expiresAt).toBeUndefined()
    expect(frozen.correlationId).toBe("correlation-1")
    expect(Object.isFrozen(frozen.identity.actor.authentication)).toBe(true)
  })
})

describe("durable authority provenance", () => {
  it("accepts a well formed record, with and without expiry", () => {
    expect(durable(durableOf())).not.toThrow()
    expect(durable(durableOf({ expiresAt: undefined }))).not.toThrow()
  })

  it("rejects a foreign format or version", () => {
    const message = "durable authority provenance format is invalid"
    expectFailure(durable(durableOf({ format: "other" as never })), ConfigurationError, message)
    expectFailure(durable(durableOf({ formatVersion: 2 as never })), ConfigurationError, message)
    expectFailure(durable(durableOf({ format: "other" as never, formatVersion: 2 as never })), ConfigurationError, message)
  })

  it("validates principals and names blank fields", () => {
    const bad = { id: " ", kind: "human", authentication: { kind: "anonymous" } } as never
    expectFailure(durable(durableOf({ actor: bad })), ConfigurationError, "principal.id must be non-empty")
    expectFailure(durable(durableOf({ subject: bad })), ConfigurationError, "principal.id must be non-empty")
    expectFailure(durable(durableOf({ grantId: " " })), ConfigurationError, "durable authority grantId must be non-empty")
    expectFailure(durable(durableOf({ purpose: " " })), ConfigurationError, "durable authority purpose must be non-empty")
    expectFailure(durable(durableOf({ reason: " " })), ConfigurationError, "durable authority reason must be non-empty")
    expectFailure(durable(durableOf({ correlationId: " " })), ConfigurationError, "durable authority correlationId must be non-empty")
  })

  it("validates instants and their order", () => {
    expectFailure(durable(durableOf({ issuedAt: "nope" })), ConfigurationError, "durable authority issuedAt must be an RFC 3339 UTC instant")
    expectFailure(durable(durableOf({ expiresAt: "nope" })), ConfigurationError, "durable authority expiresAt must be an RFC 3339 UTC instant")
    expectFailure(durable(durableOf({ expiresAt: instant })), ConfigurationError, "durable authority expiresAt must be after issuedAt")
    expectFailure(durable(durableOf({ expiresAt: "2026-09-09T00:00:00.000Z" })), ConfigurationError, "durable authority expiresAt must be after issuedAt")
    expect(durable(durableOf({ expiresAt: "2026-09-10T00:00:00.001Z" }))).not.toThrow()
  })

  it("names the failing target, source and policy", () => {
    const broken: ScopedAuthorityTarget = { scope: tenant1.scope, scopeId: tenant2.scopeId }
    expectFailure(durable(durableOf({ target: broken })), ConfigurationError, "durable authority target scope identity mismatch")
    expectFailure(durable(durableOf({ source: { kind: "bootstrap", bootstrapKey: " " } })), ConfigurationError, "durable authority source.bootstrapKey must be non-empty")
    expectFailure(durable(durableOf({ policy: { ...policy, policyDigest: " " } })), ConfigurationError, "policy.policyDigest must be non-empty")
  })

  it("limits the chain to one hop that starts at the record source", () => {
    expect(durable(durableOf({ source: hopOf().source, delegationChain: [hopOf()] }))).not.toThrow()
    expectFailure(durable(durableOf({ source: hopOf().source, delegationChain: [hopOf(), hopOf()] })), ConfigurationError, "maximum delegation depth is one")
    expectFailure(durable(durableOf({ delegationChain: [hopOf()] })), ConfigurationError, "first delegation source does not match durable authority source")
    expectFailure(durable(durableOf({ delegationChain: [hopOf()], source: { kind: "authority", target: platform2 } })), ConfigurationError, "first delegation source does not match durable authority source")
  })

  it("names each failing hop field", () => {
    const record = (overrides: Loose<DelegationHop>) => durableOf({ source: hopOf(overrides).source, delegationChain: [hopOf(overrides)] })
    expectFailure(durable(record({ grantId: " " })), ConfigurationError, "delegation.grantId must be non-empty")
    expectFailure(durable(record({ purpose: " " })), ConfigurationError, "delegation.purpose must be non-empty")
    expectFailure(durable(record({ reason: " " })), ConfigurationError, "delegation.reason must be non-empty")
    expectFailure(durable(record({ issuer: { id: "", kind: "human", authentication: { kind: "anonymous" } } as never })), ConfigurationError, "principal.id must be non-empty")
    expectFailure(durable(record({ target: { scope: tenant1.scope, scopeId: tenant2.scopeId } })), ConfigurationError, "delegation.target scope identity mismatch")
    const routeSource = { kind: "route", routeKey: "r" } as const
    expectFailure(durable(durableOf({ source: routeSource, delegationChain: [hopOf({ source: routeSource, target: tenant2 })] })), ConfigurationError, "delegation chain target does not match durable authority target")
    expect(durable(durableOf({ source: routeSource, delegationChain: [hopOf({ source: routeSource })] }))).not.toThrow()
    expectFailure(durable(record({ source: { kind: "authority", target: platform }, policy: { ...policy, policyKey: " " } })), ConfigurationError, "policy.policyKey must be non-empty")
    expectFailure(durable(record({ source: { kind: "authority", target: tenant2 } })), ConfigurationError, "delegation cannot widen or rebind authority")
    expectFailure(durable(record({ source: { kind: "bootstrap", bootstrapKey: " " } })), ConfigurationError, "durable authority source.bootstrapKey must be non-empty")
  })

  it("validates hop revocation, restrictions and instants", () => {
    const record = (overrides: Loose<DelegationHop>, grant: Loose<DurableAuthorityProvenanceV1> = {}) => durableOf({ source: hopOf(overrides).source, delegationChain: [hopOf(overrides)], ...grant })
    expectFailure(durable(record({ revocation: { kind: "x" } as never })), ConfigurationError, "delegation revocation mode is invalid")
    expectFailure(durable(record({ revocation: { kind: "authoritative-store", verifierKey: " ", grantVersion: "1" } })), ConfigurationError, "delegation.revocation.verifierKey must be non-empty")
    for (const name of ["permittedOperationKeys", "permittedActions", "permittedResourceIds"] as const) {
      expectFailure(durable(record({ [name]: [" "] } as never)), ConfigurationError, `delegation.${name} must contain only non-empty strings`)
      expect(durable(record({ [name]: ["x"] } as never))).not.toThrow()
    }
    expectFailure(durable(record({ issuedAt: "nope" })), ConfigurationError, "delegation.issuedAt must be an RFC 3339 UTC instant")
    expectFailure(durable(record({ expiresAt: "nope" })), ConfigurationError, "delegation.expiresAt must be an RFC 3339 UTC instant")
    expectFailure(durable(record({ expiresAt: instant })), ConfigurationError, "delegation.expiresAt must be after issuedAt")
    expectFailure(durable(record({ expiresAt: "2026-09-09T00:00:00.000Z" })), ConfigurationError, "delegation.expiresAt must be after issuedAt")
    expect(durable(record({ expiresAt: "2026-09-10T00:00:00.001Z" }))).not.toThrow()
    expect(durable(record({}))).not.toThrow()
  })

  it("caps the hop expiry at the record expiry, inclusive", () => {
    const record = (hopExpiry: string | undefined, grantExpiry: string | undefined) => durableOf({ source: hopOf().source, delegationChain: [hopOf({ expiresAt: hopExpiry })], expiresAt: grantExpiry })
    const message = "delegation expiry cannot exceed grant expiry"
    expect(durable(record("2026-09-11T00:00:00.000Z", "2026-09-11T00:00:00.000Z"))).not.toThrow()
    expect(durable(record("2026-09-10T12:00:00.000Z", "2026-09-11T00:00:00.000Z"))).not.toThrow()
    expectFailure(durable(record("2026-09-11T00:00:00.001Z", "2026-09-11T00:00:00.000Z")), ConfigurationError, message)
    expect(durable(record("2030-01-01T00:00:00.000Z", undefined))).not.toThrow()
    expect(durable(record(undefined, "2026-09-11T00:00:00.000Z"))).not.toThrow()
  })
})
