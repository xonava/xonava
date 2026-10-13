import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import { assertUniqueEntityCachePrefixes } from "../cachePrefixes"
import { defineEntity } from "../defineEntity"

const schema = { parse: (value: unknown) => value, parseAsync: async (value: unknown) => value } as never

function entity(moduleKey: string, name: string, cache: false | { keyPrefix?: string; tag?: string }) {
  return defineEntity<Record<string, unknown>>({
    moduleKey,
    entity: { name, primaryKey: "id" as const, tenantField: "tenantId" as const, versionField: "version" as const, fields: { id: { type: "string" as const }, tenantId: { type: "string" as const }, version: { type: "number" as const } } },
    entityScope: { kind: "tenant" as const },
    policy: { skipCapabilityCheck: true as const },
    validation: { createBody: schema, updateBody: schema },
    audit: false as const,
    cache,
  })
}

describe("application-wide entity cache prefix uniqueness", () => {
  it("rejects two entities that set the same explicit key prefix, naming both", () => {
    const a = entity("mod.a", "orders", { keyPrefix: "shared" })
    const b = entity("mod.b", "invoices", { keyPrefix: "shared" })
    const check = () => assertUniqueEntityCachePrefixes([a, b])
    expect(check).toThrow(ConfigurationError)
    expect(check).toThrow(/mod\.a:orders.*mod\.b:invoices.*"shared"/)
  })

  it("rejects an explicit prefix equal to another entity's default prefix", () => {
    const a = entity("mod.a", "orders", {})
    const b = entity("mod.b", "invoices", { keyPrefix: "entity:mod.a:orders" })
    expect(() => assertUniqueEntityCachePrefixes([a, b])).toThrow(/mod\.a:orders.*mod\.b:invoices/)
  })

  it("accepts distinct prefixes, module-namespaced defaults, and entities without a cache", () => {
    expect(() => assertUniqueEntityCachePrefixes([
      entity("mod.a", "orders", {}),
      entity("mod.b", "orders", {}),
      entity("mod.a", "invoices", { keyPrefix: "invoices" }),
      entity("mod.a", "audit", false),
      entity("mod.b", "audit", false),
    ])).not.toThrow()
  })
})
