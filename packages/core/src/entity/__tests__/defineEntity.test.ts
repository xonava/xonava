import { compileEntity, isCompiledEntityDefinition } from "../compileEntity"
import { describe, expect, it } from "vitest"
import { defineEntity } from "../defineEntity"

const schema = {} as never

class ZodLikeSchema {
  parse(input: unknown) {
    return input
  }

  parseAsync(input: unknown) {
    return Promise.resolve(input)
  }
}

class OpaqueConfig {
  value = "mutable"
}

function validInput() {
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
    },
    entityScope: { kind: "tenant" as const },
    policy: { skipCapabilityCheck: true as const },
    validation: { createBody: schema, updateBody: schema },
  }
}

describe("defineEntity", () => {
  it("normalizes defaults before validation and freezes the result deeply", () => {
    const definition = defineEntity(validInput())

    expect(definition.entity.primaryKey).toBe("id")
    expect(definition.searchableColumns).toEqual([])
    expect(definition.routes).toEqual({ list: true, detail: true, create: true, update: true, delete: true })
    expect(definition.audit).toBe(false)
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.entity)).toBe(true)
    expect(Object.isFrozen(definition.entity.fields)).toBe(true)
  })

  it("does not freeze caller-owned nested definition values", () => {
    const emitOn = ["create", "update"] as const
    const input = { ...validInput(), audit: { emitOn: [...emitOn] as Array<"create" | "update" | "delete"> } }
    const definition = defineEntity(input)
    if (definition.audit === false) throw new Error("expected enabled audit configuration")

    input.audit.emitOn.push("delete")

    expect(input.audit.emitOn).toEqual(["create", "update", "delete"])
    expect(definition.audit.emitOn).toEqual(["create", "update"])
    expect(Object.isFrozen(definition.audit)).toBe(true)
    expect(Object.isFrozen(definition.audit.emitOn)).toBe(true)
  })

  it("preserves opaque schema, class, Map, and Set instances by reference", () => {
    const schemaInstance = new ZodLikeSchema()
    const classInstance = new OpaqueConfig()
    const map = new Map([['key', 'value']])
    const set = new Set(['value'])
    const crudConfig = { list: { transformQuery: async () => undefined }, nested: { enabled: true }, schemaInstance, classInstance, map, set }
    const input = {
      ...validInput(),
      validation: { createBody: schemaInstance, updateBody: schemaInstance },
      crud: crudConfig,
    }

    const definition = defineEntity(input)
    const crud = definition.crud as typeof crudConfig

    expect(definition.validation.createBody).toBe(schemaInstance)
    expect(crud.schemaInstance).toBe(schemaInstance)
    expect(crud.classInstance).toBe(classInstance)
    expect(crud.map).toBe(map)
    expect(crud.set).toBe(set)
    expect(Object.isFrozen(schemaInstance)).toBe(false)
    expect(Object.isFrozen(classInstance)).toBe(false)
    expect(Object.isFrozen(map)).toBe(false)
    expect(Object.isFrozen(set)).toBe(false)
  })

  it("clones and freezes nested plain configuration without freezing the caller's value", () => {
    const crudConfig = { list: { transformQuery: async () => undefined }, nested: { enabled: true } }
    const input = {
      ...validInput(),
      crud: crudConfig,
    }

    const definition = defineEntity(input)
    input.crud.nested.enabled = false

    expect((definition.crud as typeof crudConfig).nested.enabled).toBe(true)
    expect(Object.isFrozen((definition.crud as typeof crudConfig).nested)).toBe(true)
    expect(Object.isFrozen(input.crud.nested)).toBe(false)
  })

  it("freezes nested values under non-enumerable and symbol properties", () => {
    const symbolKey = Symbol("symbolNested")
    const hiddenValue = { enabled: true }
    const symbolValue = { enabled: true }
    const nested: { visible: { enabled: boolean }; hidden: typeof hiddenValue; [symbolKey]: typeof symbolValue } = {
      visible: { enabled: true },
      hidden: hiddenValue,
      [symbolKey]: symbolValue,
    }
    Object.defineProperty(nested, "hidden", { value: hiddenValue, writable: true, configurable: true })
    Object.defineProperty(nested, symbolKey, { value: symbolValue, writable: true, configurable: true })

    const input = { ...validInput(), crud: { list: { transformQuery: async () => undefined }, nested } }
    const definition = defineEntity(input)
    const clonedNested = (definition.crud as typeof input.crud).nested

    expect(clonedNested.hidden).not.toBe(hiddenValue)
    expect(clonedNested[symbolKey]).not.toBe(symbolValue)
    expect(Object.isFrozen(clonedNested.hidden)).toBe(true)
    expect(Object.isFrozen(clonedNested[symbolKey])).toBe(true)
    expect(Object.isFrozen(clonedNested.visible)).toBe(true)
    expect(Object.isFrozen(hiddenValue)).toBe(false)
    expect(Object.isFrozen(symbolValue)).toBe(false)
  })

  it("normalizes the optimistic concurrency version field onto the entity", () => {
    const input = { ...validInput(), entity: { ...validInput().entity }, optimisticConcurrency: { versionField: "version" as const } }

    const definition = defineEntity(input)

    expect(definition.entity.versionField).toBe("version")
    expect(definition.optimisticConcurrency?.versionField).toBe("version")
    expect(Object.isFrozen(definition.entity)).toBe(true)
  })

  it("rejects an unknown optimistic concurrency version field", () => {
    const input = {
      ...validInput(),
      entity: { ...validInput().entity },
      optimisticConcurrency: { versionField: "missing" },
    }

    expect(() => defineEntity(input as never)).toThrow()
  })

  it("rejects a non-numeric optimistic concurrency version field", () => {
    const input = {
      ...validInput(),
      entity: { ...validInput().entity },
      optimisticConcurrency: { versionField: "name" },
    }

    expect(() => defineEntity(input as never)).toThrow()
  })

  it("rejects conflicting entity and optimistic concurrency version fields", () => {
    expect(() => defineEntity({
      ...validInput(),
      optimisticConcurrency: { versionField: "name" as const },
    } as never)).toThrow("conflicting concurrency version fields")
  })

  it.each([
    ["module key", { moduleKey: "tenant people" }],
    ["primary key", { entity: { ...validInput().entity, primaryKey: "missing" } }],
    ["search field", { searchableColumns: ["missing"] }],
    ["default sort", { listDefaults: { sortColumn: "missing" } }],
    ["rate limit", { rateLimit: { list: { max: 0, timeWindow: "1 minute" } } }],
    ["capability key", { policy: { customCapabilityKey: "" } }],
  ])("rejects invalid %s definitions", (_label, override) => {
    expect(() => defineEntity({ ...validInput(), ...override } as never)).toThrow()
  })

  it("rejects an unacknowledged global scope at runtime", () => {
    expect(() => defineEntity({
      ...validInput(),
      entity: { ...validInput().entity, tenantField: undefined },
      entityScope: { kind: "platform", acknowledged: false },
    } as never)).toThrow('must acknowledge entityScope kind "platform"')
  })
})


it("rejects reflected compiled entity markers and inherited definitions", () => {
  const original = defineEntity(validInput())
  const reflected = Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(original)))
  expect(isCompiledEntityDefinition(original)).toBe(true)
  expect(isCompiledEntityDefinition(reflected)).toBe(false)
  expect(() => compileEntity(reflected as never, { dependencies: {} })).toThrow("defineEntity")
  expect(() => compileEntity(Object.create(original))).toThrow("defineEntity")
})
