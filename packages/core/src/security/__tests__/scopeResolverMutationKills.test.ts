import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, ForbiddenError } from "../../domain/errors"
import { encodeExecutionScopeId } from "../../domain/executionScope"
import type { CompiledRouteBinding } from "../../bootstrap/compiledRouteBinding"
import {
  assertVerifiedScopeIdentity,
  createVerifiedScopeResolution,
  isVerifiedScopeResolution,
  resolveVerifiedScope,
  type UntrustedScopeResolutionInput,
  type VerifiedScopeResolution,
} from "../scopeResolver"

const tenant = { kind: "tenant", tenantId: "t1" } as const

function route(overrides: Partial<CompiledRouteBinding> = {}): CompiledRouteBinding {
  return {
    routeKey: "items", definitionVersion: 3, transport: "http", method: "GET", pathTemplate: "/items", exposure: "authenticated",
    operationKey: "items.read", scopeResolution: { kind: "resolver", resolverKey: "tenant", allowedTargetKinds: ["tenant"] },
    anonymousPrincipal: { allowed: false }, inputPolicy: {}, outputPolicy: {}, mutation: { allowed: false }, authorizationPlanKey: "items",
    ...overrides,
  } as CompiledRouteBinding
}

function binding(
  resolve: (input: UntrustedScopeResolutionInput, ref: unknown) => Promise<VerifiedScopeResolution> = async () => createVerifiedScopeResolution("tenant", tenant),
  overrides: { key?: string; resolverKey?: string; allowedTargetKinds?: readonly ("tenant" | "application")[] } = {},
) {
  return {
    key: overrides.key ?? "tenant",
    resolver: { key: overrides.resolverKey ?? "tenant", resolve: resolve as never },
    allowedTargetKinds: overrides.allowedTargetKinds ?? (["tenant"] as const),
  }
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise } catch (error) { return error as Error }
  throw new Error("expected a rejection")
}

describe("createVerifiedScopeResolution", () => {
  it("rejects blank resolver keys with the exact message", () => {
    for (const key of ["", " ", "\t\n"]) {
      let error: unknown
      try { createVerifiedScopeResolution(key, tenant) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as Error).message).toBe("resolver key must be non-empty")
    }
  })

  it("encodes the scope id, copies the scope and keeps the resolver key verbatim", () => {
    const source = { kind: "tenant", tenantId: "t1" } as const
    const created = createVerifiedScopeResolution(" tenant ", source)
    expect(created.resolverKey).toBe(" tenant ")
    expect(created.scopeId).toBe(encodeExecutionScopeId(source))
    expect(created.scope).toEqual(source)
    expect(created.scope).not.toBe(source)
    expect(Object.isFrozen(created)).toBe(true)
    expect(Object.isFrozen(created.scope)).toBe(true)
  })
})

describe("isVerifiedScopeResolution", () => {
  it("accepts only objects issued by createVerifiedScopeResolution", () => {
    const created = createVerifiedScopeResolution("tenant", tenant)
    expect(isVerifiedScopeResolution(created)).toBe(true)
    expect(isVerifiedScopeResolution({ ...created })).toBe(false)
    expect(isVerifiedScopeResolution(Object.freeze({ ...created }))).toBe(false)
    for (const value of [null, undefined, "x", 1, true, {}, []]) expect(isVerifiedScopeResolution(value)).toBe(false)
  })
})

