import { describe, expect, it } from "vitest"
import { FrameworkDefinitionRegistry } from "../definitionRegistry"
import { compileFramework } from "../compiler"
import { resolveDependencyOrder } from "../dependencyGraph"
import type { FrameworkDefinition } from "../definition"

const options = { frameworkVersion: "2", sourceRevision: "x", compiledAt: "2026-09-10T00:00:00.000Z" }

function routes(...entries: Array<{ key: string; method: string; path: string }>): FrameworkDefinitionRegistry {
  const registry = new FrameworkDefinitionRegistry()
  registry.register({ kind: "policy", key: "p", definitionVersion: 1, config: {} })
  registry.register({ kind: "operation", key: "op", definitionVersion: 1, policyKey: "p" })
  for (const entry of entries) registry.register({ kind: "route", definitionVersion: 1, operationKey: "op", exposure: "internal", scopeResolution: { kind: "fixed", scope: { kind: "application", applicationKey: "app" } }, ...entry } as never)
  return registry
}

describe("bootstrap compiler second review", () => {
  it("returns the registry to OPEN after a failed compile so a corrected compile succeeds", () => {
    const registry = new FrameworkDefinitionRegistry()
    registry.register({ kind: "entity", key: "secured", definitionVersion: 1, requiredCapabilities: ["db"] })
    expect(() => compileFramework(registry, options)).toThrow(/missing capability/)
    expect(registry.state).toBe("OPEN")
    registry.register({ kind: "entity", key: "late", definitionVersion: 1 })
    expect(compileFramework(registry, { ...options, availableCapabilities: ["db"] }).runtimeBindings.startupOrder).toEqual(["entity:secured", "entity:late"])
    expect(registry.state).toBe("SEALED")
  })

  it("rejects two entities that resolve to the same explicit cache key prefix, naming both", () => {
    const entity = (key: string, keyPrefix: string): FrameworkDefinition => ({ kind: "entity", key, definitionVersion: 1, config: { cache: { tag: key, keyPrefix } } })
    const clash = new FrameworkDefinitionRegistry()
    clash.register(entity("orders", "shared"))
    clash.register(entity("invoices", "shared"))
    expect(() => compileFramework(clash, options)).toThrow(/entity:orders.*entity:invoices.*"shared"/)
    const ok = new FrameworkDefinitionRegistry()
    ok.register(entity("orders", "orders"))
    ok.register(entity("invoices", "invoices"))
    ok.register({ kind: "entity", key: "uncached", definitionVersion: 1 })
    expect(compileFramework(ok, options).definitions.entities.size).toBe(3)
  })

  it("rejects ambiguous routes, including parameter renames", () => {
    expect(() => compileFramework(routes({ key: "a", method: "GET", path: "/orders/:id" }, { key: "b", method: "get", path: "/orders/:orderId" }), options)).toThrow(/routes a and b both handle GET/)
    expect(compileFramework(routes({ key: "a", method: "GET", path: "/orders/:id" }, { key: "b", method: "DELETE", path: "/orders/:id" }), options).routes.size).toBe(2)
  })

  it("rejects unsupported methods and malformed path templates", () => {
    expect(() => compileFramework(routes({ key: "a", method: "TRACE", path: "/x" }), options)).toThrow(/unsupported HTTP method/)
    for (const path of ["orders", "/orders/", "/a//b", "/a/../b", "/a b", "/a?x=1", "/:1bad", "/:id/:id"]) {
      expect(() => compileFramework(routes({ key: "a", method: "GET", path }), options), path).toThrow(/route a/)
    }
    expect(compileFramework(routes({ key: "a", method: "GET", path: "/" }), options).routes.get("a")?.pathTemplate).toBe("/")
  })

  it("resolves very long dependency chains without exhausting the stack", () => {
    const chain: FrameworkDefinition[] = Array.from({ length: 50_000 }, (_, index) => ({ kind: "entity", key: `e${index}`, definitionVersion: 1, ...(index > 0 ? { references: [{ kind: "entity", key: `e${index - 1}` }] } : {}) }) as FrameworkDefinition)
    const order = resolveDependencyOrder([...chain].reverse())
    expect(order[0]).toBe("entity:e0")
    expect(order.at(-1)).toBe("entity:e49999")
  })

  it("still rejects cycles unless every edge allows them", () => {
    const a = { kind: "entity", key: "a", definitionVersion: 1, references: [{ kind: "entity", key: "b" }] } as FrameworkDefinition
    const b = { kind: "entity", key: "b", definitionVersion: 1, references: [{ kind: "entity", key: "a" }] } as FrameworkDefinition
    expect(() => resolveDependencyOrder([a, b])).toThrow(/cycle/)
    const allowed = [{ ...a, references: [{ kind: "entity", key: "b", allowCycle: true }] }, { ...b, references: [{ kind: "entity", key: "a", allowCycle: true }] }] as FrameworkDefinition[]
    expect(resolveDependencyOrder(allowed)).toHaveLength(2)
  })
})
