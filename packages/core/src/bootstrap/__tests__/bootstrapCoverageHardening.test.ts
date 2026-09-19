import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain/errors"
import type { CompiledFrameworkPlan } from "../compiledPlan"
import type { CompiledRouteBinding } from "../compiledRouteBinding"
import { compiledRouteBindingRef } from "../compiledRouteBinding"
import type { FrameworkDefinition } from "../definition"
import { FrameworkDefinitionRegistry } from "../definitionRegistry"
import { definitionId, resolveDependencyOrder } from "../dependencyGraph"
import { assertFrameworkReady, requiredReadinessKeys } from "../readiness"
import { FrameworkRuntimeRegistry } from "../runtimeRegistry"
import { compileFramework } from "../compiler"

const definition = (
  key: string,
  references: FrameworkDefinition["references"] = [],
  definitionVersion = 1,
): FrameworkDefinition => ({ kind: "entity", key, definitionVersion, references })

const runtimePlan = (): CompiledFrameworkPlan => ({
  readiness: { requirements: [{ key: "database", description: "database migrated" }] },
  runtimeBindings: {
    requiredPorts: [
      { key: "clock", capability: "clock", optional: false },
      { key: "telemetry", capability: "telemetry", optional: true },
    ],
    workerBindings: [],
    startupOrder: [],
  },
} as unknown as CompiledFrameworkPlan)