describe("assertVerifiedScopeIdentity", () => {
  it("accepts an issued resolution and rejects copies, forgeries and tampered ids with the exact message", () => {
    const created = createVerifiedScopeResolution("tenant", tenant)
    expect(() => assertVerifiedScopeIdentity(created)).not.toThrow()
    const forged = [
      { ...created },
      { scope: tenant, scopeId: encodeExecutionScopeId(tenant), resolverKey: "tenant" },
      { ...created, scopeId: encodeExecutionScopeId({ kind: "tenant", tenantId: "other" }) },
      null,
      undefined,
    ]
    for (const value of forged) {
      let error: unknown
      try { assertVerifiedScopeIdentity(value as never) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(ConfigurationError)
      expect((error as Error).message).toBe("verified scope identity mismatch")
    }
  })
})

describe("resolveVerifiedScope", () => {
  it("passes the untrusted input and exactly the route reference to the resolver", async () => {
    const resolve = vi.fn(async () => createVerifiedScopeResolution("tenant", tenant))
    const input: UntrustedScopeResolutionInput = { host: "h", headers: { a: "b" } }
    await resolveVerifiedScope({ route: route(), input, binding: binding(resolve) })
    expect(resolve).toHaveBeenCalledTimes(1)
    const [passedInput, ref] = resolve.mock.calls[0] as unknown as [UntrustedScopeResolutionInput, unknown]
    expect(passedInput).toBe(input)
    expect(ref).toStrictEqual({ routeKey: "items", definitionVersion: 3, operationKey: "items.read" })
  })

  it("rejects non-resolver routes with the exact configuration error", async () => {
    const error = await rejection(resolveVerifiedScope({ route: route({ scopeResolution: { kind: "fixed", scope: tenant } } as never), input: {}, binding: binding() }))
    expect(error).toBeInstanceOf(ConfigurationError)
    expect(error.message).toBe("route does not use resolver scope resolution")
  })

  it("requires public routes to allow an anonymous principal and lets declared ones through", async () => {
    for (const anonymousPrincipal of [{ allowed: false }, {}, { allowed: "true" }]) {
      const error = await rejection(resolveVerifiedScope({ route: route({ exposure: "public", anonymousPrincipal } as never), input: {}, binding: binding() }))
      expect(error).toBeInstanceOf(ConfigurationError)
      expect(error.message).toBe("public route must declare an anonymous principal")
    }
    const allowed = await resolveVerifiedScope({ route: route({ exposure: "public", anonymousPrincipal: { allowed: true } } as never), input: {}, binding: binding() })
    expect(allowed.scope).toEqual(tenant)
    const authenticated = await resolveVerifiedScope({ route: route({ anonymousPrincipal: { allowed: false } }), input: {}, binding: binding() })
    expect(authenticated.scope).toEqual(tenant)
  })

  it("rejects a binding or resolver whose key differs from the route's resolver key", async () => {
    const message = "scope resolver binding identity mismatch"
    for (const overrides of [{ key: "wrong" }, { resolverKey: "wrong" }, { key: "wrong", resolverKey: "wrong" }]) {
      const resolve = vi.fn(async () => createVerifiedScopeResolution("tenant", tenant))
      const error = await rejection(resolveVerifiedScope({ route: route(), input: {}, binding: binding(resolve, overrides) }))
      expect(error).toBeInstanceOf(ConfigurationError)
      expect(error.message).toBe(message)
      expect(resolve).not.toHaveBeenCalled()
    }
  })

  it("denies unverified, mismatched and out-of-binding results with Forbidden errors", async () => {
    const unverified = await rejection(resolveVerifiedScope({
      route: route(), input: {},
      binding: binding(async () => ({ scope: tenant, scopeId: encodeExecutionScopeId(tenant), resolverKey: "tenant" } as never)),
    }))
    expect(unverified).toBeInstanceOf(ForbiddenError)
    expect(unverified.message).toBe("scope resolver returned an unverified or mismatched result")

    const mismatched = await rejection(resolveVerifiedScope({ route: route(), input: {}, binding: binding(async () => createVerifiedScopeResolution("wrong", tenant)) }))
    expect(mismatched).toBeInstanceOf(ForbiddenError)
    expect(mismatched.message).toBe("scope resolver returned an unverified or mismatched result")

    const application = createVerifiedScopeResolution("tenant", { kind: "application", applicationKey: "app" })
    const outsideBinding = await rejection(resolveVerifiedScope({
      route: route({ scopeResolution: { kind: "resolver", resolverKey: "tenant", allowedTargetKinds: ["tenant", "application"] } }),
      input: {}, binding: binding(async () => application),
    }))
    expect(outsideBinding).toBeInstanceOf(ForbiddenError)
    expect(outsideBinding.message).toBe("resolved scope kind is outside resolver binding")

    const outsideRoute = await rejection(resolveVerifiedScope({
      route: route(), input: {}, binding: binding(async () => application, { allowedTargetKinds: ["application"] }),
    }))
    expect(outsideRoute).toBeInstanceOf(ForbiddenError)
    expect(outsideRoute.message).toBe("resolved scope kind is outside route binding")

    const both = await resolveVerifiedScope({
      route: route({ scopeResolution: { kind: "resolver", resolverKey: "tenant", allowedTargetKinds: ["tenant", "application"] } }),
      input: {}, binding: binding(async () => application, { allowedTargetKinds: ["tenant", "application"] }),
    })
    expect(both.scope).toEqual({ kind: "application", applicationKey: "app" })
  })
})
