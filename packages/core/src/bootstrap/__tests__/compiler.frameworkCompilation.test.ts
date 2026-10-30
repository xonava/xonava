import { afterEach, describe, expect, it, vi } from "vitest"
import { ConfigurationError } from "../../domain/errors"
import type { ExecutionScope } from "../../domain/executionScope"
import type { ScopeResolver } from "../../security/scopeResolver"
import { createVerifiedScopeResolution } from "../../security/scopeResolver"
import { canonicalSha256Hex } from "../../serialization/canonicalJson"
import { COMPILED_DURABLE_FORMAT_REGISTRY_V1, type CompiledDurableFormat, type CompiledDurableFormatRegistry } from "../../serialization/formatRegistry"
import type { GuaranteeId } from "../../spec/guarantees"
import { compileFramework, type CompileFrameworkOptions } from "../compiler"
import type { GuaranteeCertificationV1 } from "../compiledPlan"
import type { DatasourceDefinition, DelegationRuleDefinition, FrameworkDefinition, RouteDefinition, ScopeResolverDefinition } from "../definition"
import { FrameworkDefinitionRegistry } from "../definitionRegistry"

const BASE: CompileFrameworkOptions = { frameworkVersion: "2.0.0", sourceRevision: "rev", compiledAt: "2026-09-10T00:00:00.000Z" }
const TENANT: ExecutionScope = { kind: "tenant", tenantId: "t1" }

function reg(...definitions: FrameworkDefinition[]): FrameworkDefinitionRegistry {
  const registry = new FrameworkDefinitionRegistry()
  for (const definition of definitions) registry.register(definition)
  return registry
}

function failure(registry: FrameworkDefinitionRegistry, options: Partial<CompileFrameworkOptions> = {}): string {
  try {
    compileFramework(registry, { ...BASE, ...options })
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError)
    return (error as Error).message
  }
  throw new Error("expected compileFramework to fail")
}

function resolver(key: string): ScopeResolver {
  return { key, resolve: async () => createVerifiedScopeResolution(key, TENANT) }
}

const policy = (key: string): FrameworkDefinition => ({ kind: "policy", key, definitionVersion: 1 })
const operation = (key: string, extra: Partial<FrameworkDefinition> = {}): FrameworkDefinition => ({ kind: "operation", key, definitionVersion: 1, ...extra })
type Loose<T> = { [K in keyof T]?: T[K] | undefined }
function route(key: string, extra: Loose<RouteDefinition> = {}): RouteDefinition {
  return { kind: "route", key, definitionVersion: 3, method: "GET", path: `/${key}`, operationKey: "op", exposure: "authenticated", scopeResolution: { kind: "fixed", scope: TENANT }, authorizationPlanKey: "p", ...extra } as RouteDefinition
}
const routeDeps = (): FrameworkDefinition[] => [policy("p"), operation("op")]

describe("compileFramework option validation", () => {
  it.each([
    ["frameworkVersion", { frameworkVersion: "" }],
    ["frameworkVersion", { frameworkVersion: "   " }],
    ["frameworkVersion", { frameworkVersion: 2 as never }],
    ["sourceRevision", { sourceRevision: "" }],
    ["sourceRevision", { sourceRevision: " \t" }],
    ["sourceRevision", { sourceRevision: undefined as never }],
  ])("rejects an empty %s before touching the registry", (name, override) => {
    const registry = reg()
    expect(failure(registry, override)).toBe(`${name} must be a non-empty string`)
    expect(registry.state).toBe("OPEN")
  })

  it("reopens the registry after a failed compile so it can be corrected and compiled again", () => {
    const registry = reg({ kind: "entity", key: "e", definitionVersion: 1, requiredCapabilities: ["cap"] })
    expect(failure(registry)).toBe("missing capability cap required by entity:e")
    expect(registry.state).toBe("OPEN")
    const plan = compileFramework(registry, { ...BASE, availableCapabilities: ["cap"] })
    expect(plan.definitions.entities.has("e")).toBe(true)
    expect(registry.state).toBe("SEALED")
  })

  it("validates available capabilities", () => {
    expect(failure(reg(), { availableCapabilities: ["a", ""] })).toBe("available capability must be a non-empty string")
    expect(failure(reg(), { availableCapabilities: ["a", "  "] })).toBe("available capability must be a non-empty string")
  })

  it("stamps compiledAt from the option or the current time", () => {
    expect(compileFramework(reg(), BASE).framework).toEqual({ frameworkVersion: "2.0.0", sourceRevision: "rev", compiledAt: "2026-09-10T00:00:00.000Z" })
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2031-02-03T04:05:06.007Z"))
      const plan = compileFramework(reg(), { frameworkVersion: "9", sourceRevision: "r9" })
      expect(plan.framework).toEqual({ frameworkVersion: "9", sourceRevision: "r9", compiledAt: "2031-02-03T04:05:06.007Z" })
    } finally {
      vi.useRealTimers()
    }
  })
})

afterEach(() => { vi.useRealTimers() })

