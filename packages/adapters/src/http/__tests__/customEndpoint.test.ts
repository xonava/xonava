import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  ConfigurationError,
  createAbacBundle,
  defineAbacModule,
  type AbacPolicy,
  type RequestContext,
} from "@xonava/core/domain"
import { defineEntity } from "@xonava/core/entity"
import type { PersistenceProvider } from "@xonava/core/persistence"
import type { AbacPolicyProvider } from "@xonava/core/security"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "../../server"
import { CRUD } from "../crud"
import { admitModuleAction, resolveEndpointRequestContext } from "../customEndpoint"
import { createFrameworkErrorHandler } from "../handleFrameworkCoreError"
import { resolveRequestMetadata } from "../requestBody"
import { allowAllModuleFacts, canonicalRequestNormalization, trustedSession } from "./canonicalRequest"
import { httpCrudFixture } from "./httpCrudFixture"

const MODULE = "http.people"
const OTHER = "http.other"
const request = () => new Request("https://example.test/people/options", { headers: { "x-correlation-id": "corr-1" } })
const tenantSession = () => trustedSession({ kind: "tenant", tenantId: "tenant-1" })
const errorHandler = createFrameworkErrorHandler()

const catalog = (moduleKey: string) => defineAbacModule({
  moduleKey,
  actions: ["read", "pick"],
  capabilities: [],
  fields: { status: { key: "status", type: "string", operators: ["equals"] } },
})

function policy(effect: "allow" | "deny", priority: number, conditions: Array<{ field: string; operator: "equals"; value: string }> = []): AbacPolicy {
  return {
    source: { policyId: `${effect}-${priority}`, scopeType: "tenant_default" },
    moduleKey: MODULE,
    effect,
    priority,
    payload: {
      actions: ["read", "pick"],
      capabilities: [],
      conditions: { version: 2, systemScope: { logic: "AND", conditions }, userFilters: { logic: "AND", conditions: [] } },
    },
  }
}

async function bundleFor(moduleKey: string, policies: AbacPolicy[], context: RequestContext) {
  const provider: AbacPolicyProvider = { resolve: async () => policies.map((p) => ({ ...p, moduleKey })) }
  return createAbacBundle({
    provider,
    mode: "tenant",
    moduleKey,
    catalog: catalog(moduleKey),
    context: { userId: context.identity.subject.id, tenantId: context.scope.kind === "tenant" ? context.scope.tenantId : "" },
  })
}

function depsFor(options: { enabled?: boolean } = {}): FrameworkAdapterDeps {
  return {
    assertValidCsrf: () => undefined,
    resolveModuleAuthorizationFacts: options.enabled === false
      ? () => ({ enabledModuleKeys: [], enabledModuleActions: {}, enabledModuleCapabilities: {} })
      : (args: { moduleKey: string }) => ({
          ...allowAllModuleFacts(args),
          enabledModuleActions: { [args.moduleKey]: ["read", "pick"] },
        }),
    resolveAbacBundle: async () => null,
  } as unknown as FrameworkAdapterDeps
}

async function contextFor(normalization = canonicalRequestNormalization(tenantSession(), MODULE)) {
  return resolveEndpointRequestContext({ request: request(), routeKey: "list", normalization })
}

async function statusOf(work: () => unknown): Promise<number> {
  try {
    await work()
    return 200
  } catch (error) {
    return errorHandler(error, resolveRequestMetadata(request())).status
  }
}

describe("resolveEndpointRequestContext", () => {
  it("builds the trusted context CRUD builds: session identity, tenant scope and request ids", async () => {
    const context = await resolveEndpointRequestContext({
      request: request(),
      routeKey: "list",
      normalization: canonicalRequestNormalization(tenantSession(), MODULE),
      requestMetadata: { requestId: "req-1", correlationId: "corr-1", ipAddress: "10.0.0.1", userAgent: "agent" },
    })
    expect(context.identity.actor.id).toBe("actor-1")
    expect(context.scope).toEqual({ kind: "tenant", tenantId: "tenant-1" })
    expect(context.requestId).toBe("req-1")
    expect(context.correlationId).toBe("corr-1")
    expect(context.metadata).toMatchObject({ requestId: "req-1", ipAddress: "10.0.0.1", userAgent: "agent" })
  })

  it("generates request ids with resolveRequestMetadata when none are given", async () => {
    const context = await contextFor()
    expect(context.requestId).toMatch(/\S/)
    expect(context.correlationId).toBe("corr-1")
  })

  it("answers a missing session with 401, as the CRUD handlers do", async () => {
    const normalization = { ...canonicalRequestNormalization(tenantSession(), MODULE), resolveTrustedSession: async () => undefined }
    expect(await statusOf(() => contextFor(normalization))).toBe(401)
    const crud = httpCrudFixture({ requestNormalization: normalization })
    expect((await crud.handlers.list(new Request("https://example.test/items"))).status).toBe(401)
  })

  it("throws ConfigurationError for a route key without a binding", async () => {
    await expect(resolveEndpointRequestContext({
      request: request(),
      routeKey: "nope",
      normalization: canonicalRequestNormalization(tenantSession(), MODULE),
    })).rejects.toThrow(ConfigurationError)
  })

  it("needs none of the CRUD keys", async () => {
    const base = canonicalRequestNormalization(tenantSession(), MODULE)
    const normalization: FrameworkRequestNormalization = { ...base, routeBindings: { custom: base.routeBindings.list } }
    const context = await resolveEndpointRequestContext({ request: request(), routeKey: "custom", normalization })
    expect(context.scope.kind).toBe("tenant")
  })
})

