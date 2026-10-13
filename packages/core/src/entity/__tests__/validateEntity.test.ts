import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import type { CapabilityCheckConfig } from "../capabilityCheck"
import { validateEntity } from "../validateEntity"

const schema = {} as never

function validInput() {
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
        version: { type: "number" as const },
      },
    },
    entityScope: { kind: "tenant" as const },
    policy: { skipCapabilityCheck: true as const },
    validation: { createBody: schema, updateBody: schema },
  }
}

describe("validateEntity", () => {
  it("requires an explicit capability policy at the type level", () => {
    const customCapabilityPolicy: CapabilityCheckConfig = { customCapabilityKey: "manage" }
    const skippedCapabilityPolicy: CapabilityCheckConfig = { skipCapabilityCheck: true }
    expect(customCapabilityPolicy).toEqual({ customCapabilityKey: "manage" })
    expect(skippedCapabilityPolicy).toEqual({ skipCapabilityCheck: true })

    // @ts-expect-error Capability checks must not be implicitly disabled.
    const missingCapabilityPolicy: CapabilityCheckConfig = {}
    expect(missingCapabilityPolicy).toEqual({})
  })

  it("accepts a complete tenant entity", () => {
    expect(() => validateEntity(validInput(), { list: true, detail: true, create: true, update: true, delete: true })).not.toThrow()
  })

  it("accepts a custom capability key", () => {
    expect(() => validateEntity({ ...validInput(), policy: { customCapabilityKey: "manage" } }, { list: true, detail: true, create: true, update: true, delete: true })).not.toThrow()
  })

  it.each([
    ["invalid module key", { moduleKey: "tenant/people" }],
    ["non-string module key that coerces to a valid one", { moduleKey: ["tenant"] }],
    ["unknown primary key", { entity: { primaryKey: "missing" } }],
    ["missing tenant acknowledgement", { entityScope: { kind: "platform" } }],
    ["tenant field without tenant scope", { entityScope: { kind: "platform", acknowledged: true } }],
    ["missing capability policy", { policy: {} }],
  ])("rejects %s", (_label, override) => {
    const input = { ...validInput(), ...override, entity: { ...validInput().entity, ...(override as { entity?: object }).entity }, validation: { ...validInput().validation, ...(override as { validation?: object }).validation }, entityScope: { ...validInput().entityScope, ...(override as { entityScope?: object }).entityScope } } as never
    expect(() => validateEntity(input, { list: true, detail: true, create: true, update: true, delete: true })).toThrow(ConfigurationError)
  })

  it("rejects a missing create schema", () => {
    const input = { ...validInput(), validation: { createBody: undefined, updateBody: schema } } as never
    expect(() => validateEntity(input, { list: true, detail: true, create: true, update: true, delete: true })).toThrow("enables create")
  })

  it("validates rate-limit shape and field lists", () => {
    expect(() => validateEntity({ ...validInput(), searchableColumns: ["name", "name"] }, { list: true, detail: true, create: true, update: true, delete: true })).toThrow("duplicate searchable")
    expect(() => validateEntity({ ...validInput(), rateLimit: { list: { max: 0, timeWindow: 60, consistency: "atomic" } } }, { list: true, detail: true, create: true, update: true, delete: true })).toThrow("rate-limit max")
  })
})
