import { describe, expect, it, vi } from "vitest"
import { encodeExecutionScopeId, freezeRequestContext, type Principal, type RequestContext } from "@xonava/core/domain"
import { authorizeFrameworkModule } from "../shared"
import { assertFrameworkAdapterDeps, type FrameworkAdapterDeps } from "../../../server"
import { allowAllAbacBundle } from "../../__tests__/canonicalRequest"

const principal = (id: string): Principal => ({ id, kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } })

function context(subjectId = "user-1"): RequestContext {
  const actor = principal("user-1"), subject = principal(subjectId)
  const scope = { kind: "tenant", tenantId: "tenant-1" } as const
  const scopeId = encodeExecutionScopeId(scope)
  return freezeRequestContext({
    requestId: "request-1", correlationId: "correlation-1", identity: { actor, subject }, scope, scopeId,
    authority: { identity: { actor, subject }, correlationId: "correlation-1", grant: {
      grantId: "grant-1", source: { kind: "route", routeKey: "records.list" }, target: { scope, scopeId }, purpose: "test", reason: "test",
      issuedAt: "2026-09-10T00:00:00.000Z", policy: { policyKey: "records", policyVersion: 1, policyDigest: "digest", evaluatedAt: "2026-09-10T00:00:00.000Z", authorizationModel: "continuous" }, delegationChain: [],
      impersonation: subjectId === actor.id ? { kind: "none" } : { kind: "explicit", actorId: actor.id, subjectId, grantId: "grant-1" },
    } }, route: { routeKey: "records.list", definitionVersion: 1, operationKey: "records.list" }, signal: new AbortController().signal,
  }, new Date("2026-09-10T00:00:01.000Z"))
}

function deps(): FrameworkAdapterDeps {
  return { assertValidCsrf: vi.fn(), resolveAbacBundle: vi.fn(async () => null), resolveModuleAuthorizationFacts: vi.fn(() => ({ enabledModuleKeys: ["records"], enabledModuleActions: { records: ["read"] }, enabledModuleCapabilities: {} })) }
}

describe("authorization trust boundary", () => {
  it.each(["isOwnerBypass", "resolveSession", "hasCapability"])("rejects obsolete decision key %s", (key) => {
    expect(() => assertFrameworkAdapterDeps({ [key]: () => true })).toThrow(/obsolete authorization decision key/)
  })
  it("derives scope from canonical context rather than host facts", async () => {
    const bundle = await allowAllAbacBundle("records")
    expect(() => authorizeFrameworkModule({ deps: deps(), moduleKey: "records", action: "read", context: context(), bundle })).not.toThrow()
  })
  it("never grants owner bypass to impersonated identity", async () => {
    const bundle = await allowAllAbacBundle("records")
    expect(authorizeFrameworkModule({ deps: deps(), moduleKey: "records", action: "read", context: context("customer-1"), bundle }).ownerBypass).toBe(false)
  })
})
