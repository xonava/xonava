import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import { Predicate } from "../../domain/predicate"
import type { RuntimeCapabilities } from "../../bootstrap/runtimeCapabilities"
import { COMPILED_ENTITY_DEFINITION_BRAND, compileEntity, isCompiledEntityDefinition, type CompiledEntityDefinition, type EntityCompilationDependencies } from "../compileEntity"
import { ENTITY_DEFINITION_BRAND } from "../brands"
import { defineEntity } from "../defineEntity"

type Loose = Record<string, unknown>
type Row = Record<string, unknown>

const schema = { parse: (value: unknown) => value } as never

function baseInput(): { moduleKey: string; entity: Loose; entityScope: Loose; policy: Loose; validation: Loose } {
  return {
    moduleKey: "tenant.people",
    entity: {
      name: "person",
      primaryKey: "id",
      tenantField: "tenantId",
      versionField: "version",
      fields: {
        id: { type: "string" },
        tenantId: { type: "string" },
        name: { type: "string" },
        version: { type: "number" },
        deletedAt: { type: "datetime", nullable: true },
      },
    },
    entityScope: { kind: "tenant" },
    policy: { skipCapabilityCheck: true },
    validation: { createBody: schema, updateBody: schema },
  }
}

function inputOf(over: Loose = {}, entityOver: Loose = {}): never {
  const base = baseInput()
  const entity: Loose = { ...base.entity, ...entityOver }
  // An override of `undefined` removes the key, so absent and undefined stay distinguishable.
  for (const key of Object.keys(entityOver)) if (entityOver[key] === undefined) delete entity[key]
  return { ...base, ...over, entity } as never
}

function define(over: Loose = {}, entityOver: Loose = {}): CompiledEntityDefinition<Row> {
  return defineEntity<Row>(inputOf(over, entityOver))
}

function messageOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError)
    return (error as Error).message
  }
  throw new Error("expected a ConfigurationError")
}

/** Entity without a version field and with update/delete disabled, so it can stay minimal. */
const readOnlyRoutes = { create: false, update: false, delete: false }