describe("normalisation and implicit references", () => {
  it("derives implicit references in a stable order without duplicating explicit ones", () => {
    const registry = reg(
      { kind: "datasource", key: "d", definitionVersion: 1, adapter: "a", capabilities: [] } as DatasourceDefinition,
      policy("p"),
      { kind: "event", key: "ev", definitionVersion: 1 },
      operation("op"),
      { kind: "workflow", key: "wf", definitionVersion: 1 },
      { kind: "entity", key: "e", definitionVersion: 1, datasourceKey: "d", policyKey: "p", eventKeys: ["ev"], operationKeys: ["op"], workflowKeys: ["wf"], references: [{ kind: "datasource", key: "d" }, { kind: "event", key: "ev" }] },
    )
    const entity = compileFramework(registry, BASE).definitions.entities.get("e")!
    expect(entity.references).toEqual([
      { kind: "datasource", key: "d" }, { kind: "event", key: "ev" }, { kind: "policy", key: "p" }, { kind: "operation", key: "op" }, { kind: "workflow", key: "wf" },
    ])
    expect(entity.dependencies).toEqual(["datasource:d", "event:ev", "policy:p", "operation:op", "workflow:wf"])
    expect(entity.definitionId).toBe("entity:e")
  })

  it("keeps references that share only a kind or only a key", () => {
    const registry = reg(
      policy("shared"), { kind: "event", key: "shared", definitionVersion: 1 }, policy("other"),
      { kind: "entity", key: "e", definitionVersion: 1, policyKey: "shared", references: [{ kind: "event", key: "shared" }, { kind: "policy", key: "other" }] },
    )
    const entity = compileFramework(registry, BASE).definitions.entities.get("e")!
    expect(entity.references).toEqual([{ kind: "event", key: "shared" }, { kind: "policy", key: "other" }, { kind: "policy", key: "shared" }])
  })

  it("adds no reference for absent or empty keys", () => {
    const registry = reg({ kind: "entity", key: "e", definitionVersion: 1, datasourceKey: "", policyKey: "" })
    expect(compileFramework(registry, BASE).definitions.entities.get("e")!.references).toEqual([])
  })

  it("adds the operation, authorization policy and resolver of a route", () => {
    const registry = reg(
      policy("p"), policy("q"), operation("op"),
      { kind: "scopeResolver", key: "sr", definitionVersion: 1, allowedTargetKinds: ["tenant"] } as ScopeResolverDefinition,
      route("r", { policyKey: "q", scopeResolution: { kind: "resolver", resolverKey: "sr", allowedTargetKinds: ["tenant"] } }),
    )
    const plan = compileFramework(registry, { ...BASE, scopeResolvers: [resolver("sr")] })
    const definition = registry.snapshot().find(d => d.key === "r")!
    expect(definition.references).toBeUndefined()
    expect(plan.runtimeBindings.startupOrder).toContain("route:r")
    expect(plan.runtimeBindings.startupOrder.indexOf("policy:q")).toBeLessThan(plan.runtimeBindings.startupOrder.indexOf("route:r"))
    expect(plan.runtimeBindings.startupOrder.indexOf("operation:op")).toBeLessThan(plan.runtimeBindings.startupOrder.indexOf("route:r"))
    expect(plan.runtimeBindings.startupOrder.indexOf("scopeResolver:sr")).toBeLessThan(plan.runtimeBindings.startupOrder.indexOf("route:r"))
    expect(plan.runtimeBindings.startupOrder.indexOf("policy:p")).toBeLessThan(plan.runtimeBindings.startupOrder.indexOf("route:r"))
  })

  it("does not add a scope resolver reference for a fixed-scope route and tolerates a missing resolution", () => {
    const fixed = compileFramework(reg(...routeDeps(), route("r")), BASE)
    expect(fixed.runtimeBindings.startupOrder).toEqual(["policy:p", "operation:op", "route:r"])
    expect(failure(reg(...routeDeps(), route("r", { scopeResolution: undefined })))).toBe("route r has no scope resolution plan")
  })

  it("sorts and de-duplicates required capabilities", () => {
    const registry = reg({ kind: "entity", key: "e", definitionVersion: 1, requiredCapabilities: ["b", "a", "b", "c"] })
    const entity = compileFramework(registry, { ...BASE, availableCapabilities: ["a", "b", "c"] }).definitions.entities.get("e")!
    expect(entity.requiredCapabilities).toEqual(["a", "b", "c"])
  })

  it("leaves a definition without capabilities free of the property", () => {
    const entity = compileFramework(reg({ kind: "entity", key: "e", definitionVersion: 1 }), BASE).definitions.entities.get("e")!
    expect("requiredCapabilities" in entity).toBe(false)
  })
})

describe("capability checks", () => {
  it("reports a capability the host does not offer", () => {
    expect(failure(reg({ kind: "entity", key: "e", definitionVersion: 1, requiredCapabilities: ["x"] }), { availableCapabilities: ["y"] })).toBe("missing capability x required by entity:e")
  })

  it("reports a datasource that lacks a required capability and accepts one that has it", () => {
    const datasource = (capabilities: string[]): DatasourceDefinition => ({ kind: "datasource", key: "d", definitionVersion: 1, adapter: "a", capabilities })
    const entity: FrameworkDefinition = { kind: "entity", key: "e", definitionVersion: 1, datasourceKey: "d", requiredCapabilities: ["tx"] }
    expect(failure(reg(datasource(["other"]), entity), { availableCapabilities: ["tx"] })).toBe("datasource d lacks capability tx required by entity:e")
    expect(compileFramework(reg(datasource(["other", "tx"]), entity), { ...BASE, availableCapabilities: ["tx"] }).datasources.has("d")).toBe(true)
    expect(compileFramework(reg(datasource([]), { kind: "entity", key: "e", definitionVersion: 1, datasourceKey: "d" }), BASE).datasources.has("d")).toBe(true)
  })

  it("validates datasource capability lists", () => {
    const d = (capabilities: string[]): DatasourceDefinition => ({ kind: "datasource", key: "d", definitionVersion: 1, adapter: "a", capabilities })
    expect(failure(reg(d(["x", "x"])))).toBe("duplicate datasource capability")
    expect(failure(reg(d([""])))).toBe("datasource capability must be a non-empty string")
  })
})

