import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import { DEFAULT_QUERY_BUDGET } from "../../query/queryBudget"
import { assertEntityQueryLimits, validateEntity } from "../validateEntity"

type Loose = Record<string, unknown>
type Routes = { list: boolean; detail: boolean; create: boolean; update: boolean; delete: boolean }

const schema = {} as never
const ALL: Routes = { list: true, detail: true, create: true, update: true, delete: true }

function base() {
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
      } as Loose,
    } as Loose,
    entityScope: { kind: "tenant" } as Loose,
    policy: { skipCapabilityCheck: true } as Loose,
    validation: { createBody: schema, updateBody: schema } as Loose,
  }
}

/** Builds a valid entity input and applies top-level, entity-level and extra-field overrides. */
function make(over: Loose = {}, entityOver: Loose = {}, extraFields: Loose = {}) {
  const b = base()
  const entity: Loose = { ...b.entity, ...entityOver }
  if (!("fields" in entityOver)) entity.fields = { ...(b.entity.fields as Loose), ...extraFields }
  return { ...b, ...over, entity } as never
}

function run(input: never, routes: Partial<Routes> = {}): void {
  validateEntity(input, { ...ALL, ...routes })
}

function failure(input: never, routes: Partial<Routes> = {}): string {
  try {
    run(input, routes)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError)
    return (error as Error).message
  }
  throw new Error("expected validateEntity to throw")
}

const ent = (rest: string) => `Entity "person" ${rest}`

describe("assertEntityQueryLimits", () => {
  it("accepts undefined and every declared limit key with a positive safe integer", () => {
    expect(() => assertEntityQueryLimits("person", undefined)).not.toThrow()
    for (const key of [...Object.keys(DEFAULT_QUERY_BUDGET), "maxSearchableColumns", "maxOffset", "maxCount"]) {
      expect(() => assertEntityQueryLimits("person", { [key]: 1 })).not.toThrow()
    }
  })

  it.each([[null], [0], [5], ["abc"], [true], [[]], [[1]]])("rejects the non-object limits %j", (limits) => {
    expect(() => assertEntityQueryLimits("person", limits)).toThrowError(new ConfigurationError(`Entity "person" has invalid query limits.`))
  })

  it("rejects unknown keys by name", () => {
    expect(() => assertEntityQueryLimits("person", { bogus: 1 })).toThrowError(new ConfigurationError(`Entity "person" declares unknown query limit bogus.`))
  })

  it.each([[0], [-1], [1.5], [Number.NaN], ["5"], [Number.MAX_SAFE_INTEGER + 1], [null], [undefined]])("rejects the value %j for a known key", (value) => {
    expect(() => assertEntityQueryLimits("person", { maxCount: value })).toThrowError(new ConfigurationError(`Entity "person" has an invalid query limit for maxCount.`))
  })

  it("names the entity and the offending key", () => {
    expect(() => assertEntityQueryLimits("order", { maxOffset: 0 })).toThrowError(new ConfigurationError(`Entity "order" has an invalid query limit for maxOffset.`))
  })
})

describe("validateEntity text requirements", () => {
  it("rejects empty, blank and non-string persistence sources", () => {
    for (const source of ["", "   ", 5]) {
      expect(failure(make({ persistenceSource: source }))).toBe(ent("has an invalid persistence source."))
    }
    expect(() => run(make({ persistenceSource: "replica" }))).not.toThrow()
  })

  it("reports an invalid module key, name and fields exactly", () => {
    expect(failure(make({ moduleKey: "bad key" }))).toBe(ent("has an invalid module key."))
    expect(failure(make({ moduleKey: undefined }))).toBe(ent("has an invalid module key."))
    expect(failure(make({}, { name: "" }))).toBe('Entity "" has an invalid name.')
    expect(failure(make({}, { name: "1abc" }))).toBe('Entity "1abc" has an invalid name.')
    expect(failure(make({}, { name: "   " }))).toBe('Entity "   " has an invalid name.')
    expect(failure(make({}, { fields: {} }))).toBe(ent("must declare fields."))
    expect(failure(make({}, { fields: undefined }))).toBe(ent("must declare fields."))
    expect(failure(make({}, { fields: null }))).toBe(ent("must declare fields."))
  })

  it("rejects idempotency, audit and cache configurations that carry the removed flags", () => {
    expect(failure(make({ idempotency: { required: true } }))).toBe(ent("idempotency must use false or a configuration object without required."))
    expect(failure(make({ audit: { enabled: true } }))).toBe(ent("audit must use false or a configuration object without enabled."))
    expect(failure(make({ cache: { enabled: true } }))).toBe(ent("cache must use false or a configuration object without enabled."))
    expect(() => run(make({ idempotency: { namespace: "x" } }))).not.toThrow()
  })
})

