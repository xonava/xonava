import { describe, expect, it } from "vitest"
import { compileEntity } from "../compileEntity"
import { defineEntity } from "../defineEntity"

const schema = { parse: (value: unknown) => value } as never

function makeDefinition() {
  return defineEntity({
    moduleKey: "tenant.people",
    entity: {
      name: "person",
      fields: {
        id: { type: "string" as const },
        tenantId: { type: "string" as const },
        version: { type: "number" as const },
      },
      tenantField: "tenantId" as const,
      versionField: "version" as const,
    },
    entityScope: { kind: "tenant" as const },
    policy: { skipCapabilityCheck: true as const },
    validation: { createBody: schema, updateBody: schema },
  })
}

describe("compileEntity", () => {
  it("returns an immutable detached compilation", () => {
    const definition = makeDefinition()
    const compiled = compileEntity(definition)

    expect(compiled).not.toBe(definition)
    expect(compiled).toEqual(definition)
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.entity.fields)).toBe(true)
    expect(Object.isFrozen(compiled.routes)).toBe(true)
  })

  it("rejects an unbranded definition before reading entity configuration", () => {
    expect(() => compileEntity({} as never)).toThrow("created by defineEntity")
  })
})
