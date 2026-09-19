import { describe, expect, it } from "vitest"
import { compileEntity } from "../compileEntity"
import { defineEntity } from "../defineEntity"
import { ENTITY_DEFINITION_BRAND } from "../brands"

type _Person = {
  id: string
  tenantId: string
  name: string
  version: number
}

const schema = { parse: (value: unknown) => value } as never

function input(overrides: Record<string, unknown> = {}) {
  return {
    moduleKey: "tenant.people",
    entity: {
      name: "person",
      fields: {
        id: { type: "string" as const },
        tenantId: { type: "string" as const },
        name: { type: "string" as const },
        version: { type: "number" as const },
      },
      tenantField: "tenantId" as const,
      versionField: "version" as const,
      immutableFields: ["id", "tenantId"] as ("id" | "tenantId")[],
    },
    entityScope: { kind: "tenant" as const },
    policy: { skipCapabilityCheck: true as const },
    validation: { createBody: schema, updateBody: schema },
    ...overrides,
  }
}

describe("Framework 1.0-E compiled entity contract", () => {
  it("compiles successfully and exposes normalized canonical metadata", () => {
    const definition = compileEntity(defineEntity(input()))

    expect(definition[ENTITY_DEFINITION_BRAND]).toBe(true)
    expect(definition.entity.primaryKey).toBe("id")
    expect(definition.entity.versionField).toBe("version")
    expect(definition.entity.tenantField).toBe("tenantId")
    expect(definition.primaryKey).toBe("id")
    expect(definition.versionField).toBe("version")
    expect(definition.tenantField).toBe("tenantId")
    expect(definition.entity.immutableFields).toEqual(["id", "tenantId"])
    expect(definition.routes).toEqual({ list: true, detail: true, create: true, update: true, delete: true })
    expect(definition.crud).toEqual({})
    expect(definition.policy).toEqual({ skipCapabilityCheck: true })
  })

  it("accepts only canonical lifecycle hooks and freezes the compiled result", () => {
    const definition = compileEntity(defineEntity(input({
      crud: {
        list: { transformQuery: async () => undefined, projectResult: async ({ result }: never) => result },
        detail: { projectResult: async ({ row }: never) => row },
        create: { transformInput: async () => undefined, projectCommittedResult: async () => undefined, afterCommit: async () => undefined },
        update: { transformInput: async () => undefined, projectCommittedResult: async () => undefined, afterCommit: async () => undefined },
        delete: { beforeDelete: async () => undefined, afterCommit: async () => undefined },
      },
    })))

    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.entity)).toBe(true)
    expect(Object.isFrozen(definition.entity.fields)).toBe(true)
    expect(Object.isFrozen(definition.routes)).toBe(true)
    expect(Object.isFrozen(definition.crud)).toBe(true)
    expect(() => (definition.routes.list = false)).toThrow()
    expect(() => (definition.entity.name = "changed")).toThrow()
  })

  it.each([
    ["version", { entity: { ...input().entity, versionField: undefined } }],
    ["tenant", { entity: { ...input().entity, tenantField: undefined } }],
    ["create schema", { validation: { updateBody: schema } }],
    ["update schema", { validation: { createBody: schema } }],
    ["capability dependency", { policy: undefined }],
  ])("rejects a compiled definition with a missing %s dependency", (_label, override) => {
    expect(() => defineEntity(input(override) as never)).toThrow()
  })
})