describe("validateEntity field descriptors", () => {
  it.each([[[]], [null], ["string"], [5]])("rejects the descriptor %j", (descriptor) => {
    expect(failure(make({}, {}, { extra: descriptor }))).toBe(ent(`has an invalid field descriptor for "extra".`))
  })

  it.each([[{}], [{ type: 5 }], [{ type: "bogus" }], [{ type: "" }]])("rejects the field type of %j", (descriptor) => {
    expect(failure(make({}, {}, { extra: descriptor }))).toBe(ent(`has an invalid field type for "extra".`))
  })

  it("accepts every allowed type", () => {
    const fields: Loose = {
      s: { type: "string" },
      n: { type: "number" },
      b: { type: "boolean" },
      d: { type: "date" },
      j: { type: "json" },
      i: { type: "integer" },
      dec: { type: "decimal", precision: 5, scale: 2 },
      dt: { type: "datetime" },
      u: { type: "uuid" },
      e: { type: "enum", enumValues: ["a", "b"] },
    }
    for (const [key, descriptor] of Object.entries(fields)) {
      expect(() => run(make({}, {}, { [key]: descriptor })), key).not.toThrow()
    }
  })

  it("treats custom as an allowed type that still fails closed", () => {
    expect(failure(make({}, {}, { c: { type: "custom" } }))).toBe(ent(`custom field "c" requires a registered durable codec.`))
  })

  it("validates the nullable flag", () => {
    expect(failure(make({}, {}, { extra: { type: "string", nullable: "yes" } }))).toBe(ent(`has an invalid nullable flag for "extra".`))
    expect(failure(make({}, {}, { extra: { type: "string", nullable: null } }))).toBe(ent(`has an invalid nullable flag for "extra".`))
    expect(() => run(make({}, {}, { a: { type: "string", nullable: true }, b: { type: "string", nullable: false } }))).not.toThrow()
  })

  it("accepts every allowed format and rejects the rest", () => {
    for (const format of ["text", "email", "phone", "date", "identifier", "json"]) {
      expect(() => run(make({}, {}, { extra: { type: "string", format } })), format).not.toThrow()
    }
    for (const format of ["", "bogus", 5, null]) {
      expect(failure(make({}, {}, { extra: { type: "string", format } }))).toBe(ent(`has an invalid field format for "extra".`))
    }
  })

  it("lets an integer omit but not declare a format", () => {
    expect(() => run(make({}, {}, { extra: { type: "integer" } }))).not.toThrow()
    expect(failure(make({}, {}, { extra: { type: "integer", format: "text" } }))).toBe(ent(`integer field "extra" cannot declare a string format.`))
    expect(() => run(make({}, {}, { extra: { type: "number", format: "text" } }))).not.toThrow()
  })

  it("validates decimal precision and scale on each side", () => {
    const bad = ent(`has invalid decimal precision/scale for "price".`)
    for (const descriptor of [
      { type: "decimal" },
      { type: "decimal", precision: undefined, scale: 0 },
      { type: "decimal", precision: 5 },
      { type: "decimal", precision: "5", scale: 2 },
      { type: "decimal", precision: 5, scale: "2" },
      { type: "decimal", precision: 5.5, scale: 2 },
      { type: "decimal", precision: 5, scale: 1.5 },
      { type: "decimal", precision: 0, scale: 0 },
      { type: "decimal", precision: -1, scale: 0 },
      { type: "decimal", precision: 5, scale: -1 },
      { type: "decimal", precision: 5, scale: 6 },
      { type: "decimal", precision: Number.MAX_SAFE_INTEGER + 1, scale: 0 },
    ]) {
      expect(failure(make({}, {}, { price: descriptor })), JSON.stringify(descriptor)).toBe(bad)
    }
    for (const descriptor of [
      { type: "decimal", precision: 1, scale: 0 },
      { type: "decimal", precision: 3, scale: 3 },
      { type: "decimal", precision: 10, scale: 2 },
    ]) {
      expect(() => run(make({}, {}, { price: descriptor })), JSON.stringify(descriptor)).not.toThrow()
    }
  })

  it("validates enum values", () => {
    const bad = ent(`has invalid enum values for "kind".`)
    for (const descriptor of [
      { type: "enum" },
      { type: "enum", enumValues: "abc" },
      { type: "enum", enumValues: { length: 1 } },
      { type: "enum", enumValues: [] },
      { type: "enum", enumValues: ["a", "a"] },
      { type: "enum", enumValues: [1] },
      { type: "enum", enumValues: [""] },
      { type: "enum", enumValues: ["a", 1] },
      { type: "enum", enumValues: ["a", ""] },
    ]) {
      expect(failure(make({}, {}, { kind: descriptor })), JSON.stringify(descriptor)).toBe(bad)
    }
    expect(() => run(make({}, {}, { kind: { type: "enum", enumValues: ["a", "b", "c"] } }))).not.toThrow()
  })

  it("requires a registered durable codec with both functions for custom fields, then fails closed", () => {
    const needsCodec = ent(`custom field "c" requires a registered durable codec.`)
    const unsupported = ent(`custom field "c" is not yet supported: durable codecs are not applied by the persistence mapping.`)
    const encode = () => "x"
    const decode = () => "y"
    const custom = (durableCodec: unknown) => ({ c: { type: "custom", durableCodec } })
    expect(failure(make({ durableCodecs: { k: { encode, decode } } }, {}, custom(undefined)))).toBe(needsCodec)
    expect(failure(make({}, {}, custom("k")))).toBe(needsCodec)
    expect(failure(make({ durableCodecs: {} }, {}, custom("k")))).toBe(needsCodec)
    expect(failure(make({ durableCodecs: {} }, {}, custom("toString")))).toBe(needsCodec)
    expect(failure(make({ durableCodecs: { "5": { encode, decode } } }, {}, custom(5)))).toBe(needsCodec)
    expect(failure(make({ durableCodecs: { k: { decode } } }, {}, custom("k")))).toBe(needsCodec)
    expect(failure(make({ durableCodecs: { k: { encode } } }, {}, custom("k")))).toBe(needsCodec)
    expect(failure(make({ durableCodecs: { k: { encode: "x", decode } } }, {}, custom("k")))).toBe(needsCodec)
    expect(failure(make({ durableCodecs: { k: { encode, decode: "y" } } }, {}, custom("k")))).toBe(needsCodec)
    expect(failure(make({ durableCodecs: { k: undefined } }, {}, custom("k")))).toBe(needsCodec)
    expect(failure(make({ durableCodecs: { k: { encode, decode } } }, {}, custom("k")))).toBe(unsupported)
  })

  it("accepts every data classification and rejects unknown ones on a descriptor", () => {
    for (const classification of ["public", "internal", "confidential", "restricted"]) {
      expect(() => run(make({}, {}, { extra: { type: "string", classification } })), classification).not.toThrow()
    }
    for (const classification of ["", "secret", 5, null]) {
      expect(failure(make({}, {}, { extra: { type: "string", classification } }))).toBe(ent(`has invalid data classification for "extra".`))
    }
  })
})

