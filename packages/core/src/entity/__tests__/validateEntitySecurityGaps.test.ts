import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import { assertCapabilityConfigValid, resolveCapabilityKey } from "../capabilityCheck"
import { validateEntity } from "../validateEntity"

const schema = {} as never
const routes = { list: true, detail: true, create: true, update: true, delete: true }

function base() {
  return {
    moduleKey: "tenant.people",
    entity: {
      name: "person",
      primaryKey: "id" as const,
      tenantField: "tenantId" as const,
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

function withoutVersionField() {
  const input = base()
  return { ...input, entity: { ...input.entity, versionField: undefined } }
}

function versioned() {
  return { ...base(), entity: { ...base().entity, versionField: "version" as const } }
}

describe("capability config guards (P1-02)", () => {
  it("resolves and normalizes an enabled custom capability key", () => {
    expect(resolveCapabilityKey({ customCapabilityKey: "manage" })).toEqual({ enabled: true, key: "manage" })
  })

  it("resolves a skipped capability check to the disabled form", () => {
    expect(resolveCapabilityKey({ skipCapabilityCheck: true })).toEqual({ enabled: false })
  })

  it.each([
    ["claims both branches", { skipCapabilityCheck: true, customCapabilityKey: "manage" }],
    ["claims neither branch", {}],
    ["empty key", { customCapabilityKey: "" }],
    ["malformed key", { customCapabilityKey: "bad key" }],
    ["null config", null],
  ])("rejects %s at runtime", (_label, config) => {
    expect(() => assertCapabilityConfigValid(config)).toThrow(ConfigurationError)
    expect(() => resolveCapabilityKey(config as never)).toThrow(ConfigurationError)
  })

  it("rejects a custom capability key that collides with a runtime capability", () => {
    for (const reserved of ["deferredExecution", "objectStore", "cache"]) {
      const input = { ...versioned(), policy: { customCapabilityKey: reserved } }
      expect(() => validateEntity(input as never, routes)).toThrow("framework-reserved capability name")
    }
  })

  it("rejects a custom capability key that collides with the bypass authority literal", () => {
    const input = { ...versioned(), policy: { customCapabilityKey: "bypassAuthority" } }
    expect(() => validateEntity(input as never, routes)).toThrow("framework-reserved capability name")
  })

  it("accepts an ordinary custom capability key", () => {
    const input = { ...versioned(), policy: { customCapabilityKey: "manage" } }
    expect(() => validateEntity(input as never, routes)).not.toThrow()
  })
})

describe("mandatory OCC for mutating routes (P1-03)", () => {
  it("rejects an update route without a version field", () => {
    expect(() => validateEntity(withoutVersionField() as never, { ...routes, update: true }))
      .toThrow(ConfigurationError)
    expect(() => validateEntity(withoutVersionField() as never, { ...routes, update: true }))
      .toThrow(/optimistic concurrency/i)
  })

  it("rejects a delete route without OCC", () => {
    expect(() => validateEntity(withoutVersionField() as never, { ...routes, delete: true }))
      .toThrow(/optimistic concurrency/i)
  })

  it("accepts an update route when entity.versionField is declared", () => {
    const input = { ...base(), entity: { ...base().entity, versionField: "version" } }
    expect(() => validateEntity(input as never, { ...routes, update: true })).not.toThrow()
  })

  it("accepts a create-only route without OCC", () => {
    expect(() => validateEntity(withoutVersionField() as never, {
      list: false,
      detail: false,
      create: true,
      update: false,
      delete: false,
    })).not.toThrow()
  })

  it("accepts an update route when optimisticConcurrency declares the version field", () => {
    const input = { ...base(), optimisticConcurrency: { versionField: "version" as const } }
    expect(() => validateEntity(input as never, { ...routes, update: true })).not.toThrow()
  })

  it("rejects conflicting entity and optimisticConcurrency version fields", () => {
    const input = {
      ...versioned(),
      entity: { ...versioned().entity, fields: { ...versioned().entity.fields, revision: { type: "number" as const } } },
      optimisticConcurrency: { versionField: "revision" as const },
    }
    expect(() => validateEntity(input as never, routes)).toThrow("has conflicting concurrency version fields")
  })

  it("accepts matching entity and optimisticConcurrency version fields", () => {
    const input = {
      ...base(),
      entity: { ...base().entity, versionField: "version" as const },
      optimisticConcurrency: { versionField: "version" as const },
    }
    expect(() => validateEntity(input as never, routes)).not.toThrow()
  })
})
