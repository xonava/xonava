import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import { compileEntity } from "../compileEntity"
import { defineEntity } from "../defineEntity"
import { validateEntity } from "../validateEntity"

const schema = { parse: (value: unknown) => value } as never

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
  }
}

describe("entity configuration hardening", () => {
  it("strips restricted fields from filterable and sortable fields, as for searchable", () => {
    const compiled = compileEntity(defineEntity({
      ...base(),
      filterableColumns: ["name", "ssn", "email"],
      sortableColumns: ["name", "ssn", "email"],
      searchableColumns: ["name", "ssn", "email"],
    } as never))
    expect(compiled.compiledQuery.searchableFields).toEqual(["name", "email"])
    expect(compiled.compiledQuery.filterableFields).toEqual(["name", "email"])
    expect(compiled.compiledQuery.sortableFields).toEqual(["name", "email"])
  })

  it("reports a default sort column outside sortableColumns as a ConfigurationError", () => {
    expect(() => validateEntity({ ...base(), sortableColumns: ["name"], listDefaults: { sortColumn: "id" } } as never, {} as never)).toThrow(ConfigurationError)
  })

  it("does not resolve durable codecs through the prototype chain", () => {
    const input = { ...base(), entity: { ...base().entity, fields: { ...base().entity.fields, blob: { type: "custom" as const, durableCodec: "toString" } } }, durableCodecs: {} }
    expect(() => validateEntity(input as never, {} as never)).toThrow(/registered durable codec/)
  })
})