describe("validateEntity keys and scope", () => {
  it("names the referenced field in each key error", () => {
    expect(failure(make({}, { tenantField: "ghost" }))).toBe(ent(`references unknown tenant field "ghost".`))
    expect(failure(make({}, { versionField: "ghost" }))).toBe(ent(`references unknown version field "ghost".`))
    expect(failure(make({}, { primaryKey: "ghost" }))).toBe(ent(`references unknown primary key "ghost".`))
    expect(failure(make({}, { primaryKey: undefined }))).toBe(ent("has an invalid primary key."))
    expect(failure(make({}, { primaryKey: "" }))).toBe(ent("has an invalid primary key."))
    expect(failure(make({}, { versionField: "name" }))).toBe(ent(`requires version field "name" to have type "number".`))
    expect(() => run(make({}, { tenantField: undefined }, {}), {})).toThrowError(new ConfigurationError(`Entity "person" requests tenant scoping but declares no tenantField.`))
  })

  it("validates the application scope field", () => {
    const app = (field: unknown) => make({ entityScope: field === undefined ? { kind: "application" } : { kind: "application", field } }, { tenantField: undefined })
    expect(failure(app("ghost"))).toBe(ent(`references unknown application scope field "ghost".`))
    expect(failure(app(undefined))).toBe(ent("has an invalid application scope field."))
    expect(() => run(app("name"))).not.toThrow()
  })

  it("requires platform and system scopes to acknowledge", () => {
    for (const kind of ["platform", "system"]) {
      expect(failure(make({ entityScope: { kind } }, { tenantField: undefined }))).toBe(ent(`must acknowledge entityScope kind "${kind}".`))
      expect(failure(make({ entityScope: { kind, acknowledged: "yes" } }, { tenantField: undefined }))).toBe(ent(`must acknowledge entityScope kind "${kind}".`))
      expect(() => run(make({ entityScope: { kind, acknowledged: true } }, { tenantField: undefined }))).not.toThrow()
    }
  })

  it("reports tenant field and scope mismatches", () => {
    expect(failure(make({ entityScope: { kind: "platform", acknowledged: true } }))).toBe(
      'Entity "person" declares tenantField "tenantId" but entityScope is not tenant. Remove tenantField if this entity is not tenant-scoped.',
    )
  })

  it("validates the data classification map", () => {
    expect(failure(make({ dataClassification: { ghost: "public" } }))).toBe(ent(`references unknown data classification field "ghost".`))
    expect(failure(make({ dataClassification: { name: "secret" } }))).toBe(ent(`has invalid data classification for "name".`))
    expect(failure(make({ dataClassification: { name: 5 } }))).toBe(ent(`has invalid data classification for "name".`))
    for (const classification of ["public", "internal", "confidential", "restricted"]) {
      expect(() => run(make({ dataClassification: { name: classification } })), classification).not.toThrow()
    }
  })
})