describe("durable formats", () => {
  const entryOf = (index: number): CompiledDurableFormat => COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries[index]!
  const registryOf = (entries: CompiledDurableFormat[], keys = entries.map(e => e.formatId)): CompiledDurableFormatRegistry =>
    ({ entries, byFormatId: new Map(entries.map((e, i) => [keys[i]!, e] as const)) })
  const needs = (formatId: string, readableVersions: number[], writableVersion?: number): FrameworkDefinition =>
    ({ kind: "entity", key: "e", definitionVersion: 1, requiredFormats: [{ formatId, readableVersions, ...(writableVersion === undefined ? {} : { writableVersion }) }] })

  it("defaults to the built-in registry and seals a frozen copy", () => {
    const plan = compileFramework(reg(), BASE)
    expect(plan.durableFormats.entries.map(e => e.formatId)).toEqual(COMPILED_DURABLE_FORMAT_REGISTRY_V1.entries.map(e => e.formatId))
    expect(plan.durableFormats.byFormatId.get("framework.event-envelope")).toEqual({ formatId: "framework.event-envelope", formatVersion: 1, kind: "framework-envelope", readableVersions: [1] })
    const custom: CompiledDurableFormat = { formatId: "custom.format", formatVersion: 1, kind: "framework-envelope", readableVersions: [1, 2] }
    const sealed = compileFramework(reg(), { ...BASE, durableFormats: registryOf([custom]) }).durableFormats
    expect(sealed.entries).toEqual([custom])
    expect(sealed.entries[0]).not.toBe(custom)
    expect(Object.isFrozen(sealed)).toBe(true)
    expect(Object.isFrozen(sealed.entries)).toBe(true)
    expect(Object.isFrozen(sealed.entries[0])).toBe(true)
    expect(sealed.byFormatId.get("custom.format")).toEqual(custom)
  })

  it("rejects an invalid registry shape, index mismatch and non-current formats", () => {
    const a = entryOf(0)
    expect(() => compileFramework(reg(), { ...BASE, durableFormats: registryOf([{ ...a, formatId: "Bad Id" }]) })).toThrow(/invalid formatId/)
    expect(failure(reg(), { durableFormats: { entries: [a], byFormatId: new Map() } })).toBe("durable format registry index mismatch")
    expect(failure(reg(), { durableFormats: registryOf([a], ["other.format"]) })).toBe(`durable format ${a.formatId} is not current-version readable`)
    expect(failure(reg(), { durableFormats: { entries: [a], byFormatId: new Map([[a.formatId, { ...a, formatVersion: 2, readableVersions: [1, 2] }]]) } })).toBe(`durable format ${a.formatId} is not current-version readable`)
    expect(failure(reg(), { durableFormats: registryOf([{ ...a, readableVersions: [2] }]) })).toBe(`durable format ${a.formatId} is not current-version readable`)
    expect(compileFramework(reg(), { ...BASE, durableFormats: registryOf([{ ...a, readableVersions: [1, 2] }]) }).durableFormats.entries).toHaveLength(1)
  })

  it("checks the formats each definition requires", () => {
    const id = entryOf(0).formatId
    const wide: CompiledDurableFormat = { ...entryOf(0), readableVersions: [1, 2] }
    expect(failure(reg(needs("absent.format", [1])))).toBe("missing durable format absent.format required by entity:e")
    expect(failure(reg(needs(id, [1, 2])))).toBe(`durable format ${id} reader incompatibility`)
    expect(failure(reg(needs(id, [2, 1])))).toBe(`durable format ${id} reader incompatibility`)
    expect(failure(reg(needs(id, [1], 2)))).toBe(`durable format ${id} writer incompatibility`)
    expect(compileFramework(reg(needs(id, [])), BASE).definitions.entities.has("e")).toBe(true)
    expect(compileFramework(reg(needs(id, [1], 1)), BASE).definitions.entities.has("e")).toBe(true)
    expect(compileFramework(reg(needs(id, [1])), BASE).definitions.entities.has("e")).toBe(true)
    expect(compileFramework(reg(needs(id, [1, 2])), { ...BASE, durableFormats: registryOf([wide]) }).definitions.entities.has("e")).toBe(true)
  })
})

describe("scope resolver bindings", () => {
  const sr = (key: string, allowedTargetKinds: ExecutionScope["kind"][], extra: Partial<ScopeResolverDefinition> = {}): ScopeResolverDefinition =>
    ({ kind: "scopeResolver", key, definitionVersion: 4, allowedTargetKinds, ...extra })

  it("binds the runtime resolver with a frozen copy of its target kinds", () => {
    const runtime = resolver("sr")
    const plan = compileFramework(reg(sr("sr", ["tenant", "platform", "application", "system"])), { ...BASE, scopeResolvers: [runtime] })
    const binding = plan.authority.scopeResolvers.get("sr")!
    expect(binding.key).toBe("sr")
    expect(binding.definitionVersion).toBe(4)
    expect(binding.resolver.key).toBe(runtime.key)
    expect(binding.allowedTargetKinds).toEqual(["tenant", "platform", "application", "system"])
    expect(Object.isFrozen(binding)).toBe(true)
    expect(Object.isFrozen(binding.allowedTargetKinds)).toBe(true)
    expect(plan.authority.scopeResolvers.size).toBe(1)
  })

  it("rejects malformed runtime resolver lists", () => {
    expect(failure(reg(sr("sr", ["tenant"])), { scopeResolvers: [resolver("sr"), resolver("sr")] })).toBe("duplicate scope resolver sr")
    expect(failure(reg(sr("sr", ["tenant"])), { scopeResolvers: [resolver("")] })).toBe("resolver key must be a non-empty string")
    expect(failure(reg(sr("sr", ["tenant"])), { scopeResolvers: [resolver(" ")] })).toBe("resolver key must be a non-empty string")
    expect(failure(reg(sr("sr", ["tenant"])))).toBe("missing scope resolver runtime sr")
    expect(failure(reg(sr("sr", ["tenant"])), { scopeResolvers: [resolver("sr"), resolver("ghost")] })).toBe("scope resolver runtime ghost has no definition")
  })

  it("rejects malformed target kinds", () => {
    const opts = (key: string): Partial<CompileFrameworkOptions> => ({ scopeResolvers: [resolver(key)] })
    expect(failure(reg(sr("sr", [])), opts("sr"))).toBe("scope resolver sr has no allowed target kinds")
    expect(failure(reg(sr("sr", ["tenant", "tenant"])), opts("sr"))).toBe("duplicate resolver target kind")
    expect(failure(reg(sr("sr", ["public" as never])), opts("sr"))).toBe("invalid resolver target kind for sr")
    expect(failure(reg(sr("sr", ["tenant", "" as never])), opts("sr"))).toBe("resolver target kind must be a non-empty string")
  })
})

