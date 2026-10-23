import { describe, expect, it } from "vitest"
import type { AuthorityProvenance } from "../authority"
import { ConfigurationError } from "../errors"
import { encodeExecutionScopeId, type ExecutionScope } from "../executionScope"
import { freezeRequestContext, type RequestContext } from "../requestContext"
import type { Principal } from "../principal"
import { assertRequestContext } from "../requestContext"
import type { PolicyEvidence, ScopedAuthorityTarget } from "../authority"

const instant = "2026-09-10T00:00:00.000Z"
const now = new Date("2026-09-10T01:00:00.000Z")
const human = (id: string): Principal => ({ id, kind: "human", authentication: { kind: "authenticated", method: "session", authenticatedAt: instant } })
const policy: PolicyEvidence = { policyKey: "support", policyVersion: 1, policyDigest: "sha256:abc", evaluatedAt: instant, authorizationModel: "snapshot" }
const tenantScope: ExecutionScope = { kind: "tenant", tenantId: "tenant-1" }
const target: ScopedAuthorityTarget = { scope: tenantScope, scopeId: encodeExecutionScopeId(tenantScope) }

function provenance(): AuthorityProvenance {
  const actor = human("u1")
  return {
    identity: { actor, subject: actor },
    correlationId: "correlation-1",
    grant: {
      grantId: "grant-1",
      source: { kind: "route", routeKey: "orders.read" },
      target,
      purpose: "read-orders",
      reason: "request",
      issuedAt: instant,
      expiresAt: "2026-09-11T00:00:00.000Z",
      policy,
      delegationChain: [],
      impersonation: { kind: "none" },
    },
  }
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  const authority = provenance()
  return {
    requestId: "request-1",
    correlationId: authority.correlationId,
    identity: authority.identity,
    scope: authority.grant.target.scope,
    scopeId: authority.grant.target.scopeId,
    authority,
    route: { routeKey: "orders.read", definitionVersion: 1, operationKey: "orders.read" },
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** A context object with one top-level key removed, typed loosely on purpose for malformed-input tests. */
function without(key: keyof RequestContext): RequestContext {
  const value: Partial<RequestContext> = context()
  delete value[key]
  return value as RequestContext
}

describe("request context base validation", () => {
  it("accepts a consistent context and freezes a snapshot", () => {
    const value = context({ deadline: "2026-09-11T00:00:00.000Z", locale: "en-GB", timezone: "UTC" })
    expect(() => assertRequestContext(value, now)).not.toThrow()
    const frozen = freezeRequestContext(value, now)
    expect(frozen).toMatchObject({ requestId: "request-1", locale: "en-GB", timezone: "UTC", deadline: "2026-09-11T00:00:00.000Z" })
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(frozen).not.toHaveProperty("causationId")
    expect(frozen).not.toHaveProperty("traceContext")
    expect(frozen).not.toHaveProperty("metadata")
  })

  it("rejects an empty or non-string request identifier", () => {
    const expected = new ConfigurationError("requestId must be non-empty")
    expect(() => assertRequestContext(context({ requestId: "   " }), now)).toThrow(expected)
    expect(() => assertRequestContext(context({ requestId: 5 as never }), now)).toThrow(expected)
  })

  it("rejects an empty or non-string correlation identifier", () => {
    const expected = new ConfigurationError("correlationId must be non-empty")
    expect(() => assertRequestContext(context({ correlationId: "" }), now)).toThrow(expected)
    expect(() => assertRequestContext(context({ correlationId: 7 as never }), now)).toThrow(expected)
  })

  it("rejects a correlation identifier that differs from the authority", () => {
    const authority = { ...provenance(), correlationId: "other" }
    expect(() => assertRequestContext(context({ authority }), now)).toThrow(new ConfigurationError("request and authority correlationId mismatch"))
  })

  it("rejects a causation identifier that differs from the authority", () => {
    expect(() => assertRequestContext(context({ causationId: "cause-1" }), now)).toThrow(
      new ConfigurationError("request and authority causationId mismatch"),
    )
  })

  it("rejects an identity that differs from the authority in any actor or subject field", () => {
    const expected = new ConfigurationError("request and authority identity mismatch")
    const base = context()
    const changedActorId = { ...base, identity: { actor: { ...base.identity.actor, id: "other" }, subject: base.identity.subject } }
    const changedActorKind = { ...base, identity: { actor: { ...base.identity.actor, kind: "service" as never }, subject: base.identity.subject } }
    const changedSubjectId = { ...base, identity: { actor: base.identity.actor, subject: { ...base.identity.subject, id: "other" } } }
    const changedSubjectKind = { ...base, identity: { actor: base.identity.actor, subject: { ...base.identity.subject, kind: "service" as never } } }
    for (const value of [changedActorId, changedActorKind, changedSubjectId, changedSubjectKind]) {
      expect(() => assertRequestContext(value, now)).toThrow(expected)
    }
  })

  it("rejects a scope identifier that does not encode the scope", () => {
    expect(() => assertRequestContext(context({ scopeId: "fscope:v1:bogus" as never }), now)).toThrow(
      new ConfigurationError("request scope identity mismatch"),
    )
  })

  it("rejects an invalid route binding reference", () => {
    const expected = new ConfigurationError("route binding reference is invalid")
    const route = { routeKey: "orders.read", definitionVersion: 1, operationKey: "orders.read" }
    expect(() => assertRequestContext(context({ route: { ...route, routeKey: "" } }), now)).toThrow(expected)
    expect(() => assertRequestContext(context({ route: { ...route, routeKey: "  " } }), now)).toThrow(expected)
    expect(() => assertRequestContext(context({ route: { ...route, operationKey: " " } }), now)).toThrow(expected)
    expect(() => assertRequestContext(context({ route: { ...route, definitionVersion: 0 } }), now)).toThrow(expected)
    expect(() => assertRequestContext(context({ route: { ...route, definitionVersion: 1.5 } }), now)).toThrow(expected)
    expect(() => assertRequestContext(context({ route: { ...route, definitionVersion: Number.NaN } }), now)).toThrow(expected)
    expect(() => assertRequestContext(context({ route: { ...route, definitionVersion: 2 } }), now)).not.toThrow()
  })

  it("requires a deadline to be an RFC 3339 UTC instant", () => {
    const expected = new ConfigurationError("deadline must be an RFC 3339 UTC instant")
    expect(() => assertRequestContext(context({ deadline: "2026-09-10" }), now)).toThrow(expected)
    expect(() => assertRequestContext(context({ deadline: 5 as never }), now)).toThrow(expected)
    expect(() => assertRequestContext(context(), now)).not.toThrow()
  })

  it("rejects an empty delegation target action and blank resource identities", () => {
    expect(() => assertRequestContext(context({ delegationTarget: { action: "  " } }), now)).toThrow(
      new ConfigurationError("delegation target action must be non-empty"),
    )
    expect(() => assertRequestContext(context({ delegationTarget: { action: 5 as never } }), now)).toThrow(
      new ConfigurationError("delegation target action must be non-empty"),
    )
    expect(() => assertRequestContext(context({ delegationTarget: { resourceIds: ["ok", " "] } }), now)).toThrow(
      new ConfigurationError("delegation target resource identities must be non-empty strings"),
    )
    expect(() => assertRequestContext(context({ delegationTarget: { resourceIds: [7 as never] } }), now)).toThrow(
      new ConfigurationError("delegation target resource identities must be non-empty strings"),
    )
  })
})

describe("request context snapshot validation", () => {
  it("rejects a value that is not a plain object", () => {
    const expected = new ConfigurationError("request context must be a plain object")
    expect(() => freezeRequestContext(null as never, now)).toThrow(expected)
    expect(() => freezeRequestContext([] as never, now)).toThrow(expected)
    expect(() => freezeRequestContext(new (class Holder {})() as never, now)).toThrow(expected)
  })

  it("accepts a null-prototype context object", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, context())
    expect(() => freezeRequestContext(value as never, now)).not.toThrow()
  })

  it("rejects symbol keys and unknown fields", () => {
    const withSymbol = { ...context(), [Symbol("s")]: 1 }
    expect(() => freezeRequestContext(withSymbol as never, now)).toThrow(new ConfigurationError("request context cannot contain symbol keys"))
    expect(() => freezeRequestContext({ ...context(), extra: 1 } as never, now)).toThrow(
      new ConfigurationError("unknown request context field: extra"),
    )
  })

  it("requires the mandatory fields", () => {
    expect(() => freezeRequestContext(without("requestId"), now)).toThrow(new ConfigurationError("request context field requestId is required"))
    expect(() => freezeRequestContext(without("signal"), now)).toThrow(new ConfigurationError("request context field signal is required"))
    expect(() => freezeRequestContext(without("route"), now)).toThrow(new ConfigurationError("request context field route is required"))
  })

  it("requires an AbortSignal", () => {
    const expected = new ConfigurationError("request context signal must be an AbortSignal")
    expect(() => freezeRequestContext(context({ signal: {} as never }), now)).toThrow(expected)
    expect(() => freezeRequestContext(context({ signal: null as never }), now)).toThrow(expected)
  })

  it("requires request metadata to be a record", () => {
    const expected = new ConfigurationError("request metadata must be a record")
    expect(() => freezeRequestContext(context({ metadata: [] as never }), now)).toThrow(expected)
    expect(() => freezeRequestContext(context({ metadata: null as never }), now)).toThrow(expected)
  })

  it("requires trace context keys and values to be non-empty strings", () => {
    const expected = new ConfigurationError("request trace context must contain non-empty keys and string values")
    expect(() => freezeRequestContext(context({ traceContext: { "": "x" } }), now)).toThrow(expected)
    expect(() => freezeRequestContext(context({ traceContext: { key: 5 as never } }), now)).toThrow(expected)
    expect(() => freezeRequestContext(context({ traceContext: { "   ": "x" } }), now)).toThrow(expected)
  })

  it("keeps optional fields that are present and omits those that are absent", () => {
    const frozen = freezeRequestContext(context({ locale: "fr", timezone: "Europe/Paris", traceContext: { traceparent: "00-a" } }), now)
    expect(frozen.locale).toBe("fr")
    expect(frozen.timezone).toBe("Europe/Paris")
    expect(frozen.traceContext).toEqual({ traceparent: "00-a" })
    expect(frozen).not.toHaveProperty("causationId")
    expect(frozen).not.toHaveProperty("deadline")
    expect(frozen).not.toHaveProperty("metadata")
  })
})
