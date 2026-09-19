import { describe, expect, it } from "vitest"
import { validateEntity } from "../validateEntity"
import { defineEntity } from "../defineEntity"

const schema = {} as never
const routes = { list: true, detail: true, create: true, update: true, delete: true }

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
        version: { type: "number" as const },
      },
    },
    entityScope: { kind: "tenant" as const },
    policy: { skipCapabilityCheck: true as const },
    validation: { createBody: schema, updateBody: schema },
  }
}

describe("P1-14 hook lifecycle hardening", () => {
  it("rejects unknown hook names", () => {
    const input = { ...base(), crud: { list: { before: async () => undefined, after: async ({ result }: never) => result } as never } }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid hook/)
  })

  it("accepts canonical lifecycle hook names", () => {
    const input = {
      ...base(),
      crud: {
        list: { transformQuery: async () => undefined, projectResult: async ({ result }: never) => result },
        detail: { projectResult: async () => ({}) },
        create: { transformInput: async () => undefined, projectCommittedResult: async () => undefined, afterCommit: async () => undefined },
        update: { transformInput: async () => undefined, projectCommittedResult: async () => undefined, afterCommit: async () => undefined },
        delete: { beforeDelete: async () => undefined, afterCommit: async () => undefined },
      },
    }
    expect(() => validateEntity(input as never, routes)).not.toThrow()
  })

  it("rejects unknown crud route", () => {
    const input = { ...base(), crud: { archive: { transformQuery: async () => undefined } } }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid crud route/)
  })

  it("rejects unknown hook name for route", () => {
    const input = { ...base(), crud: { list: { transform: async () => undefined } } }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid hook/)
  })

  it("rejects non-function hook value", () => {
    const input = { ...base(), crud: { list: { transformQuery: "not-a-function" as never } } }
    expect(() => validateEntity(input as never, routes)).toThrow(/must be a function/)
  })

  it("rejects unknown before hook name", () => {
    const input = {
      ...base(),
      crud: { list: { before: async () => undefined, transformQuery: async () => undefined } as never },
    }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid hook/)
  })

  it("rejects unknown after hook name", () => {
    const input = {
      ...base(),
      crud: { create: { after: async () => undefined, projectCommittedResult: async () => undefined } as never },
    }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid hook/)
  })

  it("rejects invalid hook name afterCommit on read routes", () => {
    const input = { ...base(), crud: { list: { afterCommit: async () => undefined } } }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid hook/)
  })

  it("defineEntity integration rejects invalid hook name", () => {
    expect(() =>
      defineEntity({
        ...base(),
        crud: { list: { invalidHook: async () => undefined } as never },
      } as never),
    ).toThrow(/invalid hook/)
  })

  it("validateEntity rejects invalid crud shape (non-object)", () => {
    const input = { ...base(), crud: "not-an-object" as never }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid crud configuration/)
  })
})

describe("P2-05 field descriptor durability", () => {
  it("rejects field with invalid type", () => {
    const input = { ...base(), entity: { ...base().entity, fields: { ...base().entity.fields, bad: { type: "invalid" as never } } } }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid field type/)
  })

  it("rejects field with non-boolean nullable", () => {
    const input = { ...base(), entity: { ...base().entity, fields: { ...base().entity.fields, name: { type: "string" as const, nullable: "yes" as never } } } }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid nullable/)
  })

  it("rejects field with invalid format", () => {
    const input = { ...base(), entity: { ...base().entity, fields: { ...base().entity.fields, name: { type: "string" as const, format: "bad" as never } } } }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid field format/)
  })

  it("accepts valid field formats", () => {
    const input = { ...base(), entity: { ...base().entity, fields: { ...base().entity.fields, name: { type: "string" as const, format: "email" as const } } } }
    expect(() => validateEntity(input as never, routes)).not.toThrow()
  })

  it("rejects null field descriptor", () => {
    const input = { ...base(), entity: { ...base().entity, fields: { ...base().entity.fields, name: null as never } } }
    expect(() => validateEntity(input as never, routes)).toThrow(/invalid field descriptor/)
  })
})