describe("validateEntity lifecycle", () => {
  const softFields = { deletedAt: { type: "datetime", nullable: true } }

  it("validates the soft-delete field", () => {
    const soft = (deletedAtField: unknown, extra: Loose = softFields, entityOver: Loose = {}) =>
      make({ lifecycle: { kind: "soft-delete", deletedAtField } }, entityOver, extra)
    expect(failure(soft("ghost"))).toBe(ent(`references unknown soft-delete field "ghost".`))
    expect(failure(soft(undefined))).toBe(ent("has an invalid soft-delete field."))
    const notNullable = ent("soft-delete field must be a nullable date or datetime.")
    expect(failure(soft("deletedAt", { deletedAt: { type: "datetime" } }))).toBe(notNullable)
    expect(failure(soft("deletedAt", { deletedAt: { type: "datetime", nullable: false } }))).toBe(notNullable)
    expect(failure(soft("deletedAt", { deletedAt: { type: "string", nullable: true } }))).toBe(notNullable)
    expect(failure(soft("name"))).toBe(notNullable)
    expect(() => run(soft("deletedAt", { deletedAt: { type: "date", nullable: true } }))).not.toThrow()
    expect(() => run(soft("deletedAt"))).not.toThrow()
  })

  it("requires optimistic concurrency from either source for soft delete", () => {
    const message = ent("soft-delete lifecycle requires optimistic concurrency.")
    const lifecycle = { kind: "soft-delete", deletedAtField: "deletedAt" }
    expect(failure(make({ lifecycle }, { versionField: undefined }, softFields))).toBe(message)
    expect(failure(make({ lifecycle, optimisticConcurrency: {} }, { versionField: undefined }, softFields))).toBe(message)
    expect(() => run(make({ lifecycle, optimisticConcurrency: { versionField: "version" } }, { versionField: undefined }, softFields))).not.toThrow()
    expect(() => run(make({ lifecycle }, {}, softFields))).not.toThrow()
  })

  it("lets an append-only entity keep only read and create routes", () => {
    const message = ent("append-only lifecycle cannot enable update or delete routes.")
    const appendOnly = make({ lifecycle: { kind: "append-only" } })
    expect(failure(appendOnly)).toBe(message)
    expect(failure(appendOnly, { update: false })).toBe(message)
    expect(failure(appendOnly, { delete: false })).toBe(message)
    expect(() => run(appendOnly, { update: false, delete: false })).not.toThrow()
  })

  it("accepts hard-delete and rejects unknown lifecycle kinds", () => {
    expect(() => run(make({ lifecycle: { kind: "hard-delete" } }))).not.toThrow()
    expect(failure(make({ lifecycle: { kind: "weird" } }))).toBe(ent("has an invalid lifecycle policy."))
    expect(failure(make({ lifecycle: { kind: "weird" } }), { update: false, delete: false })).toBe(ent("has an invalid lifecycle policy."))
  })
})

