import { describe, expect, it, vi } from "vitest"
import { createAnonymousPrincipal } from "@xonava/core/domain"
import type { CompiledRouteBinding } from "@xonava/core/bootstrap"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "../../server"
import { allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"
import { httpCrudFixture } from "./httpCrudFixture"

const MODULE = "http.people"

/** Normalization whose resolver reports "no login" for every request. */
function noLogin(mutate?: (route: CompiledRouteBinding) => CompiledRouteBinding): FrameworkRequestNormalization {
  const base = canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), MODULE)
  const routeBindings = mutate
    ? Object.fromEntries(Object.entries(base.routeBindings).map(([key, route]) => [key, mutate(route)])) as unknown as FrameworkRequestNormalization["routeBindings"]
    : base.routeBindings
  return { ...base, routeBindings, resolveTrustedSession: async () => undefined }
}

const anonymousAllowed = (route: CompiledRouteBinding): CompiledRouteBinding =>
  ({ ...route, anonymousPrincipal: { allowed: true, principal: createAnonymousPrincipal() } })

async function expectUnauthorized(response: Response) {
  const text = await response.clone().text()
  expect(response.status, text).toBe(401)
  expect(text).toContain("UNAUTHORIZED")
}

describe("a missing login answers 401, not 500", () => {
  it("list, detail and create answer 401 and touch neither repository nor admission", async () => {
    const normalization = noLogin()
    const admit = vi.fn(normalization.resolveAdmissionEvidence)
    const fixture = httpCrudFixture({ requestNormalization: { ...normalization, resolveAdmissionEvidence: admit } })
    await expectUnauthorized(await fixture.handlers.list(new Request("https://example.test/items")))
    await expectUnauthorized(await fixture.handlers.detail(new Request("https://example.test/items/a"), { id: "a" }))
    await expectUnauthorized(await fixture.handlers.create(new Request("https://example.test/items", {
      method: "POST", body: JSON.stringify({ name: "x" }), headers: { "content-type": "application/json" },
    })))
    for (const fn of Object.values(fixture.repository)) expect(fn).not.toHaveBeenCalled()
    expect(admit).not.toHaveBeenCalled()
  })

  it("a write handler route answers 401, executes nothing and writes no audit", async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const audit = vi.fn()
    const base = canonicalRequestNormalization(trustedSession(), MODULE)
    const normalization: FrameworkRequestNormalization = { ...noLogin(), routeBindings: base.routeBindings }
    const deps: FrameworkAdapterDeps = {
      assertValidCsrf: () => undefined,
      resolveModuleAuthorizationFacts: allowAllModuleFacts,
      resolveAbacBundle: async () => null,
    } as never
    const handler = createFrameworkWriteHandler({
      adapterDeps: deps,
      requestNormalization: normalization,
      scope: { scope: "platform", idempotency: { required: false } },
      moduleKey: MODULE,
      action: "update",
      skipCapabilityCheck: true,
      runtimeCapabilities: { deferredExecution: true, cache: true },
      createPersistence: () => { throw new Error("persistence must not be reached") },
      auditSinkFactory: () => ({ write: audit }),
      definition: { key: `${MODULE}.update`, kind: "mutation", atomicity: { kind: "standard", mode: "required" }, authorization: { authorize: async () => ({ allowed: true }) }, execute } as never,
      validation: { body: { parse: (value: unknown) => value, parseAsync: async (value: unknown) => value } } as never,
      resolveInput: async () => ({}),
    })
    await expectUnauthorized(await handler(new Request("https://example.test/items/a", {
      method: "PATCH", body: "{}", headers: { "content-type": "application/json" },
    })))
    expect(execute).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it("a route that allows an anonymous principal keeps the configuration error", async () => {
    const fixture = httpCrudFixture({ requestNormalization: noLogin(anonymousAllowed) })
    const response = await fixture.handlers.list(new Request("https://example.test/items"))
    expect(response.status).toBe(500)
  })

  it("a public route without a compiled anonymous principal stays a configuration error", async () => {
    const fixture = httpCrudFixture({ requestNormalization: noLogin((route) => ({ ...route, exposure: "public" })) })
    const response = await fixture.handlers.list(new Request("https://example.test/items"))
    expect(response.status).toBe(500)
  })
})