describe("runtime requirements", () => {
  it("is empty for a minimal entity", () => {
    const compiled = define({ cache: false, audit: false })
    expect(compiled.requiredRuntimeRequirements).toStrictEqual({
      cacheAdapter: false,
      auditSink: false,
      outboxSink: false,
      rateLimitStore: false,
      idempotencyPort: true,
      runtimeCapabilities: [],
    })
    expect(compiled.requiredCapabilityManifest).toBe(compiled.requiredRuntimeRequirements)
  })

  it("requires the cache adapter and the cache capability for an enabled cache", () => {
    const compiled = define({ cache: { tag: "t", keyPrefix: "p" } })
    expect(compiled.requiredRuntimeRequirements.cacheAdapter).toBe(true)
    expect(compiled.requiredRuntimeRequirements.runtimeCapabilities).toStrictEqual(["cache"])
    expect(define({ cache: false }).requiredRuntimeRequirements.runtimeCapabilities).toStrictEqual([])
    expect(define({}).requiredRuntimeRequirements.runtimeCapabilities).toStrictEqual([])
    expect(define({}).requiredRuntimeRequirements.cacheAdapter).toBe(false)
  })

  it("requires the audit sink for audit and the outbox sink only for durable audit", () => {
    expect(define({ audit: false }).requiredRuntimeRequirements).toMatchObject({ auditSink: false, outboxSink: false })
    expect(define({}).requiredRuntimeRequirements).toMatchObject({ auditSink: false, outboxSink: false })
    expect(define({ audit: { resource: "p" } }).requiredRuntimeRequirements).toMatchObject({ auditSink: true, outboxSink: false })
    expect(define({ audit: { resource: "p", auditGuarantee: "best-effort" } }).requiredRuntimeRequirements).toMatchObject({ auditSink: true, outboxSink: false })
    expect(define({ audit: { resource: "p", auditGuarantee: "atomic" } }).requiredRuntimeRequirements).toMatchObject({ auditSink: true, outboxSink: false })
    expect(define({ audit: { resource: "p", auditGuarantee: "durable" } }).requiredRuntimeRequirements).toMatchObject({ auditSink: true, outboxSink: true })
    expect(define({ audit: { resource: "p", auditGuarantee: "" } }).requiredRuntimeRequirements).toMatchObject({ auditSink: true, outboxSink: false })
  })

  it("requires the rate-limit store only for atomic limits on enabled routes", () => {
    const atomic = { max: 1, timeWindow: 60, consistency: "atomic" }
    const bestEffort = { max: 1, timeWindow: 60, consistency: "best-effort" }
    expect(define({ rateLimit: { list: atomic } }).requiredRuntimeRequirements).toMatchObject({ rateLimitStore: true, cacheAdapter: false })
    expect(define({ rateLimit: { list: bestEffort } }).requiredRuntimeRequirements).toMatchObject({ rateLimitStore: false, cacheAdapter: true })
    expect(define({ rateLimit: { list: atomic, create: bestEffort } }).requiredRuntimeRequirements).toMatchObject({ rateLimitStore: true, cacheAdapter: true })
    expect(define({ rateLimit: {} }).requiredRuntimeRequirements).toMatchObject({ rateLimitStore: false, cacheAdapter: false })
    expect(define({}).requiredRuntimeRequirements).toMatchObject({ rateLimitStore: false, cacheAdapter: false })
  })

  it("ignores rate limits on disabled routes", () => {
    const atomic = { max: 1, timeWindow: 60, consistency: "atomic" }
    const bestEffort = { max: 1, timeWindow: 60, consistency: "best-effort" }
    expect(define({ rateLimit: { list: atomic }, routes: { list: false } }).requiredRuntimeRequirements).toMatchObject({ rateLimitStore: false })
    expect(define({ rateLimit: { list: bestEffort }, routes: { list: false } }).requiredRuntimeRequirements).toMatchObject({ cacheAdapter: false })
    expect(define({ rateLimit: { list: atomic, detail: atomic }, routes: { list: false } }).requiredRuntimeRequirements).toMatchObject({ rateLimitStore: true })
    expect(define({ rateLimit: { list: bestEffort, detail: bestEffort }, routes: { list: false } }).requiredRuntimeRequirements).toMatchObject({ cacheAdapter: true })
  })

  it("requires the idempotency port when any mutating route is enabled and idempotency is not disabled", () => {
    const requires = (routes: Loose, idempotency?: unknown) =>
      define({ routes, ...(idempotency === undefined ? {} : { idempotency }) }, { versionField: "version" }).requiredRuntimeRequirements.idempotencyPort
    expect(requires({})).toBe(true)
    expect(requires({}, false)).toBe(false)
    expect(requires({}, {})).toBe(true)
    expect(requires({ update: false, delete: false })).toBe(true)
    expect(requires({ create: false, delete: false })).toBe(true)
    expect(requires({ create: false, update: false })).toBe(true)
    expect(requires({ create: false, update: false, delete: false })).toBe(false)
    expect(requires({ create: false, update: false, delete: false }, {})).toBe(false)
    expect(requires({ create: false, update: false, delete: false }, false)).toBe(false)
  })

  it("lists the full-text search port key only for full-text search", () => {
    expect(define({ searchStrategy: { kind: "fullText", portKey: "search" } }).requiredRuntimeRequirements.searchPortKey).toBe("search")
    expect(define({ searchStrategy: { kind: "contains" } }).requiredRuntimeRequirements).not.toHaveProperty("searchPortKey")
    expect(define({}).requiredRuntimeRequirements).not.toHaveProperty("searchPortKey")
  })
})

