import manifest from "../../package.json"
import { describe, expect, it } from "vitest"

const approvedSubpathExports = {
  "./bootstrap": "bootstrap", "./domain": "domain", "./entity": "entity", "./execution": "execution",
  "./events": "events", "./operation": "operation", "./persistence": "persistence",
  "./query": "query", "./read-model": "read-model", "./security": "security", "./serialization": "serialization",
  "./storage": "storage", "./workflow": "workflow", "./kernel": "kernel", "./cache": "cache",
  "./rate-limit": "rate-limit", "./telemetry": "telemetry", "./quota": "quota",
  "./resilience": "resilience", "./object-store": "object-store", "./health": "health",
  "./secrets": "secrets", "./feature-flags": "feature-flags", "./business-calendar": "business-calendar",
} as const

describe("packages/core package exports", () => {
  it("exposes built runtime consumers with matching type declarations", () => {
    for (const [subpath, sourcePath] of Object.entries(approvedSubpathExports) as [keyof typeof approvedSubpathExports, string][]) {
      expect(manifest.exports[subpath]).toEqual({
        types: `./dist/${sourcePath}/index.d.ts`,
        default: `./dist/${sourcePath}/index.js`,
      })
    }
  })

  it("exposes the operation entry point with matching type declarations", () => {
    expect(manifest.exports["./operation"]).toEqual({
      types: "./dist/operation/index.d.ts",
      default: "./dist/operation/index.js",
    })
  })

  it("does not expose operation implementation subpaths", () => {
    for (const subpath of [
      "./operation/operationEffectCollector",
      "./operation/operationRunContext",
      "./operation/standardOperationPipeline",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(manifest.exports, subpath)).toBe(false)
    }
  })

  it("keeps operation contexts and entity brands out of public barrels", async () => {
    const operation = await import("../index")
    const entity = await import("../entity")
    expect(operation).not.toHaveProperty("OperationRunContext")
    expect(operation).not.toHaveProperty("ReadOperationContext")
    expect(entity).not.toHaveProperty("ENTITY_DEFINITION_BRAND")
    expect(entity).not.toHaveProperty("COMPILED_ENTITY_DEFINITION_BRAND")
    expect(entity).toHaveProperty("compileEntity")
  }, 10_000)

  it("does not expose the removed compatibility entry point", () => {
    expect(Object.prototype.hasOwnProperty.call(manifest.exports, "./compat")).toBe(false)
  })

  it("keeps domain-owned concepts out of the kernel public surface", async () => {
    const kernel = await import("../kernel")
    expect(kernel).toHaveProperty("cloneAndFreezeDefinition")
    for (const symbol of ["FrameworkError", "ExecutionScope", "Principal", "Authority", "RequestContext"]) {
      expect(kernel).not.toHaveProperty(symbol)
    }
  })
})