describe("validateEntity capability policy", () => {
  it.each([[undefined], [null], ["policy"], [5], [[]]])("rejects the policy %j", (policy) => {
    expect(failure(make({ policy }))).toBe(ent("has an invalid capability configuration."))
  })

  it("rejects framework-reserved capability keys but not other keys", () => {
    for (const key of ["cache", "objectStore", "deferredExecution", "bypassAuthority"]) {
      expect(failure(make({ policy: { customCapabilityKey: key } }))).toBe(
        `Entity "person" declares capability key "${key}" which collides with a framework-reserved capability name.`,
      )
    }
    expect(() => run(make({ policy: { customCapabilityKey: "manage" } }))).not.toThrow()
    expect(() => run(make({ policy: { skipCapabilityCheck: true } }))).not.toThrow()
  })
})

describe("validateEntity list defaults and concurrency", () => {
  it("validates the default sort direction", () => {
    expect(failure(make({ listDefaults: { sortDesc: "yes" } }))).toBe(ent("has an invalid default sort direction."))
    expect(() => run(make({ listDefaults: { sortDesc: true } }))).not.toThrow()
    expect(() => run(make({ listDefaults: { sortDesc: false } }))).not.toThrow()
    expect(() => run(make({ listDefaults: {} }))).not.toThrow()
  })

  it("validates the default sort column", () => {
    expect(failure(make({ listDefaults: { sortColumn: "ghost" } }))).toBe(ent(`references unknown default sort "ghost".`))
    expect(failure(make({ listDefaults: { sortColumn: "name" }, sortableColumns: ["id"] }))).toBe(
      ent(`default sort column "name" must be declared in sortableColumns and be queryable under its data classification.`),
    )
    expect(failure(make({ listDefaults: { sortColumn: "name" }, dataClassification: { name: "restricted" } }))).toBe(
      ent(`default sort column "name" must be declared in sortableColumns and be queryable under its data classification.`),
    )
    expect(() => run(make({ listDefaults: { sortColumn: "name" }, sortableColumns: ["name"] }))).not.toThrow()
    expect(() => run(make({ listDefaults: { sortColumn: "name" } }))).not.toThrow()
  })

  it("validates the concurrency version field", () => {
    expect(failure(make({ optimisticConcurrency: { versionField: "ghost" } }, { versionField: undefined }))).toBe(
      ent(`references unknown concurrency version "ghost".`),
    )
    expect(failure(make({ optimisticConcurrency: {} }, { versionField: undefined }))).toBe(ent("has an invalid concurrency version."))
    expect(failure(make({ optimisticConcurrency: { versionField: "name" } }, { versionField: undefined }))).toBe(
      ent(`requires concurrency version field "name" to have type "number".`),
    )
    expect(failure(make({ optimisticConcurrency: { versionField: "other" } }, {}, { other: { type: "number" } }))).toBe(
      ent("has conflicting concurrency version fields."),
    )
    expect(() => run(make({ optimisticConcurrency: {} }))).not.toThrow()
    expect(() => run(make({ optimisticConcurrency: { versionField: "version" } }))).not.toThrow()
    expect(() => run(make({ optimisticConcurrency: { versionField: "other" } }, { versionField: undefined }, { other: { type: "number" } }))).not.toThrow()
  })

  it("requires a version field when update or delete is enabled", () => {
    const message =
      'Entity "person" enables update or delete routes but declares no version field. Optimistic concurrency is mandatory for mutating routes: declare entity.versionField or optimisticConcurrency.versionField as a numeric field.'
    const unversioned = make({}, { versionField: undefined })
    expect(failure(unversioned)).toBe(message)
    expect(failure(unversioned, { update: false })).toBe(message)
    expect(failure(unversioned, { delete: false })).toBe(message)
    expect(() => run(unversioned, { update: false, delete: false })).not.toThrow()
  })
})