describe("dependency assertion", () => {
  const everything = define({
    cache: { tag: "t", keyPrefix: "p" },
    audit: { resource: "p", auditGuarantee: "durable" },
    rateLimit: { list: { max: 1, timeWindow: 60, consistency: "atomic" } },
    searchStrategy: { kind: "fullText", portKey: "search" },
  })
  const runtime: RuntimeCapabilities = { deferredExecution: false, cache: true }
  const searchPort = { capability: { portKey: "search" } } as never
  const complete = (): EntityCompilationDependencies => ({
    cacheAdapter: {},
    auditSinkFactory: {},
    outboxSinkFactory: {},
    rateLimitStore: {},
    idempotencyPort: {},
    searchPorts: { search: searchPort },
    runtimeCapabilities: runtime,
  })
  const without = (key: keyof EntityCompilationDependencies): EntityCompilationDependencies => {
    const dependencies = complete()
    delete dependencies[key]
    return dependencies
  }
  const missing = (dependencies: EntityCompilationDependencies) =>
    messageOf(() => compileEntity(everything, { dependencies }))

  it("returns the very same compiled definition when every dependency is present", () => {
    expect(compileEntity(everything, { dependencies: complete() })).toBe(everything)
  })

  it("recompiles a compiled definition when no dependencies are supplied", () => {
    const recompiled = compileEntity(everything)
    expect(recompiled).not.toBe(everything)
    expect(isCompiledEntityDefinition(recompiled)).toBe(true)
    expect(compileEntity(everything, {})).not.toBe(everything)
  })

  it("lists every missing dependency in declaration order", () => {
    expect(missing({})).toBe(
      'Entity "person" is missing runtime dependencies: cacheAdapter, auditSinkFactory, outboxSinkFactory, rateLimitStore, idempotencyPort, searchPorts.search, runtimeCapabilities.cache.',
    )
  })

  it.each([
    ["cacheAdapter", "cacheAdapter"],
    ["auditSinkFactory", "auditSinkFactory"],
    ["outboxSinkFactory", "outboxSinkFactory"],
    ["rateLimitStore", "rateLimitStore"],
    ["idempotencyPort", "idempotencyPort"],
    ["searchPorts", "searchPorts.search"],
    ["runtimeCapabilities", "runtimeCapabilities.cache"],
  ] as const)("reports only %s when only it is missing", (key, label) => {
    expect(missing(without(key))).toBe(`Entity "person" is missing runtime dependencies: ${label}.`)
  })

  it("treats falsy dependencies as missing", () => {
    for (const key of ["cacheAdapter", "auditSinkFactory", "outboxSinkFactory", "rateLimitStore", "idempotencyPort"] as const) {
      expect(missing({ ...complete(), [key]: undefined })).toBe(`Entity "person" is missing runtime dependencies: ${key}.`)
      expect(missing({ ...complete(), [key]: null })).toBe(`Entity "person" is missing runtime dependencies: ${key}.`)
    }
    expect(missing({ ...complete(), runtimeCapabilities: { deferredExecution: true, cache: false } })).toBe(
      'Entity "person" is missing runtime dependencies: runtimeCapabilities.cache.',
    )
  })

  it("requires a search port whose capability key matches", () => {
    const expected = 'Entity "person" is missing runtime dependencies: searchPorts.search.'
    expect(missing({ ...complete(), searchPorts: {} })).toBe(expected)
    expect(missing({ ...complete(), searchPorts: { search: { capability: { portKey: "other" } } as never } })).toBe(expected)
    expect(missing({ ...complete(), searchPorts: { other: searchPort } })).toBe(expected)
  })

  it("asks for nothing when nothing is required", () => {
    const minimal = define({ cache: false, audit: false, idempotency: false })
    expect(() => compileEntity(minimal, { dependencies: {} })).not.toThrow()
    expect(compileEntity(minimal, { dependencies: {} })).toBe(minimal)
    const readOnly = define({ cache: false, audit: false, routes: readOnlyRoutes })
    expect(readOnly.requiredRuntimeRequirements.idempotencyPort).toBe(false)
    expect(() => compileEntity(readOnly, { dependencies: {} })).not.toThrow()
  })

  it("rejects values that were not created by defineEntity", () => {
    expect(messageOf(() => compileEntity({} as never))).toBe("compileEntity() requires an entity definition created by defineEntity().")
    expect(messageOf(() => compileEntity(null as never))).toBe("compileEntity() requires an entity definition created by defineEntity().")
  })
})