describe("route compilation", () => {
  const compileRoute = (r: RouteDefinition, extra: FrameworkDefinition[] = []) => compileFramework(reg(...routeDeps(), ...extra, r), BASE).routes.get(r.key)!

  it("compiles an authenticated route with defaults", () => {
    const compiled = compileRoute(route("r", { method: "post", path: "/orders/:id" }))
    expect(compiled).toEqual({
      key: "r", routeKey: "r", definitionVersion: 3, transport: "http", method: "POST", pathTemplate: "/orders/:id", exposure: "authenticated", operationKey: "op",
      scopeResolution: { kind: "fixed", scope: TENANT }, anonymousPrincipal: { allowed: false }, inputPolicy: {}, outputPolicy: {}, mutation: { allowed: false }, authorizationPlanKey: "p",
    })
    expect(Object.isFrozen(compiled)).toBe(true)
  })

  it("compiles a public route with an anonymous principal and passes policies through", () => {
    const sr: ScopeResolverDefinition = { kind: "scopeResolver", key: "sr", definitionVersion: 1, allowedTargetKinds: ["tenant", "platform"] }
    const publicRoute = route("r", {
      exposure: "public", scopeResolution: { kind: "resolver", resolverKey: "sr", allowedTargetKinds: ["tenant"] },
      inputPolicy: { maxBytes: 5 }, outputPolicy: { redact: true }, mutation: { allowed: true, idempotencyRequirement: "required" },
    })
    const plan = compileFramework(reg(...routeDeps(), sr, publicRoute), { ...BASE, scopeResolvers: [resolver("sr")] })
    expect(plan.routes.get("r")).toEqual({
      key: "r", routeKey: "r", definitionVersion: 3, transport: "http", method: "GET", pathTemplate: "/r", exposure: "public", operationKey: "op",
      scopeResolution: { kind: "resolver", resolverKey: "sr", allowedTargetKinds: ["tenant"] },
      anonymousPrincipal: { allowed: true, principal: { kind: "anonymous", id: "anonymous", authentication: { kind: "anonymous" } } },
      inputPolicy: { maxBytes: 5 }, outputPolicy: { redact: true }, mutation: { allowed: true, idempotencyRequirement: "required" }, authorizationPlanKey: "p",
    })
  })

  it("keeps routes in registration order", () => {
    const plan = compileFramework(reg(...routeDeps(), route("b"), route("a")), BASE)
    expect([...plan.routes.keys()]).toEqual(["b", "a"])
    expect(plan.routes.size).toBe(2)
  })

  it("validates the method", () => {
    expect(failure(reg(...routeDeps(), route("r", { method: "" })))).toBe("route r method must be a non-empty string")
    expect(failure(reg(...routeDeps(), route("r", { method: "  " })))).toBe("route r method must be a non-empty string")
    expect(failure(reg(...routeDeps(), route("r", { method: "TRACE" })))).toBe("route r has unsupported HTTP method TRACE")
    expect(failure(reg(...routeDeps(), route("r", { method: "connect" })))).toBe("route r has unsupported HTTP method connect")
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "delete", "Options"]) {
      expect(compileRoute(route("r", { method })).method).toBe(method.toUpperCase())
    }
  })

  it("validates the path template", () => {
    const bad = (path: string): string => failure(reg(...routeDeps(), route("r", { path })))
    expect(bad("")).toBe("route r path must be a non-empty string")
    expect(bad("  ")).toBe("route r path must be a non-empty string")
    expect(bad("orders")).toBe('route r path must start with "/" and must not end with "/"')
    expect(bad("/orders/")).toBe('route r path must start with "/" and must not end with "/"')
    expect(bad("/a/:id/:id")).toBe("route r repeats path parameter :id")
    expect(bad("/a/:1x")).toBe('route r has an invalid path segment ":1x"')
    expect(bad("/a/:")).toBe('route r has an invalid path segment ":"')
    expect(bad("/a/./b")).toBe('route r has an invalid path segment "."')
    expect(bad("/a/../b")).toBe('route r has an invalid path segment ".."')
    expect(bad("/a b")).toBe('route r has an invalid path segment "a b"')
    expect(bad("//a")).toBe('route r has an invalid path segment ""')
    expect(bad("/a/b?x")).toBe('route r has an invalid path segment "b?x"')
    expect(bad("/a#")).toBe('route r has an invalid path segment "a#"')
    expect(bad("/a\n")).toBe('route r has an invalid path segment "a\\n"')
  })

  it("accepts the root, parameters and every permitted literal character", () => {
    expect(compileRoute(route("r", { path: "/" })).pathTemplate).toBe("/")
    expect(compileRoute(route("r", { path: "/:_a1/:B2" })).pathTemplate).toBe("/:_a1/:B2")
    const literal = "/Az09._~!$&'()*+,;=@%-x"
    expect(compileRoute(route("r", { path: literal })).pathTemplate).toBe(literal)
    expect(compileRoute(route("r", { path: "/x.y/..z/.." + "w" })).pathTemplate).toBe("/x.y/..z/..w")
  })

  it("rejects routes that handle the same method and path shape", () => {
    expect(failure(reg(...routeDeps(), route("a", { path: "/orders/:id" }), route("b", { method: "get", path: "/orders/:orderId" })))).toBe("routes a and b both handle GET /orders/:orderId")
    const distinct = compileFramework(reg(...routeDeps(),
      route("a", { path: "/orders/:id" }), route("b", { method: "POST", path: "/orders/:id" }), route("c", { path: "/orders/all" }), route("d", { path: "/orders/:id/items" })), BASE)
    expect(distinct.routes.size).toBe(4)
    expect(failure(reg(...routeDeps(), route("a", { path: "/" }), route("b", { path: "/" })))).toBe("routes a and b both handle GET /")
  })

  it("selects the authorization policy by precedence", () => {
    const extra = [policy("q"), policy("s"), operation("op2", { policyKey: "s" })]
    expect(compileRoute(route("r", { authorizationPlanKey: "q", policyKey: "s" }), extra).authorizationPlanKey).toBe("q")
    expect(compileRoute(route("r", { authorizationPlanKey: undefined, policyKey: "s" }), extra).authorizationPlanKey).toBe("s")
    expect(compileRoute(route("r", { authorizationPlanKey: undefined, operationKey: "op2" }), extra).authorizationPlanKey).toBe("s")
  })

  it("rejects a route without any authorization policy even when a policy named undefined exists", () => {
    const noPolicy = route("r", { authorizationPlanKey: undefined })
    expect(failure(reg(operation("op"), noPolicy))).toBe("route r references missing authorization policy")
    expect(failure(reg(operation("op"), policy("undefined"), noPolicy))).toBe("route r references missing authorization policy")
  })

  it("rejects a missing operation, resolver definition or scope plan", () => {
    expect(failure(reg(policy("p"), route("r")))).toBe("missing definition reference operation:op from route:r")
    expect(failure(reg(...routeDeps(), route("r", { scopeResolution: { kind: "resolver", resolverKey: "nope", allowedTargetKinds: ["tenant"] } })))).toBe("missing definition reference scopeResolver:nope from route:r")
    expect(failure(reg(...routeDeps(), route("r", { scopeResolution: undefined })))).toBe("route r has no scope resolution plan")
  })

  it("rejects public routes with fixed scope and invalid fixed scopes", () => {
    expect(failure(reg(...routeDeps(), route("r", { exposure: "public" })))).toBe("public route r must use resolver scope resolution")
    expect(() => compileFramework(reg(...routeDeps(), route("r", { scopeResolution: { kind: "fixed", scope: { kind: "bogus" } as never } })), BASE)).toThrow()
  })

  describe("resolver scope resolution", () => {
    const sr = (kinds: ExecutionScope["kind"][]): ScopeResolverDefinition => ({ kind: "scopeResolver", key: "sr", definitionVersion: 1, allowedTargetKinds: kinds })
    const resolving = (allowedTargetKinds: ExecutionScope["kind"][]): RouteDefinition => route("r", { scopeResolution: { kind: "resolver", resolverKey: "sr", allowedTargetKinds } })
    const run = (resolverKinds: ExecutionScope["kind"][], routeKinds: ExecutionScope["kind"][]): string =>
      failure(reg(...routeDeps(), sr(resolverKinds), resolving(routeKinds)), { scopeResolvers: [resolver("sr")] })

    it("rejects empty, duplicate, blank and widened target kinds", () => {
      expect(run(["tenant"], [])).toBe("route r has no allowed target kinds")
      expect(run(["tenant"], ["tenant", "tenant"])).toBe("duplicate route target kind")
      expect(run(["tenant"], ["" as never])).toBe("route target kind must be a non-empty string")
      expect(run(["tenant"], ["platform"])).toBe("route r widens resolver target kinds")
      expect(run(["tenant"], ["tenant", "platform"])).toBe("route r widens resolver target kinds")
    })

    it("accepts equal and narrower target kinds", () => {
      const ok = (resolverKinds: ExecutionScope["kind"][], routeKinds: ExecutionScope["kind"][]) =>
        compileFramework(reg(...routeDeps(), sr(resolverKinds), resolving(routeKinds)), { ...BASE, scopeResolvers: [resolver("sr")] }).routes.get("r")!.scopeResolution
      expect(ok(["tenant"], ["tenant"])).toEqual({ kind: "resolver", resolverKey: "sr", allowedTargetKinds: ["tenant"] })
      expect(ok(["tenant", "platform", "system"], ["system", "tenant"])).toEqual({ kind: "resolver", resolverKey: "sr", allowedTargetKinds: ["system", "tenant"] })
    })
  })
})

