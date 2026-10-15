import { describe, expect, it } from "vitest"
import type { PersistenceProvider } from "@xonava/core/persistence"
import type { MutationOperationContext } from "@xonava/core/operation"
import { authorizeFrameworkModule, canUseOwnerBypass, toCrudContext, toCrudReadContext } from "../shared"
import type { FrameworkAdapterDeps } from "../../../server"
import { normalizeFrameworkRequest } from "../../scopeResolution"
import { allowAllAbacBundle, canonicalRequestNormalization } from "../../__tests__/canonicalRequest"

const persistence = { dialect: "test", capabilities: {}, repository: () => ({}) } as unknown as PersistenceProvider

async function context() {
  const normalization = canonicalRequestNormalization(undefined, "records")
  const route = normalization.routeBindings.create
  const request = new Request("https://example.test/items", { method: "POST" })
  const session = await normalization.resolveTrustedSession({ request, route })
  return normalizeFrameworkRequest({
    requestId: "request-1", correlationId: "correlation-1", route,
    resolverBindings: normalization.resolverBindings, ...(session ? { session } : {}),
    admit: async ({ identity, scope, scopeId }) => normalization.resolveAdmissionEvidence({ request, route, identity, scope, scopeId, ...(session ? { session } : {}) }),
    signal: request.signal, metadata: { authorizationInputs: { source: "trusted" } },
  })
}

describe("CRUD hook context security boundary", () => {
  it("freezes canonical request metadata and never derives owner bypass from transport data", async () => {
    const requestContext = await context()
    const operation = { operationId: "operation-1", correlationId: "correlation-1", request: requestContext, persistence, services: {} } as unknown as MutationOperationContext
    const mutationContext = toCrudContext(requestContext, operation)
    const readContext = toCrudReadContext(requestContext, operation)
    expect(mutationContext.operation?.request).not.toBe(operation.request)
    expect(Object.isFrozen(mutationContext.operation?.request)).toBe(true)
    expect(Object.isFrozen(mutationContext.operation?.request?.metadata)).toBe(true)
    expect(readContext.operation?.metadata).not.toBe(operation.request!.metadata)
    expect(() => { (mutationContext.operation!.request!.metadata!.authorizationInputs as { source: string }).source = "attacker" }).toThrow()
    expect(canUseOwnerBypass({} as FrameworkAdapterDeps, "platform", requestContext)).toBe(false)
    expect(authorizeFrameworkModule({ deps: { assertValidCsrf: () => undefined, resolveAbacBundle: async () => null } as FrameworkAdapterDeps, moduleKey: "records", action: "create", context: requestContext, bundle: await allowAllAbacBundle("records") })).toMatchObject({ ownerBypass: false })
  })
})