describe("bootstrap boundary hardening", () => {
  it("validates compiled route binding identities and freezes references", () => {
    const route = { routeKey: "orders.create", definitionVersion: 2, operationKey: "create-order" } as CompiledRouteBinding
    const ref = compiledRouteBindingRef(route)
    expect(ref).toEqual({ routeKey: "orders.create", definitionVersion: 2, operationKey: "create-order" })
    expect(Object.isFrozen(ref)).toBe(true)
    expect(() => compiledRouteBindingRef({ ...route, routeKey: " " })).toThrow(/identity is invalid/)
    expect(() => compiledRouteBindingRef({ ...route, definitionVersion: 0 })).toThrow(/identity is invalid/)
    expect(() => compiledRouteBindingRef({ ...route, definitionVersion: 1.5 })).toThrow(/identity is invalid/)
    expect(() => compiledRouteBindingRef({ ...route, operationKey: " " })).toThrow(/operation identity is invalid/)
  })

  it("reports readiness requirements without exposing mutable plan state", () => {
    const plan = runtimePlan()
    expect([...requiredReadinessKeys(plan)]).toEqual(["database"])
    expect(() => assertFrameworkReady(plan, new Set())).toThrow(/missing: database/)
    expect(() => assertFrameworkReady(plan, new Set(["database"]))).not.toThrow()
  })

  it("fails closed throughout runtime binding and readiness", () => {
    const registry = new FrameworkDefinitionRegistry()
    registry.transition("OPEN", "NORMALIZING")
    registry.transition("NORMALIZING", "RESOLVING")
    registry.transition("RESOLVING", "COMPILING")
    registry.transition("COMPILING", "SEALED")
    const runtime = new FrameworkRuntimeRegistry(runtimePlan(), registry)

    expect(() => runtime.get("clock")).toThrow(/not READY/)
    expect(() => runtime.bind(" ", {})).toThrow(/non-empty/)
    expect(() => runtime.bind("clock", null)).toThrow(/provide a value/)
    expect(() => runtime.ready(new Set(["database"]))).toThrow(/missing runtime binding clock/)
    runtime.bind("clock", { now: 1 })
    expect(() => runtime.bind("clock", {})).toThrow(/duplicate/)
    expect(() => runtime.ready()).toThrow(/readiness/)
    runtime.ready(new Set(["database"]))
    expect(runtime.get<{ now: number }>("clock")).toEqual({ now: 1 })
    expect(() => runtime.get("telemetry")).toThrow(/unknown runtime binding/)
    expect(() => runtime.bind("late", {})).toThrow(/bindings are sealed/)
    expect(registry.state).toBe("READY")
  })

  it("enforces definition identity, uniqueness, immutable snapshots, and legal state changes", () => {
    const registry = new FrameworkDefinitionRegistry()
    expect(() => registry.register({ kind: "unknown", key: "x", definitionVersion: 1 } as never)).toThrow(ConfigurationError)
    expect(() => registry.register(definition(" bad"))).toThrow(ConfigurationError)
    expect(() => registry.register(definition("bad key"))).toThrow(ConfigurationError)
    expect(() => registry.register(definition("bad", [], 0))).toThrow(ConfigurationError)
    const original = definition("orders")
    registry.register(original)
    expect(() => registry.register(original)).toThrow(/duplicate definition/)
    const snapshot = registry.snapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0])).toBe(true)
    expect(() => registry.transition("RESOLVING", "COMPILING")).toThrow(/expected RESOLVING, found OPEN/)
    expect(() => registry.transition("OPEN", "SEALED")).toThrow(/illegal registry transition/)
    registry.transition("OPEN", "NORMALIZING")
    expect(() => registry.register(definition("late"))).toThrow(/registration is closed/)
  })

  it("orders dependency graphs and rejects missing, stale, and unsafe cyclic references", () => {
    expect(definitionId(definition("orders"))).toBe("entity:orders")
    expect(resolveDependencyOrder([
      definition("operation", [{ kind: "entity", key: "orders" }]),
      definition("orders"),
    ])).toEqual(["entity:orders", "entity:operation"])
    expect(() => resolveDependencyOrder([definition("a", [{ kind: "entity", key: "missing" }])])).toThrow(/missing definition reference/)
    expect(() => resolveDependencyOrder([
      definition("a", [{ kind: "entity", key: "b", minimumVersion: 2 }]),
      definition("b"),
    ])).toThrow(/below required 2/)
    expect(() => resolveDependencyOrder([
      definition("a", [{ kind: "entity", key: "b" }]),
      definition("b", [{ kind: "entity", key: "a" }]),
    ])).toThrow(/unsupported definition dependency cycle/)
    expect(resolveDependencyOrder([
      definition("a", [{ kind: "entity", key: "b", allowCycle: true }]),
      definition("b", [{ kind: "entity", key: "a", allowCycle: true }]),
    ])).toEqual(["entity:b", "entity:a"])
  })

  it.each([
    [{ formatId: "framework.unknown", readableVersions: [1] }, /missing durable format/],
    [{ formatId: "framework.event-envelope", readableVersions: [2] }, /reader incompatibility/],
    [{ formatId: "framework.event-envelope", readableVersions: [1], writableVersion: 2 }, /writer incompatibility/],
  ] as const)("rejects incompatible required durable formats", (requirement, message) => {
    const registry = new FrameworkDefinitionRegistry()
    registry.register({ kind: "entity", key: "orders", definitionVersion: 1, requiredFormats: [requirement] })
    expect(() => compileFramework(registry, { frameworkVersion: "2", sourceRevision: "test" })).toThrow(message)
  })

  it("rejects public routes whose scope is fixed at startup", () => {
    const registry = new FrameworkDefinitionRegistry()
    registry.register({ kind: "policy", key: "orders.read", definitionVersion: 1 })
    registry.register({ kind: "operation", key: "read-orders", definitionVersion: 1, policyKey: "orders.read" })
    registry.register({
      kind: "route", key: "read-orders", definitionVersion: 1, method: "GET", path: "/orders",
      operationKey: "read-orders", exposure: "public", authorizationPlanKey: "orders.read",
      scopeResolution: { kind: "fixed", scope: { kind: "tenant", tenantId: "tenant-1" } },
    })
    expect(() => compileFramework(registry, { frameworkVersion: "2", sourceRevision: "test" })).toThrow(/public route .* must use resolver/)
  })
})