describe("compiled brands", () => {
  it("defines both brands as hidden true values", () => {
    const compiled = define({})
    for (const brand of [ENTITY_DEFINITION_BRAND, COMPILED_ENTITY_DEFINITION_BRAND]) {
      const descriptor = Object.getOwnPropertyDescriptor(compiled, brand)
      expect(descriptor?.value).toBe(true)
      expect(descriptor?.enumerable).toBe(false)
    }
    expect(Object.keys(compiled)).not.toContain(String(ENTITY_DEFINITION_BRAND))
    expect(Object.getOwnPropertySymbols({ ...compiled })).toHaveLength(0)
  })

  it("recognises only compiled definitions", () => {
    expect(isCompiledEntityDefinition(define({}))).toBe(true)
    expect(isCompiledEntityDefinition({})).toBe(false)
    expect(isCompiledEntityDefinition(null)).toBe(false)
    expect(isCompiledEntityDefinition(undefined)).toBe(false)
    expect(isCompiledEntityDefinition("x")).toBe(false)
    expect(isCompiledEntityDefinition(5)).toBe(false)
    expect(isCompiledEntityDefinition(() => undefined)).toBe(false)
  })
})

describe("compiled audit", () => {
  it("compiles the disabled and default audit shapes exactly", () => {
    expect(define({ audit: false }).compiledAudit).toStrictEqual({ enabled: false, guarantee: "best-effort", fieldClassification: {} })
    expect(define({}).compiledAudit).toStrictEqual({ enabled: false, guarantee: "best-effort", fieldClassification: {} })
    expect(define({ audit: { resource: "p" } }).compiledAudit).toStrictEqual({ enabled: true, guarantee: "best-effort", fieldClassification: {} })
    expect(define({ audit: { resource: "p", auditGuarantee: "atomic" } }).compiledAudit.guarantee).toBe("atomic")
    expect(define({ audit: { resource: "p", auditGuarantee: "durable" } }).compiledAudit.guarantee).toBe("durable")
    expect(define({ audit: { resource: "p", auditGuarantee: "best-effort" } }).compiledAudit.guarantee).toBe("best-effort")
  })

  it("derives audit redaction from data classification", () => {
    const compiled = define({
      dataClassification: { name: "public", id: "internal", tenantId: "confidential", version: "restricted" },
      audit: { resource: "p" },
    })
    const expected = { name: "include", id: "include", tenantId: "mask", version: "omit" }
    expect(compiled.compiledAudit.fieldClassification).toStrictEqual(expected)
    expect(compiled.audit).toMatchObject({ fieldClassification: expected })
    expect(compiled.compiledFieldProtections.classified).toStrictEqual({ name: "public", id: "internal", tenantId: "confidential", version: "restricted" })
  })

  it("derives audit redaction from descriptor classifications and ignores unclassified fields", () => {
    const compiled = define(
      { audit: { resource: "p" } },
      {
        fields: {
          id: { type: "string" },
          tenantId: { type: "string" },
          version: { type: "number" },
          ssn: { type: "string", classification: "restricted" },
          note: { type: "string", classification: "public" },
          plain: { type: "string" },
        },
      },
    )
    expect(compiled.compiledAudit.fieldClassification).toStrictEqual({ ssn: "omit", note: "include" })
  })

  it("lets an explicit audit map tighten but never weaken the derived redaction", () => {
    const compiled = define({
      dataClassification: { name: "confidential", id: "restricted", tenantId: "public" },
      audit: { resource: "p", fieldClassification: { name: "include", id: "include", tenantId: "mask", version: "include" } },
    })
    expect(compiled.compiledAudit.fieldClassification).toStrictEqual({ name: "mask", id: "omit", tenantId: "mask", version: "include" })
    const tighter = define({
      dataClassification: { name: "confidential", id: "internal" },
      audit: { resource: "p", fieldClassification: { name: "omit", id: "mask" } },
    })
    expect(tighter.compiledAudit.fieldClassification).toStrictEqual({ name: "omit", id: "mask" })
    const equal = define({
      dataClassification: { name: "confidential" },
      audit: { resource: "p", fieldClassification: { name: "mask" } },
    })
    expect(equal.compiledAudit.fieldClassification).toStrictEqual({ name: "mask" })
  })

  it("keeps unknown explicit classifications so validation rejects them", () => {
    expect(
      messageOf(() =>
        define({
          dataClassification: { name: "restricted" },
          audit: { resource: "p", fieldClassification: { name: "hide" } },
        }),
      ),
    ).toBe('Entity "person" has an invalid audit classification for "name".')
  })

  it("keeps the audit definition free of a classification map when nothing is classified", () => {
    const compiled = define({ audit: { resource: "p" } })
    expect(Object.hasOwn(compiled.audit as object, "fieldClassification")).toBe(false)
    expect(define({ audit: false }).audit).toBe(false)
  })
})

