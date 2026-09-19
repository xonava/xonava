import { describe, expect, it } from "vitest"
import { Predicate } from "../../domain/predicate"
import { fieldsAllowedForPurpose } from "../../domain/dataClassification"
import { decodeDurableValue, encodeDurableValue } from "../../serialization/durableCodec"
import { assertEntityCapabilityAvailable } from "../capabilityCheck"
import { defineEntity } from "../defineEntity"

const schema = { parse: (value: unknown) => value as Record<string, unknown>, parseAsync: async (value: unknown) => value as Record<string, unknown> }
const base = () => ({
  moduleKey: "tenant.documents",
  entity: { name: "document", primaryKey: "id" as const, tenantField: "tenantId" as const, versionField: "version" as const, fields: {
    id: { type: "uuid" as const }, tenantId: { type: "string" as const }, version: { type: "number" as const },
    deletedAt: { type: "datetime" as const, nullable: true }, amount: { type: "decimal" as const, precision: 12, scale: 2 },
    status: { type: "enum" as const, enumValues: ["draft", "published"] }, secret: { type: "string" as const, classification: "restricted" as const },
  } },
  entityScope: { kind: "tenant" as const }, policy: { skipCapabilityCheck: true as const },
  validation: { createBody: schema, updateBody: schema }, audit: false as const, cache: false as const,
})

describe("E1 entity compiler expansion", () => {
  it("compiles immutable scope, lifecycle, query, persistence and capability strategies", () => {
    const compiled = defineEntity<Record<string, unknown>>({ ...base(), lifecycle: { kind: "soft-delete", deletedAtField: "deletedAt" }, dataClassification: { secret: "restricted" }, persistenceSource: "regional-primary" })
    expect(compiled.compiledScope).toEqual({ kind: "tenant", field: "tenantId" })
    expect(compiled.compiledPersistence).toEqual({ source: "regional-primary", access: "read-write" })
    expect(compiled.compiledLifecycle).toMatchObject({ kind: "soft-delete", deleteStrategy: "occ-soft", restoreStrategy: "occ-restore", activeRowFilter: Predicate.isNull("deletedAt") })
    expect(compiled.compiledFieldProtections.immutable).toContain("deletedAt")
    expect(compiled.requiredCapabilityManifest).toBe(compiled.requiredRuntimeRequirements)
    expect(Object.isFrozen(compiled.compiledQuery)).toBe(true)
  })
  it("supports explicit application/platform/system scope definitions", () => {
    const { tenantField: _ignored, ...unscopedEntity } = base().entity
    expect(() => defineEntity<Record<string, unknown>>({ ...base(), entity: unscopedEntity, entityScope: { kind: "application", field: "tenantId" } })).not.toThrow()
    expect(() => defineEntity<Record<string, unknown>>({ ...base(), entity: unscopedEntity, entityScope: { kind: "platform", acknowledged: true } })).not.toThrow()
  })
  it("rejects invalid lifecycle and scalar cross-feature configurations", () => {
    expect(() => defineEntity<Record<string, unknown>>({ ...base(), entity: { ...base().entity, fields: { ...base().entity.fields, amount: { type: "decimal" as const, precision: 2, scale: 3 } } } })).toThrow(/precision\/scale/)
    expect(() => defineEntity<Record<string, unknown>>({ ...base(), lifecycle: { kind: "append-only" } })).toThrow(/cannot enable update or delete/)
  })
  it("uses registered codecs for custom durable values", () => {
    const registry = { money: { key: "money", encode: (value: unknown) => String(value), decode: (value: unknown) => Number(value) } }
    expect(decodeDurableValue(registry, encodeDurableValue(registry, "money", 12.5))).toBe(12.5)
    expect(() => defineEntity<Record<string, unknown>>({ ...base(), entity: { ...base().entity, fields: { ...base().entity.fields, custom: { type: "custom" as const, durableCodec: "missing" } } } })).toThrow(/registered durable codec/)
  })
  it("shares classification policy and unified capability manifests", () => {
    expect(fieldsAllowedForPurpose({ name: "public", secret: "restricted" }, "telemetry")).toEqual(["name"])
    expect(() => assertEntityCapabilityAvailable({ customCapabilityKey: "documents:read" }, { application: new Set(), runtime: new Set() })).toThrow(/unavailable/)
  })
  it("rejects pre-E1 enabled/required boolean shapes", () => {
    expect(() => defineEntity({ ...base(), audit: { enabled: true } } as never)).toThrow(/without enabled/)
    expect(() => defineEntity({ ...base(), idempotency: { required: true } } as never)).toThrow(/without required/)
  })
})