describe("delegation rules", () => {
  const rule = (extra: Partial<DelegationRuleDefinition> = {}): DelegationRuleDefinition =>
    ({ kind: "delegationRule", key: "dr", definitionVersion: 1, fromKinds: ["platform"], toKinds: ["tenant"], capabilities: ["read"], ...extra })

  it("rejects duplicate or blank members", () => {
    expect(failure(reg(rule({ fromKinds: ["platform", "platform"] })))).toBe("duplicate delegation source kind")
    expect(failure(reg(rule({ toKinds: ["tenant", "tenant"] })))).toBe("duplicate delegation target kind")
    expect(failure(reg(rule({ capabilities: ["read", "read"] })))).toBe("duplicate delegation capability")
    expect(failure(reg(rule({ fromKinds: [""  as never] })))).toBe("delegation source kind must be a non-empty string")
    expect(failure(reg(rule({ toKinds: [" " as never] })))).toBe("delegation target kind must be a non-empty string")
    expect(failure(reg(rule({ capabilities: [""] })))).toBe("delegation capability must be a non-empty string")
  })

  it("accepts depth one and omitted depth and rejects deeper or shallower depth", () => {
    expect(compileFramework(reg(rule()), BASE).authority.delegationRules.has("dr")).toBe(true)
    expect(compileFramework(reg(rule({ maximumDepth: 1 })), BASE).authority.delegationRules.has("dr")).toBe(true)
    expect(failure(reg(rule({ maximumDepth: 2 })))).toBe("delegation rule dr must use maximum depth 1")
    expect(failure(reg(rule({ maximumDepth: 0 })))).toBe("delegation rule dr must use maximum depth 1")
  })

  it("rejects nested impersonation only when enabled", () => {
    expect(failure(reg(rule({ allowImpersonation: true })))).toBe("delegation rule dr cannot enable nested impersonation")
    expect(compileFramework(reg(rule({ allowImpersonation: false })), BASE).authority.delegationRules.get("dr")).toMatchObject({ allowImpersonation: false })
  })
})