describe("compiled scope and protections", () => {
  it("uses the entity tenant field for a tenant scope", () => {
    expect(define({}).compiledScope).toStrictEqual({ kind: "tenant", field: "tenantId" })
    expect(define({ entityScope: { kind: "tenant", field: "name" } }).compiledScope).toStrictEqual({ kind: "tenant", field: "tenantId" })
  })

  it("protects the application column but not the tenant column", () => {
    expect(define({}).compiledFieldProtections.immutable).toStrictEqual([])
    expect(define({}).entity.immutableFields).toStrictEqual([])
    const application = define({ entityScope: { kind: "application", field: "name" } }, { tenantField: undefined })
    expect(application.compiledScope).toStrictEqual({ kind: "application", field: "name" })
    expect(application.compiledFieldProtections.immutable).toStrictEqual(["name"])
    expect(application.entity.immutableFields).toStrictEqual(["name"])
  })

  it("deduplicates declared and structural protections", () => {
    const compiled = define(
      { entityScope: { kind: "application", field: "name" }, lifecycle: { kind: "soft-delete", deletedAtField: "deletedAt" } },
      { tenantField: undefined, immutableFields: ["id", "name", "deletedAt"] },
    )
    expect(compiled.compiledFieldProtections.immutable).toStrictEqual(["id", "name", "deletedAt"])
    expect(compiled.entity.immutableFields).toStrictEqual(["id", "name", "deletedAt"])
  })

  it("exposes platform and system scope filters", () => {
    const filter = Predicate.isNull("deletedAt")
    const platform = define({ entityScope: { kind: "platform", acknowledged: true, scopeFilter: filter } }, { tenantField: undefined })
    expect(platform.compiledScope).toStrictEqual({ kind: "platform", structuralFilter: filter })
    const system = define({ entityScope: { kind: "system", acknowledged: true } }, { tenantField: undefined })
    expect(system.compiledScope).toStrictEqual({ kind: "system" })
  })
})

describe("compiled lifecycle on the entity descriptor", () => {
  it("adds soft-delete metadata to the entity", () => {
    const compiled = define({ lifecycle: { kind: "soft-delete", deletedAtField: "deletedAt" } })
    expect(compiled.entity.activeRowFilter).toStrictEqual(Predicate.isNull("deletedAt"))
    expect(compiled.entity.deletedAtField).toBe("deletedAt")
    expect(compiled.entity.deleteStrategy).toBe("occ-soft")
    expect(compiled.compiledLifecycle).toMatchObject({ kind: "soft-delete", deletedAtField: "deletedAt", protectedFields: ["deletedAt"] })
  })

  it("adds no soft-delete metadata for hard-delete and append-only entities", () => {
    const hard = define({})
    expect(Object.hasOwn(hard.entity, "activeRowFilter")).toBe(false)
    expect(Object.hasOwn(hard.entity, "deletedAtField")).toBe(false)
    expect(hard.entity.deleteStrategy).toBe("hard")
    const appendOnly = define({ lifecycle: { kind: "append-only" }, routes: { update: false, delete: false } })
    expect(Object.hasOwn(appendOnly.entity, "activeRowFilter")).toBe(false)
    expect(Object.hasOwn(appendOnly.entity, "deletedAtField")).toBe(false)
    expect(appendOnly.entity.deleteStrategy).toBe("forbidden")
  })

  it("exposes only declared version and tenant fields on the root", () => {
    const compiled = define({})
    expect(compiled.versionField).toBe("version")
    expect(compiled.tenantField).toBe("tenantId")
    expect(compiled.primaryKey).toBe("id")
    const bare = define(
      { entityScope: { kind: "platform", acknowledged: true }, routes: { update: false, delete: false } },
      { tenantField: undefined, versionField: undefined },
    )
    expect(Object.hasOwn(bare, "versionField")).toBe(false)
    expect(Object.hasOwn(bare, "tenantField")).toBe(false)
    expect(Object.hasOwn(bare.entity, "versionField")).toBe(false)
    expect(Object.hasOwn(bare.entity, "tenantField")).toBe(false)
  })
})