describe("validateEntity rate limits", () => {
  const limit = (over: Loose = {}) => ({ max: 1, timeWindow: 60, consistency: "atomic", ...over })
  const rate = (config: unknown, route = "list") => make({ rateLimit: { [route]: config } })

  it("accepts each route and rejects unknown routes", () => {
    for (const route of ["list", "detail", "create", "update", "delete"]) {
      expect(() => run(rate(limit(), route)), route).not.toThrow()
    }
    expect(failure(rate(limit(), "bogus"))).toBe(ent("has an invalid rate-limit route."))
    expect(failure(rate(limit(), ""))).toBe(ent("has an invalid rate-limit route."))
  })

  it("validates max", () => {
    for (const max of [0, -1, 1.5, Number.NaN, "1", undefined]) {
      expect(failure(rate(limit({ max })))).toBe(ent("has an invalid rate-limit max for list."))
    }
    expect(failure(rate(null))).toBe(ent("has an invalid rate-limit max for list."))
    expect(failure(rate(limit({ max: 0 }), "detail"))).toBe(ent("has an invalid rate-limit max for detail."))
  })

  it("requires atomic or best-effort consistency", () => {
    for (const consistency of [undefined, "weak", "", "ATOMIC"]) {
      expect(failure(rate(limit({ consistency })))).toBe(ent("must declare rate-limit consistency for list."))
    }
    expect(() => run(rate(limit({ consistency: "atomic" })))).not.toThrow()
    expect(() => run(rate(limit({ consistency: "best-effort" })))).not.toThrow()
  })

  it("validates the algorithm", () => {
    for (const algorithm of ["fixed-window", "sliding-window", "token-bucket", undefined]) {
      expect(() => run(rate(limit({ algorithm }))), String(algorithm)).not.toThrow()
    }
    for (const algorithm of ["leaky", "", null, 5]) {
      expect(failure(rate(limit({ algorithm })))).toBe(ent("has an invalid rate-limit algorithm for list."))
    }
  })

  it("validates the cost", () => {
    for (const cost of [0, -1, 1.5, Number.NaN, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(failure(rate(limit({ cost })))).toBe(ent("has an invalid rate-limit cost for list."))
    }
    expect(() => run(rate(limit({ cost: 1 })))).not.toThrow()
    expect(() => run(rate(limit({ cost: 7 })))).not.toThrow()
  })

  it("validates numeric windows", () => {
    for (const timeWindow of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(failure(rate(limit({ timeWindow })))).toBe(ent("has an invalid rate-limit window for list."))
    }
    expect(() => run(rate(limit({ timeWindow: 0.5 })))).not.toThrow()
    expect(() => run(rate(limit({ timeWindow: 1 })))).not.toThrow()
  })

  it("validates string windows", () => {
    for (const timeWindow of [
      "1 second", "30 seconds", "5 minute", "5 minutes", "1 hour", "12 hours", "1second", "12seconds", "1   hour", "1 HOUR", "2 Minutes", " 1 hour ", "\t3 hours\n",
    ]) {
      expect(() => run(rate(limit({ timeWindow }))), JSON.stringify(timeWindow)).not.toThrow()
    }
    for (const timeWindow of [
      "", "second", "0 seconds", "01 seconds", "1 day", "1.5 hours", "x1 second", "1 secondx", "1abc second", "1 x seconds", "-1 hours", "1 hour 1 hour", undefined, null, {}, [],
    ]) {
      expect(failure(rate(limit({ timeWindow }))), JSON.stringify(timeWindow)).toBe(ent("has an invalid rate-limit window for list."))
    }
  })
})

describe("validateEntity audit, search, cache and validation schemas", () => {
  it("requires an audit resource name", () => {
    expect(failure(make({ audit: {} }))).toBe('Entity "person" has audit enabled but no resource name.')
    expect(failure(make({ audit: { resource: "" } }))).toBe('Entity "person" has audit enabled but no resource name.')
    expect(() => run(make({ audit: { resource: "person" } }))).not.toThrow()
    expect(() => run(make({ audit: false }))).not.toThrow()
    expect(() => run(make({}))).not.toThrow()
  })

  it("validates the audit field classification", () => {
    const audit = (fieldClassification: unknown) => make({ audit: { resource: "person", fieldClassification } })
    expect(failure(audit({ ghost: "mask" }))).toBe(ent(`references unknown audit classification field "ghost".`))
    expect(failure(audit({ name: "hide" }))).toBe(ent(`has an invalid audit classification for "name".`))
    expect(failure(audit({ name: undefined }))).toBe(ent(`has an invalid audit classification for "name".`))
    for (const classification of ["include", "mask", "omit"]) {
      expect(() => run(audit({ name: classification })), classification).not.toThrow()
    }
    expect(() => run(audit(undefined))).not.toThrow()
  })

  it("validates the search strategy", () => {
    expect(failure(make({ searchStrategy: { kind: "bogus" } }))).toBe(ent("has an invalid search strategy."))
    expect(failure(make({ searchStrategy: { kind: "" } }))).toBe(ent("has an invalid search strategy."))
    expect(() => run(make({ searchStrategy: { kind: "contains" } }))).not.toThrow()
    expect(() => run(make({ searchStrategy: { kind: "prefix" } }))).not.toThrow()
    expect(() => run(make({ searchStrategy: { kind: "fullText", portKey: "search" } }))).not.toThrow()
    const portless = ent("uses fullText search without a compiled SearchPort key.")
    expect(failure(make({ searchStrategy: { kind: "fullText" } }))).toBe(portless)
    expect(failure(make({ searchStrategy: { kind: "fullText", portKey: "" } }))).toBe(portless)
    expect(failure(make({ searchStrategy: { kind: "fullText", portKey: "   " } }))).toBe(portless)
  })

  it("requires both a cache tag and a key prefix", () => {
    const message = 'Entity "person" has cache enabled but no cache tag/keyPrefix.'
    expect(failure(make({ cache: {} }))).toBe(message)
    expect(failure(make({ cache: { tag: "t" } }))).toBe(message)
    expect(failure(make({ cache: { keyPrefix: "p" } }))).toBe(message)
    expect(failure(make({ cache: { tag: "", keyPrefix: "p" } }))).toBe(message)
    expect(() => run(make({ cache: { tag: "t", keyPrefix: "p" } }))).not.toThrow()
    expect(() => run(make({ cache: false }))).not.toThrow()
  })

  it("requires body schemas for the enabled mutating routes", () => {
    const create = 'Entity "person" enables create but provides no createBody validation schema.'
    const update = 'Entity "person" enables update but provides no updateBody validation schema.'
    expect(failure(make({ validation: undefined }))).toBe(create)
    expect(failure(make({ validation: undefined }), { create: false })).toBe(update)
    expect(failure(make({ validation: { createBody: schema } }))).toBe(update)
    expect(failure(make({ validation: { updateBody: schema } }))).toBe(create)
    expect(() => run(make({ validation: undefined }), { create: false, update: false })).not.toThrow()
    expect(() => run(make({ validation: { createBody: schema } }), { update: false })).not.toThrow()
  })

  it("rejects invalid query limits and names the entity", () => {
    expect(failure(make({ queryLimits: null }))).toBe(ent("has invalid query limits."))
    expect(failure(make({ queryLimits: { bogus: 1 } }))).toBe(ent("declares unknown query limit bogus."))
    expect(failure(make({ queryLimits: { maxCount: 0 } }))).toBe(ent("has an invalid query limit for maxCount."))
    expect(() => run(make({ queryLimits: { maxCount: 10, maxOffset: 5, maxSearchableColumns: 2, maxPredicateDepth: 3 } }))).not.toThrow()
  })

  it("rejects duplicate field lists with their label", () => {
    expect(failure(make({ searchableColumns: ["name", "name"] }))).toBe(ent("has duplicate searchable."))
    expect(failure(make({ filterableColumns: ["name", "name"] }))).toBe(ent("has duplicate filterable."))
    expect(failure(make({ sortableColumns: ["name", "name"] }))).toBe(ent("has duplicate sortable."))
    expect(failure(make({}, { immutableFields: ["name", "name"] }))).toBe(ent("has duplicate immutable fields."))
    expect(failure(make({ searchableColumns: ["ghost"] }))).toBe(ent(`references unknown searchable field "ghost".`))
    expect(failure(make({ filterableColumns: ["ghost"] }))).toBe(ent(`references unknown filterable field "ghost".`))
    expect(failure(make({ sortableColumns: ["ghost"] }))).toBe(ent(`references unknown sortable field "ghost".`))
    expect(failure(make({}, { immutableFields: ["ghost"] }))).toBe(ent(`references unknown immutable fields field "ghost".`))
  })
})

describe("validateEntity crud lifecycle", () => {
  const fn = () => Promise.resolve()
  const crud = (value: unknown) => make({ crud: value })
  const HOOKS: Record<string, string[]> = {
    list: ["transformQuery", "projectResult"],
    detail: ["projectResult"],
    create: ["transformInput", "projectCommittedResult", "afterCommit"],
    update: ["transformInput", "projectCommittedResult", "afterCommit"],
    delete: ["beforeDelete", "afterCommit"],
  }

  it("accepts undefined and rejects non-object crud configuration", () => {
    expect(() => run(make({ crud: undefined }))).not.toThrow()
    expect(() => run(crud({}))).not.toThrow()
    for (const value of [null, "x", 5, true, []]) {
      expect(failure(crud(value)), JSON.stringify(value)).toBe(ent("has an invalid crud configuration."))
    }
  })

  it("accepts every documented hook on its route and nothing else", () => {
    for (const [route, hooks] of Object.entries(HOOKS)) {
      for (const hook of hooks) {
        expect(() => run(crud({ [route]: { [hook]: fn } })), `${route}.${hook}`).not.toThrow()
      }
      expect(() => run(crud({ [route]: Object.fromEntries(hooks.map((hook) => [hook, fn])) })), route).not.toThrow()
      expect(failure(crud({ [route]: { bogus: fn } }))).toBe(
        `Entity "person" has invalid hook "bogus" for route "${route}". Allowed hooks: ${hooks.join(", ")}.`,
      )
    }
    for (const [route, hooks] of Object.entries(HOOKS)) {
      const foreign = Object.values(HOOKS).flat().filter((hook) => !hooks.includes(hook))
      for (const hook of foreign) {
        expect(failure(crud({ [route]: { [hook]: fn } })), `${route}.${hook}`).toBe(
          `Entity "person" has invalid hook "${hook}" for route "${route}". Allowed hooks: ${hooks.join(", ")}.`,
        )
      }
    }
  })

  it("requires hooks to be functions and skips undefined hooks", () => {
    expect(failure(crud({ list: { projectResult: "x" } }))).toBe(
      'Entity "person" has an invalid hook "projectResult" for route "list" — hook must be a function.',
    )
    expect(failure(crud({ delete: { beforeDelete: null } }))).toBe(
      'Entity "person" has an invalid hook "beforeDelete" for route "delete" — hook must be a function.',
    )
    expect(() => run(crud({ list: { projectResult: undefined } }))).not.toThrow()
  })

  it("treats undefined and null route hooks as absent and rejects other non-objects", () => {
    expect(() => run(crud({ list: undefined }))).not.toThrow()
    expect(() => run(crud({ list: null }))).not.toThrow()
    for (const route of Object.keys(HOOKS)) {
      for (const value of ["x", 5, true, []]) {
        expect(failure(crud({ [route]: value })), `${route} ${JSON.stringify(value)}`).toBe(
          `Entity "person" has an invalid crud hooks configuration for route "${route}".`,
        )
      }
    }
  })

  it("rejects unknown routes that look like hook objects or functions but tolerates plain data", () => {
    const unknown = (route: string) => ent(`has an invalid crud route "${route}".`)
    for (const hook of new Set(Object.values(HOOKS).flat())) {
      expect(failure(crud({ extra: { [hook]: fn } })), hook).toBe(unknown("extra"))
      expect(failure(crud({ extra: { other: 1, [hook]: fn } })), hook).toBe(unknown("extra"))
    }
    expect(failure(crud({ extra: fn }))).toBe(unknown("extra"))
    expect(() => run(crud({ extra: { nested: { value: 1 } } }))).not.toThrow()
    expect(() => run(crud({ extra: {} }))).not.toThrow()
    expect(() => run(crud({ extra: "x" }))).not.toThrow()
    expect(() => run(crud({ extra: 5 }))).not.toThrow()
    expect(() => run(crud({ extra: null }))).not.toThrow()
    expect(() => run(crud({ extra: undefined }))).not.toThrow()
    expect(() => run(crud({ extra: ["afterCommit"] }))).not.toThrow()
    const hooked: unknown[] = []
    Object.assign(hooked, { afterCommit: fn })
    expect(() => run(crud({ extra: hooked }))).not.toThrow()
  })

  it("treats each documented route name as a known route, not plain data", () => {
    for (const route of Object.keys(HOOKS)) {
      expect(() => run(crud({ [route]: {} })), route).not.toThrow()
    }
    expect(() => run(crud({ detail: { projectResult: fn } }))).not.toThrow()
    expect(() => run(crud({ delete: { beforeDelete: fn } }))).not.toThrow()
  })
})
