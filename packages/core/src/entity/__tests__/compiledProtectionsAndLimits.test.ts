import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import { validateQueryPlan } from "../../query/queryBudget"
import { defineEntity } from "../defineEntity"
import { validateEntity } from "../validateEntity"

const schema = { parse: (value: unknown) => value, parseAsync: async (value: unknown) => value } as never

function base() {
  return {
    moduleKey: "tenant.people",
    entity: {
      name: "person",
      primaryKey: "id" as const,
      tenantField: "tenantId" as const,
      versionField: "version" as const,
      fields: {
        id: { type: "string" as const },
        tenantId: { type: "string" as const },
        name: { type: "string" as const },
        ssn: { type: "string" as const, classification: "restricted" as const },
        email: { type: "string" as const, classification: "confidential" as const },
        version: { type: "number" as const },
      },
    },
    entityScope: { kind: "tenant" as const },
    policy: { skipCapabilityCheck: true as const },
    validation: { createBody: schema, updateBody: schema },
    audit: false as const,
    cache: false as const,
  }
}

function applicationBase() {
  const { tenantField: _tenantField, ...entity } = base().entity
  return {
    ...base(),
    moduleKey: "apps.records",
    entity: { ...entity, name: "record", fields: { ...entity.fields, appId: { type: "string" as const } } },
    entityScope: { kind: "application" as const, field: "appId" as const },
  }
}

describe("application scope column protection", () => {
  it("compiles the application partition column as an immutable, protected field", () => {
    const compiled = defineEntity<Record<string, unknown>>(applicationBase())
    expect(compiled.compiledScope).toEqual({ kind: "application", field: "appId" })
    expect(compiled.entity.immutableFields).toContain("appId")
    expect(compiled.compiledFieldProtections.immutable).toContain("appId")
  })

  it("keeps declared immutable and lifecycle fields alongside the scope column", () => {
    const compiled = defineEntity<Record<string, unknown>>({
      ...applicationBase(),
      entity: { ...applicationBase().entity, immutableFields: ["name"] },
    })
    expect([...compiled.compiledFieldProtections.immutable].sort()).toEqual(["appId", "name"])
  })
})

describe("compiled query budget", () => {
  it("compiles a strict budget from declared limits without non-budget keys", () => {
    const compiled = defineEntity<Record<string, unknown>>({
      ...base(),
      queryLimits: { maxOffset: 500, maxCount: 1000, maxSearchableColumns: 2, maxSortFields: 3 },
    })
    expect(compiled.compiledQuery.budget.maxSortFields).toBe(3)
    expect(Object.keys(compiled.compiledQuery.budget)).not.toContain("maxOffset")
    // The compiled budget must be accepted by the strict query validator.
    expect(() => validateQueryPlan({ sort: [{ field: "name", direction: "asc" }] }, compiled.compiledQuery.budget)).not.toThrow()
    expect(compiled.compiledPagination.maxOffset).toBe(500)
    expect(compiled.compiledQuery.maxCount).toBe(1000)
    expect(compiled.compiledQuery.maxSearchableColumns).toBe(2)
  })

  it("rejects unknown query limit keys as configuration errors", () => {
    expect(() => defineEntity<Record<string, unknown>>({
      ...base(),
      queryLimits: { maxOffset: 10, maxFilterJsonBytes: 10 } as never,
    })).toThrow(ConfigurationError)
    expect(() => defineEntity<Record<string, unknown>>({
      ...base(),
      queryLimits: { maxPredicateDepht: 3 } as never,
    })).toThrow(/unknown query limit/)
  })
})

describe("audit classification merge", () => {
  it("never weakens classification-derived redaction with an explicit audit map", () => {
    const compiled = defineEntity<Record<string, unknown>>({
      ...base(),
      audit: { fieldClassification: { name: "mask", ssn: "include", email: "omit" } },
    })
    expect(compiled.compiledAudit.fieldClassification).toEqual({ ssn: "omit", email: "omit", name: "mask" })
    expect(compiled.audit !== false && compiled.audit.fieldClassification).toEqual({ ssn: "omit", email: "omit", name: "mask" })
  })

  it("keeps classification-derived entries when only some fields are declared explicitly", () => {
    const compiled = defineEntity<Record<string, unknown>>({
      ...base(),
      audit: { fieldClassification: { name: "include" } },
    })
    expect(compiled.compiledAudit.fieldClassification).toEqual({ ssn: "omit", email: "mask", name: "include" })
  })
})