describe("admitModuleAction", () => {
  it("admits an unconditional allow", async () => {
    const context = await contextFor()
    const bundle = await bundleFor(MODULE, [policy("allow", 10)], context)
    expect(() => admitModuleAction({ adapterDeps: depsFor(), moduleKey: MODULE, action: "pick", context, bundle })).not.toThrow()
  })

  it("admits a conditional grant", async () => {
    const context = await contextFor()
    const bundle = await bundleFor(MODULE, [policy("allow", 10, [{ field: "status", operator: "equals", value: "open" }])], context)
    expect(() => admitModuleAction({ adapterDeps: depsFor(), moduleKey: MODULE, action: "pick", context, bundle })).not.toThrow()
  })

  it("refuses when an unconditional deny wins over an allow", async () => {
    const context = await contextFor()
    const bundle = await bundleFor(MODULE, [policy("allow", 10), policy("deny", 20)], context)
    expect(await statusOf(() => admitModuleAction({ adapterDeps: depsFor(), moduleKey: MODULE, action: "pick", context, bundle }))).toBe(403)
  })

  it("refuses with 403 when the module is disabled", async () => {
    const context = await contextFor()
    const bundle = await bundleFor(MODULE, [policy("allow", 10)], context)
    expect(await statusOf(() => admitModuleAction({ adapterDeps: depsFor({ enabled: false }), moduleKey: MODULE, action: "pick", context, bundle }))).toBe(403)
  })

  it("refuses with 403 when there is no bundle", async () => {
    const context = await contextFor()
    for (const bundle of [null, undefined]) {
      expect(await statusOf(() => admitModuleAction({ adapterDeps: depsFor(), moduleKey: MODULE, action: "pick", context, bundle }))).toBe(403)
    }
  })

  it("refuses with 403 a verified bundle that belongs to another module", async () => {
    const context = await contextFor()
    const bundle = await bundleFor(OTHER, [policy("allow", 10)], context)
    expect(await statusOf(() => admitModuleAction({ adapterDeps: depsFor(), moduleKey: MODULE, action: "pick", context, bundle }))).toBe(403)
  })

  it("refuses an unverified bundle", async () => {
    const context = await contextFor()
    const bundle = { moduleKey: MODULE, policies: [] } as never
    expect(await statusOf(() => admitModuleAction({ adapterDeps: depsFor(), moduleKey: MODULE, action: "pick", context, bundle }))).toBeGreaterThanOrEqual(400)
  })

  it("matches CRUD admission: a disabled module and a missing bundle are 403 there too", async () => {
    expect((await httpCrudFixture({ deny: true }).handlers.list(new Request("https://example.test/items"))).status).toBe(403)
  })
})

describe("CRUD route binding construction", () => {
  type Row = { id: string; tenantId: string; name: string; version: number }
  const entity = defineEntity<Row, { name: string }, { name: string }>({
    moduleKey: MODULE,
    entity: { name: "person", primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" } } },
    entityScope: { kind: "tenant" },
    policy: { skipCapabilityCheck: true },
    cache: false,
    audit: false,
    validation: { createBody: z.object({ name: z.string() }), updateBody: z.object({ name: z.string() }), idParams: z.object({ id: z.string() }) },
  })
  const runtime = (normalization: FrameworkRequestNormalization) => ({
    adapterDeps: depsFor(),
    requestNormalization: normalization,
    scope: { scope: "tenant" as const, idempotency: { required: false } },
    createPersistence: () => ({}) as PersistenceProvider,
    getCacheAdapter: vi.fn(),
  })
  const without = (key: "list" | "detail" | "create" | "update" | "delete"): FrameworkRequestNormalization => {
    const base = canonicalRequestNormalization(tenantSession(), MODULE)
    const { [key]: _omitted, ...routeBindings } = base.routeBindings
    return { ...base, routeBindings }
  }

  it.each(["list", "detail", "create", "update", "delete"] as const)("fails at construction naming the missing %s key", (key) => {
    expect(() => CRUD(entity, runtime(without(key)))).toThrow(new RegExp(`${key}"`))
    expect(() => CRUD(entity, runtime(without(key)))).toThrow(ConfigurationError)
  })

  it("does not require the binding of a disabled route", () => {
    const disabled = defineEntity<Row, { name: string }, { name: string }>({
      moduleKey: MODULE,
      entity: { name: "person", primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" } } },
      entityScope: { kind: "tenant" },
      policy: { skipCapabilityCheck: true },
      cache: false,
      audit: false,
      routes: { create: false },
      validation: { createBody: z.object({ name: z.string() }), updateBody: z.object({ name: z.string() }), idParams: z.object({ id: z.string() }) },
    })
    expect(() => CRUD(disabled, runtime(without("create")))).not.toThrow()
  })

  it("keeps working when all five keys are present", () => {
    expect(() => CRUD(entity, runtime(canonicalRequestNormalization(tenantSession(), MODULE)))).not.toThrow()
  })
})
