import { describe, expect, it } from "vitest"
import { assertAuthorityProvenance, freezeAuthorityProvenance, MAX_AUTHORITY_CLOCK_SKEW_MS, type AuthorityGrant, type AuthorityProvenance } from "../authority"
import { encodeExecutionScopeId, type ExecutionScope } from "../executionScope"
import { ConfigurationError, ForbiddenError, UnauthorizedError } from "../errors"
import type { Principal } from "../principal"

const issued = "2026-09-10T00:00:00.000Z"
const now = new Date("2026-09-10T01:00:00.000Z")
const human: Principal = { id: "u1", kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: issued } }
const tenant = (tenantId: string) => { const scope: ExecutionScope = { kind: "tenant", tenantId }; return { scope, scopeId: encodeExecutionScopeId(scope) } }

function provenance(overrides: Partial<AuthorityGrant> = {}): AuthorityProvenance {
  return {
    identity: { actor: human, subject: human },
    correlationId: "c1",
    grant: {
      grantId: "g1", source: { kind: "route", routeKey: "orders.read" }, target: tenant("t1"), purpose: "p", reason: "r",
      issuedAt: issued, expiresAt: "2026-09-11T00:00:00.000Z",
      policy: { policyKey: "k", policyVersion: 1, policyDigest: "sha256:abc", evaluatedAt: issued, authorizationModel: "snapshot" },
      delegationChain: [], impersonation: { kind: "none" }, ...overrides,
    },
  }
}
const check = (value: AuthorityProvenance, at = now, options = {}) => () => assertAuthorityProvenance(value, value.grant.target.scope, value.grant.target.scopeId, at, options)

describe("authority error contract", () => {
  it("reports an expired grant as unauthorized, not as a server error", () => {
    expect(check(provenance({ expiresAt: "2026-09-10T00:30:00.000Z" }))).toThrow(UnauthorizedError)
  })

  it("reports a request outside the grant's scope as forbidden", () => {
    const value = provenance()
    const other = tenant("t2")
    expect(() => assertAuthorityProvenance(value, other.scope, other.scopeId, now)).toThrow(ForbiddenError)
  })

  it("reports a route mismatch as forbidden", () => {
    expect(check(provenance(), now, { routeKey: "orders.write" })).toThrow(ForbiddenError)
  })

  it("keeps malformed authority a configuration error", () => {
    expect(check(provenance({ issuedAt: "yesterday" }))).toThrow(ConfigurationError)
  })

  it("rejects an expiry that is not after issuance", () => {
    expect(check(provenance({ expiresAt: issued }))).toThrow(/invalid expiry/)
    expect(check(provenance({ expiresAt: issued }))).toThrow(ConfigurationError)
  })

  it("tolerates bounded clock skew on issuedAt only", () => {
    const issuedSoon = provenance({ issuedAt: "2026-09-10T01:00:20.000Z" })
    expect(check(issuedSoon)).not.toThrow()
    expect(check(issuedSoon, now, { clockSkewToleranceMs: 0 })).toThrow(UnauthorizedError)
    expect(check(provenance({ issuedAt: "2026-09-10T01:05:00.000Z" }))).toThrow(UnauthorizedError)
    expect(check(provenance(), now, { clockSkewToleranceMs: MAX_AUTHORITY_CLOCK_SKEW_MS + 1 })).toThrow(ConfigurationError)
    // Skew never extends expiry.
    expect(check(provenance({ expiresAt: "2026-09-10T00:59:59.000Z" }))).toThrow("authority grant has expired")
  })

  it("freezes nested objects even when the top level is already frozen", () => {
    const value = provenance()
    Object.freeze(value)
    const frozen = freezeAuthorityProvenance(value)
    expect(Object.isFrozen(frozen.grant)).toBe(true)
    expect(Object.isFrozen(frozen.grant.policy)).toBe(true)
  })
})