function cert(overrides: Record<string, unknown> = {}, evidence: Record<string, unknown> | null = {}): GuaranteeCertificationV1 {
  const digest = "a".repeat(64)
  return {
    schema: "framework.guarantee-certification", schemaVersion: 1, guarantee: "audit.atomic",
    adapter: { packageName: "@a/pg", packageVersion: "2.0.0", adapterBuildId: "b1" }, status: "proven",
    evidence: evidence === null ? null : { suiteId: "pg", suiteVersion: 1, artifactPath: "ev/pg.json", artifactSha256: digest, sourceRevision: "rev", frameworkVersion: "2.0.0", executedAt: "2026-09-10T00:00:00.000Z", environment: { runtime: "node", runtimeVersion: "22", databaseEngine: "pg", databaseVersion: "17" }, ...evidence },
    topology: { mode: "single", limits: {}, assumptions: [] }, failureBehavior: { startupWhenRequired: "reject-configuration", runtimeIfTopologyChanges: "fail-closed" },
    migration: { state: "not-required", migrationIds: [] }, ...overrides,
  } as never
}
const DIGESTS = { "ev/pg.json": "a".repeat(64) }

describe("guarantee certifications", () => {
  const certify = (c: GuaranteeCertificationV1, digests: Record<string, string> = DIGESTS): string => failure(reg(), { certifications: [c], evidenceArtifactDigests: digests })

  it("accepts a proven certification and indexes it by package, build and guarantee", () => {
    const input = cert()
    const plan = compileFramework(reg(), { ...BASE, certifications: [input], evidenceArtifactDigests: DIGESTS })
    expect([...plan.guarantees.certifications.keys()]).toEqual(["@a/pg:b1:audit.atomic"])
    const stored = plan.guarantees.certifications.get("@a/pg:b1:audit.atomic")!
    expect(stored).toEqual(input)
    expect(stored).not.toBe(input)
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.evidence)).toBe(true)
  })

  it("rejects wrong schema, version, guarantee and status", () => {
    expect(certify(cert({ schema: "other" }))).toBe("invalid guarantee certification schema")
    expect(certify(cert({ schemaVersion: 2 }))).toBe("invalid guarantee certification schema")
    expect(certify(cert({ guarantee: "nope" }))).toBe("invalid guarantee nope")
    expect(certify(cert({ status: "bad" }))).toBe("invalid guarantee status bad")
  })

  it("requires non-blank adapter identity", () => {
    expect(certify(cert({ adapter: undefined }))).toBe("adapter.packageName must be a non-empty string")
    expect(certify(cert({ adapter: { packageName: "", packageVersion: "1", adapterBuildId: "b" } }))).toBe("adapter.packageName must be a non-empty string")
    expect(certify(cert({ adapter: { packageName: "p", packageVersion: " ", adapterBuildId: "b" } }))).toBe("adapter.packageVersion must be a non-empty string")
    expect(certify(cert({ adapter: { packageName: "p", packageVersion: "1", adapterBuildId: "" } }))).toBe("adapter.adapterBuildId must be a non-empty string")
  })

  it("requires evidence for proven certifications", () => {
    expect(certify(cert({}, null))).toBe("proven certification audit.atomic has no evidence")
  })

  it("rejects malformed evidence", () => {
    const bad = (evidence: Record<string, unknown>): string => certify(cert({}, evidence))
    for (const suiteVersion of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(bad({ suiteVersion })).toBe("invalid evidence for audit.atomic")
    }
    for (const artifactSha256 of ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "", 5, null, `${"a".repeat(64)}\n`, ` ${"a".repeat(64)}`]) {
      expect(bad({ artifactSha256 })).toBe("invalid evidence for audit.atomic")
    }
    expect(bad({ suiteId: "" })).toBe("evidence.suiteId must be a non-empty string")
    expect(bad({ suiteId: "  " })).toBe("evidence.suiteId must be a non-empty string")
    expect(bad({ artifactPath: "" })).toBe("evidence.artifactPath must be a non-empty string")
  })

  it("accepts the smallest suite version and a safe integer ceiling", () => {
    for (const suiteVersion of [1, 2, Number.MAX_SAFE_INTEGER]) {
      expect(compileFramework(reg(), { ...BASE, certifications: [cert({}, { suiteVersion })], evidenceArtifactDigests: DIGESTS }).guarantees.certifications.size).toBe(1)
    }
  })

  it("rejects stale evidence on either revision or framework version", () => {
    expect(certify(cert({}, { sourceRevision: "old" }))).toBe("stale evidence for audit.atomic")
    expect(certify(cert({}, { frameworkVersion: "1.0.0" }))).toBe("stale evidence for audit.atomic")
  })

  it("rejects an unparsable execution timestamp", () => {
    expect(certify(cert({}, { executedAt: "yesterday" }))).toBe("invalid evidence timestamp for audit.atomic")
    expect(certify(cert({}, { executedAt: "" }))).toBe("invalid evidence timestamp for audit.atomic")
  })

  it("rejects missing or different artifact digests", () => {
    expect(failure(reg(), { certifications: [cert()] })).toBe("evidence digest mismatch for audit.atomic")
    expect(certify(cert(), {})).toBe("evidence digest mismatch for audit.atomic")
    expect(certify(cert(), { "ev/pg.json": "b".repeat(64) })).toBe("evidence digest mismatch for audit.atomic")
    expect(certify(cert(), { "other.json": "a".repeat(64) })).toBe("evidence digest mismatch for audit.atomic")
  })

  it("rejects unapplied required migrations only", () => {
    expect(certify(cert({ migration: { state: "required-not-applied", migrationIds: ["m1"] } }))).toBe("required migration not applied for audit.atomic")
    for (const state of ["not-required", "required-and-applied"]) {
      expect(compileFramework(reg(), { ...BASE, certifications: [cert({ migration: { state, migrationIds: [] } })], evidenceArtifactDigests: DIGESTS }).guarantees.certifications.size).toBe(1)
    }
  })

  it("skips evidence checks for unsupported and experimental certifications", () => {
    for (const status of ["unsupported", "experimental"]) {
      const c = cert({ status, migration: { state: "required-not-applied", migrationIds: [] } }, null)
      expect(compileFramework(reg(), { ...BASE, certifications: [c] }).guarantees.certifications.size).toBe(1)
    }
  })

  it("rejects duplicate certification keys and keeps different builds, packages and guarantees apart", () => {
    expect(failure(reg(), { certifications: [cert(), cert()], evidenceArtifactDigests: DIGESTS })).toBe("duplicate guarantee certification @a/pg:b1:audit.atomic")
    const keys = [
      cert(), cert({ guarantee: "outbox.atomic" }), cert({ adapter: { packageName: "@a/pg", packageVersion: "2.0.0", adapterBuildId: "b2" } }),
      cert({ adapter: { packageName: "@a/my", packageVersion: "2.0.0", adapterBuildId: "b1" } }),
    ]
    const plan = compileFramework(reg(), { ...BASE, certifications: keys, evidenceArtifactDigests: DIGESTS })
    expect([...plan.guarantees.certifications.keys()]).toEqual(["@a/pg:b1:audit.atomic", "@a/pg:b1:outbox.atomic", "@a/pg:b2:audit.atomic", "@a/my:b1:audit.atomic"])
  })
})

