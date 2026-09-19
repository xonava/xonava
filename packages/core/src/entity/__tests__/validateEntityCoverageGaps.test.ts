import { describe, expect, it } from "vitest"
import { ConfigurationError, ValidationError } from "../../domain"
import { validateEntity } from "../validateEntity"

const schema = {} as never
const routes = { list: true, detail: true, create: true, update: true, delete: true }
function base() {
  return {
    moduleKey: "tenant.people",
    entity: { name: "person", primaryKey: "id", tenantField: "tenantId", versionField: "version", fields: {
      id: { type: "string" }, tenantId: { type: "string" }, version: { type: "number" }, name: { type: "string" }, createdBy: { type: "string" },
    } },
    entityScope: { kind: "tenant" as const }, policy: { skipCapabilityCheck: true as const }, validation: { createBody: schema, updateBody: schema },
  }
}
function expectInvalid(overrides: Record<string, unknown>, message?: string) {
  const input = { ...base(), ...overrides, entity: { ...base().entity, ...(overrides.entity as object | undefined) }, validation: { ...base().validation, ...(overrides.validation as object | undefined) } } as never
  expect(() => validateEntity(input, routes)).toThrow(ConfigurationError)
  if (message) expect(() => validateEntity(input, routes)).toThrow(message)
}

describe("validateEntity uncovered configuration paths", () => {
  it.each([
    [{ entity: { name: "bad name" } }, "invalid name"],
    [{ entity: { fields: {} } }, "must declare fields"],
    [{ entity: { primaryKey: "missing" } }, "unknown primary key"],
    [{ entity: { versionField: "name" } }, "type \"number\""],
    [{ entity: { immutableFields: ["name", "name"] } }, "duplicate immutable"],
    [{ searchableColumns: ["unknown"] }, "unknown searchable"],
    [{ filterableColumns: ["unknown"] }, "unknown filterable"],
    [{ sortableColumns: ["name", "name"] }, "duplicate sortable"],
    [{ sortableColumns: ["unknown"] }, "unknown sortable"],
    [{ sortableColumns: ["name", 42 as never] }, "invalid sortable"],
    [{ policy: { skipCapabilityCheck: true, customCapabilityKey: "manage" } }, "capability"],
    [{ policy: { customCapabilityKey: "bad key" } }, "capability key"],
    [{ listDefaults: { sortColumn: "unknown" } }, "unknown default sort"],
    [{ listDefaults: { sortDesc: "yes" } }, "sort direction"],
    [{ optimisticConcurrency: { versionField: "name" } }, "type \"number\""],
    [{ audit: { enabled: true } }, "without enabled"],
    [{ cache: { enabled: true, tag: "tag" } }, "without enabled"],
  ] as const)("rejects %s", (overrides, message) => expectInvalid(overrides, message))

  it("rejects concurrency conflicts, missing scopes, and enabled-route schemas", () => {
    expectInvalid({ optimisticConcurrency: { versionField: "name" }, entity: { versionField: "version", fields: { ...base().entity.fields, name: { type: "number" } } } }, "conflicting")
    expectInvalid({ entity: { tenantField: undefined }, entityScope: { kind: "tenant" } }, "no tenantField")
    expectInvalid({ validation: { createBody: undefined } }, "enables create")
    expect(() => validateEntity({ ...base(), validation: { createBody: schema, updateBody: undefined } } as never, { ...routes, update: true })).toThrow("enables update")
  })

  it("accepts an acknowledged global entity with disabled write routes", () => {
    const input = { ...base(), entity: { ...base().entity, tenantField: undefined, versionField: undefined }, entityScope: { kind: "platform", acknowledged: true }, listDefaults: { sortColumn: "name" } }
    expect(() => validateEntity(input as never, { list: false, detail: false, create: false, update: false, delete: false })).not.toThrow()
  })

  it("accepts disabled write routes and valid rate limits", () => {
    expect(() => validateEntity({ ...base(), rateLimit: {
       list: { max: 1, timeWindow: 1, consistency: "best-effort" }, detail: { max: 1, timeWindow: "2 minutes", consistency: "best-effort" }, create: { max: 1, timeWindow: "1 hour", consistency: "best-effort" },
    } } as never, { ...routes, create: false, update: false })).not.toThrow()
    expectInvalid({ rateLimit: { list: { max: 1, timeWindow: 0, consistency: "best-effort" } } }, "window")
    expectInvalid({ rateLimit: { list: { max: 1, timeWindow: "0 minutes", consistency: "best-effort" } } }, "window")
    expectInvalid({ rateLimit: { archive: { max: 1, timeWindow: 1, consistency: "best-effort" } } }, "route")
  })

  it("accepts concurrency using the entity version field", () => {
    expect(() => validateEntity({ ...base(), optimisticConcurrency: { versionField: "version" } } as never, routes)).not.toThrow()
  })

  it("requires the default sort column to be declared in sortableColumns", () => {
    expect(() => validateEntity({ ...base(), sortableColumns: ["name"], listDefaults: { sortColumn: "createdBy" } } as never, routes)).toThrow(ValidationError)
    expect(() => validateEntity({ ...base(), sortableColumns: ["name"], listDefaults: { sortColumn: "name" } } as never, routes)).not.toThrow()
  })

  it("rejects unacknowledged global scope and inconsistent tenant declarations", () => {
    expectInvalid({ entity: { tenantField: undefined }, entityScope: { kind: "platform" } }, "acknowledge")
    expectInvalid({ entityScope: { kind: "platform", acknowledged: true } }, "declares tenantField")
  })

  it("rejects malformed rate-limit maxima and accepts disabled route schemas", () => {
    expectInvalid({ rateLimit: { list: { max: 0, timeWindow: "1 minute", consistency: "best-effort" } } }, "rate-limit max")
    expectInvalid({ rateLimit: { list: { max: 1.5, timeWindow: "1 minute", consistency: "best-effort" } } }, "rate-limit max")
    expectInvalid({ rateLimit: { list: { max: 1, timeWindow: "1 minute", consistency: "best-effort", algorithm: "unknown" } } }, "rate-limit algorithm")
    expectInvalid({ rateLimit: { list: { max: 1, timeWindow: "1 minute", consistency: "best-effort", cost: 0 } } }, "rate-limit cost")
    expect(() => validateEntity({ ...base(), validation: {} } as never, { ...routes, create: false, update: false })).not.toThrow()
  })
})