describe("cache namespace defaults", () => {
  it("namespaces default cache key prefix and tag by module", () => {
    const a = defineEntity<Record<string, unknown>>({ ...base(), cache: {} })
    const b = defineEntity<Record<string, unknown>>({ ...base(), moduleKey: "billing.people", cache: {} })
    if (a.cache === false || b.cache === false) throw new Error("cache expected")
    expect(a.cache.keyPrefix).not.toBe(b.cache.keyPrefix)
    expect(a.cache.tag).not.toBe(b.cache.tag)
    // Defaults carry the reserved "entity:" prefix so they can never be a tenant-owned tag ("tenant:<len>:<id>").
    expect(a.cache.keyPrefix).toBe("entity:tenant.people:person")
    expect(a.cache.tag).toBe("entity:tenant.people:person")
  })

  it("qualifies default cache and idempotency namespaces by the entity's persistence namespace", () => {
    const a = defineEntity<Record<string, unknown>>({ ...base(), entity: { ...base().entity, namespace: "a" }, cache: {} })
    const b = defineEntity<Record<string, unknown>>({ ...base(), entity: { ...base().entity, namespace: "b" }, cache: {} })
    if (a.cache === false || b.cache === false) throw new Error("cache expected")
    expect(a.cache.tag).not.toBe(b.cache.tag)
    // Regression: the idempotency default was `${moduleKey}:${name}`, shared by both entities.
    expect(a.compiledIdempotency.namespace).toBe("tenant.people:a:person")
    expect(b.compiledIdempotency.namespace).toBe("tenant.people:b:person")
  })

  it("rejects explicit cache tags in the reserved tenant tag namespace", () => {
    expect(() => defineEntity<Record<string, unknown>>({ ...base(), cache: { tag: "tenant:1:x", keyPrefix: "p" } })).toThrow(/reserved "tenant:" prefix/)
  })

  it("keeps explicit cache configuration unchanged", () => {
    const compiled = defineEntity<Record<string, unknown>>({ ...base(), cache: { tag: "people", keyPrefix: "people-v2" } })
    expect(compiled.cache).toEqual({ tag: "people", keyPrefix: "people-v2" })
  })
})

describe("custom durable codec fields", () => {
  const codec = { key: "money", encode: (value: unknown) => String(value), decode: (value: unknown) => Number(value) }
  const withCustom = (codecs: Record<string, unknown>) => ({
    ...base(),
    entity: { ...base().entity, fields: { ...base().entity.fields, amount: { type: "custom" as const, durableCodec: "money" } } },
    durableCodecs: codecs as never,
  })

  it("fails closed until codecs are applied by the persistence mapping", () => {
    expect(() => defineEntity<Record<string, unknown>>(withCustom({ money: codec }))).toThrow(ConfigurationError)
    expect(() => defineEntity<Record<string, unknown>>(withCustom({ money: codec }))).toThrow(/not yet supported/)
  })

  it("requires encode/decode functions, not just a truthy registry entry", () => {
    expect(() => validateEntity(withCustom({ money: { key: "money" } }) as never, {} as never)).toThrow(/registered durable codec/)
  })
})

describe("default sort classification", () => {
  it("rejects a default sort column hidden by data classification", () => {
    expect(() => defineEntity<Record<string, unknown>>({
      ...base(),
      sortableColumns: ["name", "ssn"],
      listDefaults: { sortColumn: "ssn" },
    })).toThrow(ConfigurationError)
  })

  it("rejects a hidden default sort when validateEntity runs on an uncompiled definition", () => {
    expect(() => validateEntity({ ...base(), sortableColumns: ["name", "ssn"], listDefaults: { sortColumn: "ssn" } } as never, {} as never)).toThrow(/default sort/)
  })

  it("accepts a queryable default sort column", () => {
    expect(() => defineEntity<Record<string, unknown>>({
      ...base(),
      sortableColumns: ["name", "email"],
      listDefaults: { sortColumn: "email" },
    })).not.toThrow()
  })
})