describe("required guarantees", () => {
  const ds = (extra: Partial<DatasourceDefinition> = {}): DatasourceDefinition => ({ kind: "datasource", key: "d", definitionVersion: 1, adapter: "@a/pg", capabilities: [], ...extra })
  const needy = (extra: Loose<FrameworkDefinition> = {}): FrameworkDefinition => ({ kind: "entity", key: "e", definitionVersion: 1, datasourceKey: "d", requiredGuarantees: ["audit.atomic"], ...extra } as FrameworkDefinition)
  const opts = (...certs: GuaranteeCertificationV1[]): Partial<CompileFrameworkOptions> => ({ certifications: certs, evidenceArtifactDigests: DIGESTS })
  const MISSING = "missing proven certification audit.atomic required by entity:e"

  it("records de-duplicated requirements per plan", () => {
    const plan = compileFramework(reg(ds(), needy({ requiredGuarantees: ["audit.atomic", "outbox.atomic", "audit.atomic"] })), { ...BASE, ...opts(cert(), cert({ guarantee: "outbox.atomic" })) })
    expect(plan.guarantees.requirementsByPlan.get("entity:e")).toEqual(["audit.atomic", "outbox.atomic"])
    expect(Object.isFrozen(plan.guarantees.requirementsByPlan.get("entity:e"))).toBe(true)
    expect(plan.guarantees.requirementsByPlan.size).toBe(1)
  })

  it("records nothing for an empty or absent requirement list", () => {
    const plan = compileFramework(reg(ds(), needy({ requiredGuarantees: [] }), { kind: "entity", key: "f", definitionVersion: 1 }), BASE)
    expect(plan.guarantees.requirementsByPlan.size).toBe(0)
  })

  it("requires a proven certification", () => {
    expect(failure(reg(ds(), needy()), opts())).toBe(MISSING)
    expect(failure(reg(ds(), needy()), opts(cert({ status: "unsupported" }, null)))).toBe(MISSING)
    expect(failure(reg(ds(), needy()), opts(cert({ status: "experimental" }, null)))).toBe(MISSING)
    expect(failure(reg(ds(), needy()), opts(cert({ guarantee: "outbox.atomic" })))).toBe(MISSING)
  })

  it("matches the datasource adapter package and build id", () => {
    const other = cert({ adapter: { packageName: "@a/my", packageVersion: "2.0.0", adapterBuildId: "b1" } })
    expect(failure(reg(ds(), needy()), opts(other))).toBe(MISSING)
    expect(failure(reg(ds({ adapterBuildId: "b1" }), needy()), opts(other))).toBe(MISSING)
    expect(failure(reg(ds({ adapterBuildId: "b9" }), needy()), opts(cert()))).toBe(MISSING)
    expect(compileFramework(reg(ds({ adapterBuildId: "b1" }), needy()), { ...BASE, ...opts(cert()) }).guarantees.requirementsByPlan.size).toBe(1)
    expect(compileFramework(reg(ds(), needy()), { ...BASE, ...opts(cert()) }).guarantees.requirementsByPlan.size).toBe(1)
    expect(compileFramework(reg(ds(), needy()), { ...BASE, ...opts(other, cert()) }).guarantees.requirementsByPlan.size).toBe(1)
  })

  it("accepts any proven certification when the definition has no datasource", () => {
    const registry = reg(needy({ datasourceKey: undefined }))
    expect(compileFramework(registry, { ...BASE, ...opts(cert()) }).guarantees.requirementsByPlan.get("entity:e")).toEqual(["audit.atomic"])
    expect(failure(reg(needy({ datasourceKey: undefined })), opts())).toBe(MISSING)
  })
})

