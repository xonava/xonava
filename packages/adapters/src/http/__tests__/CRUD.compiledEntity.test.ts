// @ts-nocheck
import { describe, expect, it, vi } from "vitest"
import { defineEntity } from "@xonava/core/entity"
import { CRUD } from "../crud"
import { canonicalRequestNormalization, trustedSession } from "./canonicalRequest"

type Person = { id: string; tenantId: string; name: string; version: number }

const schema = { parse: (value: unknown) => value } as never

const definition = defineEntity<Person>({
  moduleKey: "tenant.people",
  entity: {
    name: "person",
    fields: {
      id: { type: "string" },
      tenantId: { type: "string" },
      name: { type: "string" },
      version: { type: "number" },
    },
    tenantField: "tenantId",
    versionField: "version",
  },
  entityScope: { kind: "tenant" },
  policy: { skipCapabilityCheck: true },
  validation: { createBody: schema, updateBody: schema },
})

function runtime() {
  return {
    adapterDeps: {
      assertValidCsrf: vi.fn(),
      resolveAbacBundle: vi.fn(),
      createIdempotencyPort: vi.fn(),
    },
    requestNormalization: canonicalRequestNormalization(trustedSession({ kind: "tenant", tenantId: "tenant-1" }), "tenant.people"),
    scope: { scope: "tenant" as const },
    createPersistence: vi.fn(),
    getCacheAdapter: vi.fn(async () => ({} as never)),
  }
}

describe("CRUD compiled entity boundary", () => {
  it("accepts a compiled definition", () => {
    expect(() => CRUD(definition, runtime())).not.toThrow()
  })

  it("rejects raw entity configuration", () => {
    const rawConfiguration = { ...definition }
    expect(() => CRUD(rawConfiguration as never, runtime())).toThrow(/created by defineEntity/)
  })

  it("rejects a forged compiled-definition symbol", () => {
    const forged = { ...definition }
    Object.defineProperty(forged, Symbol("enterprise.compiledEntityDefinition"), { value: true })
    expect(() => CRUD(forged as never, runtime())).toThrow(/created by defineEntity/)
  })

  it("rejects obsolete authorization keys during CRUD construction", () => {
    expect(() => CRUD(definition, {
      ...runtime(),
      adapterDeps: { ...runtime().adapterDeps, ownerAuthority: false } as never,
    })).toThrow(/obsolete authorization decision key.*ownerAuthority/)
  })

  it("rejects malformed adapter dependencies during CRUD construction", () => {
    expect(() => CRUD(definition, {
      ...runtime(),
      adapterDeps: {
        ...runtime().adapterDeps,
        assertValidCsrf: true,
      } as never,
    })).toThrow(/invalid required member.*assertValidCsrf/)
  })

  it("preserves durable audit metadata for adapter dependency checks", () => {
    const durableDefinition = defineEntity<Person>({
      ...definition,
      audit: {
        auditGuarantee: "durable",
        requiredStateSemantics: "committed-state",
      },
    })

    expect(durableDefinition.audit).toMatchObject({
      auditGuarantee: "durable",
      requiredStateSemantics: "committed-state",
    })
    expect(() => CRUD(durableDefinition, {
      ...runtime(),
      auditSinkFactory: vi.fn(),
    })).toThrow(/outboxSinkFactory/)
  })
})