describe("compiled cache, idempotency, pagination and rate quota", () => {
  it("compiles the cache guarantee", () => {
    expect(define({ cache: false }).compiledCache).toStrictEqual({ enabled: false, guarantee: "none" })
    expect(define({}).compiledCache).toStrictEqual({ enabled: false, guarantee: "none" })
    expect(define({ cache: { tag: "t", keyPrefix: "p" } }).compiledCache).toStrictEqual({ enabled: true, guarantee: "generation-qualified" })
  })

  it("compiles the idempotency namespace", () => {
    expect(define({}).compiledIdempotency).toStrictEqual({ required: true, namespace: "tenant.people:person" })
    expect(define({ idempotency: {} }).compiledIdempotency).toStrictEqual({ required: true, namespace: "tenant.people:person" })
    expect(define({ idempotency: false }).compiledIdempotency).toStrictEqual({ required: false, namespace: "tenant.people:person" })
    expect(define({ idempotency: { namespace: "custom" } }).compiledIdempotency).toStrictEqual({ required: true, namespace: "custom" })
    expect(define({}, { namespace: "ns" }).compiledIdempotency.namespace).toBe("tenant.people:ns:person")
    expect(define({ idempotency: false }, { namespace: "ns" }).compiledIdempotency.namespace).toBe("tenant.people:ns:person")
    expect(define({}, { namespace: "" }).compiledIdempotency.namespace).toBe("tenant.people:person")
  })

  it("sorts the rate-limited routes", () => {
    const limit = { max: 1, timeWindow: 60, consistency: "atomic" }
    expect(define({}).compiledRateQuota).toStrictEqual({ routes: [] })
    expect(define({ rateLimit: { update: limit, create: limit, list: limit, delete: limit, detail: limit } }).compiledRateQuota).toStrictEqual({
      routes: ["create", "delete", "detail", "list", "update"],
    })
  })

  it("compiles persistence, pagination and query limits", () => {
    expect(define({}).compiledPersistence).toStrictEqual({ source: "primary", access: "read-write" })
    expect(define({}).compiledPagination).toStrictEqual({ strategy: "offset" })
    expect(define({ queryLimits: { maxOffset: 40 } }).compiledPagination).toStrictEqual({ strategy: "offset", maxOffset: 40 })
    const limited = define({ queryLimits: { maxCount: 9, maxSearchableColumns: 2 } })
    expect(limited.compiledQuery.maxCount).toBe(9)
    expect(limited.compiledQuery.maxSearchableColumns).toBe(2)
    expect(Object.hasOwn(define({}).compiledQuery, "maxCount")).toBe(false)
    expect(Object.hasOwn(define({}).compiledQuery, "maxSearchableColumns")).toBe(false)
  })

  it("rejects invalid query limits with a configuration error before the budget is compiled", () => {
    expect(messageOf(() => define({ queryLimits: { maxPredicateDepth: 0 } }))).toBe('Entity "person" has an invalid query limit for maxPredicateDepth.')
    expect(messageOf(() => define({ queryLimits: { unknown: 1 } }))).toBe('Entity "person" declares unknown query limit unknown.')
  })
})