describe("policies, readiness, ports and workers", () => {
  it("digests each compiled policy plan", () => {
    const plan = compileFramework(reg({ kind: "policy", key: "a", definitionVersion: 1, config: { allow: true } }, { kind: "policy", key: "b", definitionVersion: 2 }), BASE)
    expect([...plan.authorization.digests.keys()]).toEqual(["a", "b"])
    expect(plan.authorization.digests.get("a")).toBe(canonicalSha256Hex(plan.authorization.policies.get("a")))
    expect(plan.authorization.digests.get("b")).toBe(canonicalSha256Hex(plan.authorization.policies.get("b")))
    expect(plan.authorization.digests.get("a")).not.toBe(plan.authorization.digests.get("b"))
    expect(compileFramework(reg(), BASE).authorization.digests.size).toBe(0)
  })

  it("merges identical readiness requirements and rejects conflicting descriptions", () => {
    const ready = (key: string, readiness: { key: string; description: string }[]): FrameworkDefinition => ({ kind: "entity", key, definitionVersion: 1, readiness })
    const plan = compileFramework(reg(ready("a", [{ key: "db", description: "database" }, { key: "cache", description: "cache" }]), ready("b", [{ key: "db", description: "database" }])), BASE)
    expect(plan.readiness.requirements).toEqual([{ key: "db", description: "database" }, { key: "cache", description: "cache" }])
    expect(Object.isFrozen(plan.readiness.requirements)).toBe(true)
    expect(Object.isFrozen(plan.readiness.requirements[0])).toBe(true)
    expect(failure(reg(ready("a", [{ key: "db", description: "database" }]), ready("b", [{ key: "db", description: "other" }])))).toBe("conflicting readiness requirement db")
  })

  it("merges identical port requirements and rejects conflicting ones", () => {
    const ports = (key: string, requiredPorts: { key: string; capability: string; optional?: boolean }[]): FrameworkDefinition => ({ kind: "entity", key, definitionVersion: 1, requiredPorts })
    const plan = compileFramework(reg(ports("a", [{ key: "clock", capability: "clock" }, { key: "mail", capability: "smtp", optional: true }]), ports("b", [{ key: "clock", capability: "clock", optional: false }, { key: "mail", capability: "smtp", optional: true }])), BASE)
    expect(plan.runtimeBindings.requiredPorts).toEqual([{ key: "clock", capability: "clock", optional: false }, { key: "mail", capability: "smtp", optional: true }])
    expect(Object.isFrozen(plan.runtimeBindings.requiredPorts)).toBe(true)
    expect(Object.isFrozen(plan.runtimeBindings.requiredPorts[0])).toBe(true)
    expect(failure(reg(ports("a", [{ key: "clock", capability: "clock" }]), ports("b", [{ key: "clock", capability: "other" }])))).toBe("conflicting runtime port clock")
    expect(failure(reg(ports("a", [{ key: "clock", capability: "clock" }]), ports("b", [{ key: "clock", capability: "clock", optional: true }])))).toBe("conflicting runtime port clock")
    expect(failure(reg(ports("a", [{ key: "clock", capability: "clock", optional: true }]), ports("b", [{ key: "clock", capability: "clock" }])))).toBe("conflicting runtime port clock")
    expect(compileFramework(reg(ports("a", [{ key: "x", capability: "c", optional: "yes" as never }])), BASE).runtimeBindings.requiredPorts).toEqual([{ key: "x", capability: "c", optional: false }])
  })

  it("binds workers for consumers, jobs, schedules and workflows only", () => {
    const defs = (["entity", "consumer", "operation", "job", "schedule", "readModel", "workflow", "event"] as const).map(kind => ({ kind, key: `k-${kind}`, definitionVersion: 1 }) as FrameworkDefinition)
    const plan = compileFramework(reg(...defs), BASE)
    expect(plan.runtimeBindings.workerBindings).toEqual([
      { key: "k-consumer", definitionKey: "consumer:k-consumer", kind: "consumer" }, { key: "k-job", definitionKey: "job:k-job", kind: "job" },
      { key: "k-schedule", definitionKey: "schedule:k-schedule", kind: "schedule" }, { key: "k-workflow", definitionKey: "workflow:k-workflow", kind: "workflow" },
    ])
    expect(Object.isFrozen(plan.runtimeBindings.workerBindings)).toBe(true)
    expect(Object.isFrozen(plan.runtimeBindings.workerBindings[0])).toBe(true)
  })

  it("groups compiled definitions by kind and seals the registry", () => {
    const defs = (["entity", "operation", "readModel", "event", "consumer", "job", "schedule", "workflow"] as const).map(kind => ({ kind, key: `k-${kind}`, definitionVersion: 1 }) as FrameworkDefinition)
    const registry = reg(...defs, { kind: "delegationRule", key: "dr", definitionVersion: 1, fromKinds: [], toKinds: [], capabilities: [] } as DelegationRuleDefinition, policy("p"))
    const plan = compileFramework(registry, BASE)
    const keys = (m: ReadonlyMap<string, unknown>): string[] => [...m.keys()]
    expect(keys(plan.definitions.entities)).toEqual(["k-entity"])
    expect(keys(plan.definitions.operations)).toEqual(["k-operation"])
    expect(keys(plan.definitions.readModels)).toEqual(["k-readModel"])
    expect(keys(plan.definitions.events)).toEqual(["k-event"])
    expect(keys(plan.definitions.consumers)).toEqual(["k-consumer"])
    expect(keys(plan.definitions.jobs)).toEqual(["k-job"])
    expect(keys(plan.definitions.schedules)).toEqual(["k-schedule"])
    expect(keys(plan.definitions.workflows)).toEqual(["k-workflow"])
    expect(keys(plan.authority.delegationRules)).toEqual(["dr"])
    expect(keys(plan.authorization.policies)).toEqual(["p"])
    expect(plan.runtimeBindings.startupOrder).toHaveLength(10)
    expect(registry.state).toBe("SEALED")
    expect(Object.isFrozen(plan.definitions.entities.get("k-entity"))).toBe(true)
  })
})
