import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import { defineEntity } from "../defineEntity"
import type { CompiledEntityDefinition } from "../compileEntity"

type Loose = Record<string, unknown>
type Row = Record<string, unknown>

const schema = { parse: (value: unknown) => value } as never

function inputOf(over: Loose = {}, entityOver: Loose = {}): never {
  const entity: Loose = {
    name: "person",
    primaryKey: "id",
    tenantField: "tenantId",
    versionField: "version",
    fields: {
      id: { type: "string" },
      tenantId: { type: "string" },
      name: { type: "string" },
      version: { type: "number" },
    },
    ...entityOver,
  }
  // An override of `undefined` removes the key, so absent and undefined stay distinguishable.
  for (const key of Object.keys(entityOver)) if (entityOver[key] === undefined) delete entity[key]
  return {
    moduleKey: "tenant.people",
    entity,
    entityScope: { kind: "tenant" },
    policy: { skipCapabilityCheck: true },
    validation: { createBody: schema, updateBody: schema },
    ...over,
  } as never
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

describe("defineEntity route normalization", () => {
  it("enables every route by default and honours each false flag independently", () => {
    expect(define({}).routes).toStrictEqual({ list: true, detail: true, create: true, update: true, delete: true })
    expect(define({ routes: {} }).routes).toStrictEqual({ list: true, detail: true, create: true, update: true, delete: true })
    expect(define({ routes: { list: false } }).routes).toStrictEqual({ list: false, detail: true, create: true, update: true, delete: true })
    expect(define({ routes: { detail: false } }).routes).toStrictEqual({ list: true, detail: false, create: true, update: true, delete: true })
    expect(define({ routes: { create: false } }).routes).toStrictEqual({ list: true, detail: true, create: false, update: true, delete: true })
    expect(define({ routes: { update: false } }).routes).toStrictEqual({ list: true, detail: true, create: true, update: false, delete: true })
    expect(define({ routes: { delete: false } }).routes).toStrictEqual({ list: true, detail: true, create: true, update: true, delete: false })
    expect(define({ routes: { list: true, detail: true } }).routes).toStrictEqual({ list: true, detail: true, create: true, update: true, delete: true })
  })
})

describe("defineEntity capability policy normalization", () => {
  it("stores exactly one branch of the policy", () => {
    expect(define({ policy: { skipCapabilityCheck: true } }).policy).toStrictEqual({ skipCapabilityCheck: true })
    expect(define({ policy: { customCapabilityKey: "manage" } }).policy).toStrictEqual({ customCapabilityKey: "manage" })
    expect(define({ policy: { customCapabilityKey: "manage", skipCapabilityCheck: false } }).policy).toStrictEqual({ customCapabilityKey: "manage" })
  })
})

describe("defineEntity audit normalization", () => {
  it("normalizes disabled audit to false", () => {
    expect(define({ audit: false }).audit).toBe(false)
    expect(define({}).audit).toBe(false)
  })

  it("applies audit defaults", () => {
    const audit = define({ audit: {} }).audit
    expect(audit).toStrictEqual({
      resource: "person",
      emitOn: ["create", "update", "delete"],
      includeValues: true,
      readAudit: false,
    })
  })

  it("keeps explicit audit values, including falsy ones", () => {
    const audit = define({
      audit: {
        resource: "people",
        emitOn: ["create"],
        includeValues: false,
        readAudit: true,
        required: false,
        auditGuarantee: "atomic",
        fallbackAuditGuarantee: "best-effort",
        requiredStateSemantics: "committed-state",
      },
    }).audit
    expect(audit).toStrictEqual({
      resource: "people",
      emitOn: ["create"],
      includeValues: false,
      readAudit: true,
      required: false,
      auditGuarantee: "atomic",
      fallbackAuditGuarantee: "best-effort",
      requiredStateSemantics: "committed-state",
    })
    expect(define({ audit: { required: true } }).audit).toMatchObject({ required: true })
  })

  it("copies the emit list and the classification map instead of aliasing them", () => {
    const emitOn: Array<"create" | "update" | "delete"> = ["create", "update"]
    const fieldClassification = { name: "mask" }
    const audit = define({ audit: { emitOn, fieldClassification } }).audit
    if (audit === false) throw new Error("audit expected")
    expect(audit.emitOn).not.toBe(emitOn)
    expect(audit.emitOn).toStrictEqual(["create", "update"])
    expect(audit.fieldClassification).not.toBe(fieldClassification)
    expect(audit.fieldClassification).toStrictEqual({ name: "mask" })
    const defaults = define({ audit: {} }).audit
    const again = define({ audit: {} }).audit
    if (defaults === false || again === false) throw new Error("audit expected")
    expect(defaults.emitOn).not.toBe(again.emitOn)
    expect(Object.isFrozen(defaults.emitOn)).toBe(true)
  })

  it("omits optional audit keys that were not declared", () => {
    const audit = define({ audit: { resource: "p" } }).audit as object
    for (const key of ["required", "auditGuarantee", "fallbackAuditGuarantee", "requiredStateSemantics", "fieldClassification"]) {
      expect(Object.hasOwn(audit, key), key).toBe(false)
    }
  })

  it("rejects audit configurations that carry the removed enabled flag", () => {
    expect(messageOf(() => define({ audit: { enabled: true } }))).toBe('Entity "person" audit must use false or a configuration object without enabled.')
  })
})

describe("defineEntity cache normalization", () => {
  it("normalizes disabled cache to false", () => {
    expect(define({ cache: false }).cache).toBe(false)
    expect(define({}).cache).toBe(false)
  })

  it("defaults the tag and key prefix to the reserved entity namespace", () => {
    expect(define({ cache: {} }).cache).toStrictEqual({ tag: "entity:tenant.people:person", keyPrefix: "entity:tenant.people:person" })
    expect(define({ cache: {} }, { namespace: "ns" }).cache).toStrictEqual({ tag: "entity:tenant.people:ns:person", keyPrefix: "entity:tenant.people:ns:person" })
  })

  it("keeps an explicit tag or key prefix independently", () => {
    expect(define({ cache: { tag: "people" } }).cache).toStrictEqual({ tag: "people", keyPrefix: "entity:tenant.people:person" })
    expect(define({ cache: { keyPrefix: "ppl" } }).cache).toStrictEqual({ tag: "entity:tenant.people:person", keyPrefix: "ppl" })
    expect(define({ cache: { tag: "people", keyPrefix: "ppl" } }).cache).toStrictEqual({ tag: "people", keyPrefix: "ppl" })
  })

  it("reserves the tenant cache tag prefix", () => {
    expect(messageOf(() => define({ cache: { tag: "tenant:1:x", keyPrefix: "p" } }))).toBe(
      'Entity "person" cache tag must not start with the reserved "tenant:" prefix.',
    )
    expect(messageOf(() => define({ cache: { tag: "tenant:", keyPrefix: "p" } }))).toBe(
      'Entity "person" cache tag must not start with the reserved "tenant:" prefix.',
    )
    expect(define({ cache: { tag: "tenants", keyPrefix: "p" } }).cache).toStrictEqual({ tag: "tenants", keyPrefix: "p" })
    expect(define({ cache: { tag: "x:tenant:", keyPrefix: "p" } }).cache).toStrictEqual({ tag: "x:tenant:", keyPrefix: "p" })
    expect(define({ cache: { keyPrefix: "tenant:p" } }).cache).toStrictEqual({ tag: "entity:tenant.people:person", keyPrefix: "tenant:p" })
  })

  it("rejects cache configurations that carry the removed enabled flag", () => {
    expect(messageOf(() => define({ cache: { enabled: true } }))).toBe('Entity "person" cache must use false or a configuration object without enabled.')
  })
})

describe("defineEntity idempotency normalization", () => {
  it("normalizes the idempotency setting", () => {
    expect(define({ idempotency: false }).idempotency).toBe(false)
    expect(define({}).idempotency).toStrictEqual({})
    expect(define({ idempotency: {} }).idempotency).toStrictEqual({})
    expect(define({ idempotency: { namespace: "ns" } }).idempotency).toStrictEqual({ namespace: "ns" })
  })

  it("rejects idempotency configurations that carry the removed required flag", () => {
    expect(messageOf(() => define({ idempotency: { required: true } }))).toBe(
      'Entity "person" idempotency must use false or a configuration object without required.',
    )
  })
})

describe("defineEntity optional sections", () => {
  it("omits optional sections that were not declared", () => {
    const compiled = define({})
    for (const key of ["queryLimits", "searchStrategy", "filterFieldMeta", "listDefaults", "optimisticConcurrency"]) {
      expect(Object.hasOwn(compiled, key), key).toBe(false)
    }
  })

  it("copies the optional sections that were declared", () => {
    const queryLimits = { maxCount: 5 }
    const searchStrategy = { kind: "prefix" }
    const filterFieldMeta = { name: { label: "Name" } }
    const listDefaults = { sortColumn: "name", sortDesc: true }
    const optimisticConcurrency = { versionField: "version" }
    const compiled = define({ queryLimits, searchStrategy, filterFieldMeta, listDefaults, optimisticConcurrency, sortableColumns: ["name"] })
    expect(compiled.queryLimits).toStrictEqual({ maxCount: 5 })
    expect(compiled.queryLimits).not.toBe(queryLimits)
    expect(compiled.searchStrategy).toStrictEqual({ kind: "prefix" })
    expect(compiled.searchStrategy).not.toBe(searchStrategy)
    expect(compiled.filterFieldMeta).toStrictEqual({ name: { label: "Name" } })
    expect(compiled.filterFieldMeta).not.toBe(filterFieldMeta)
    expect(Object.isFrozen(compiled.filterFieldMeta)).toBe(true)
    expect(compiled.listDefaults).toStrictEqual({ sortColumn: "name", sortDesc: true })
    expect(Object.isFrozen(compiled.listDefaults)).toBe(true)
    expect(compiled.optimisticConcurrency).toStrictEqual({ versionField: "version" })
    expect(Object.isFrozen(compiled.optimisticConcurrency)).toBe(true)
  })

  it("defaults the plain collections and persistence source", () => {
    const compiled = define({})
    expect(compiled.searchableColumns).toStrictEqual([])
    expect(compiled.filterableColumns).toStrictEqual([])
    expect(compiled.sortableColumns).toStrictEqual([])
    expect(compiled.rateLimit).toStrictEqual({})
    expect(compiled.crud).toStrictEqual({})
    expect(compiled.durableCodecs).toStrictEqual({})
    expect(compiled.dataClassification).toStrictEqual({})
    expect(compiled.lifecycle).toStrictEqual({ kind: "hard-delete" })
    expect(compiled.persistenceSource).toBe("primary")
    expect(compiled.validation).toStrictEqual({ createBody: schema, updateBody: schema })
  })

  it("copies the declared column lists", () => {
    const searchableColumns = ["name"]
    const filterableColumns = ["name", "id"]
    const sortableColumns = ["id"]
    const compiled = define({ searchableColumns, filterableColumns, sortableColumns })
    expect(compiled.searchableColumns).toStrictEqual(["name"])
    expect(compiled.searchableColumns).not.toBe(searchableColumns)
    expect(compiled.filterableColumns).toStrictEqual(["name", "id"])
    expect(compiled.filterableColumns).not.toBe(filterableColumns)
    expect(compiled.sortableColumns).toStrictEqual(["id"])
    expect(compiled.sortableColumns).not.toBe(sortableColumns)
    searchableColumns.push("id")
    expect(compiled.searchableColumns).toStrictEqual(["name"])
  })
})

describe("defineEntity entity descriptor normalization", () => {
  it("takes the version field from whichever source declares it", () => {
    expect(define({}).entity.versionField).toBe("version")
    expect(define({ optimisticConcurrency: {} }).entity.versionField).toBe("version")
    expect(define({ optimisticConcurrency: { versionField: "version" } }).entity.versionField).toBe("version")
    const fromConcurrency = define({ optimisticConcurrency: { versionField: "version" } }, { versionField: undefined })
    expect(fromConcurrency.entity.versionField).toBe("version")
    expect(fromConcurrency.versionField).toBe("version")
  })

  it("rejects conflicting version fields", () => {
    const fields = {
      id: { type: "string" },
      tenantId: { type: "string" },
      version: { type: "number" },
      revision: { type: "number" },
    }
    expect(messageOf(() => define({ optimisticConcurrency: { versionField: "revision" } }, { fields }))).toBe(
      'Entity "person" has conflicting concurrency version fields.',
    )
  })

  it("infers the primary key only from an id field", () => {
    expect(define({}, { primaryKey: undefined }).primaryKey).toBe("id")
    expect(define({}, { primaryKey: undefined }).entity.primaryKey).toBe("id")
    expect(define({}, { primaryKey: "name" }).primaryKey).toBe("name")
    const noId = {
      fields: { key: { type: "string" }, tenantId: { type: "string" }, version: { type: "number" } },
    }
    expect(messageOf(() => define({}, { primaryKey: undefined, ...noId }))).toBe('Entity "person" has an invalid primary key.')
    expect(define({}, { primaryKey: "key", ...noId }).primaryKey).toBe("key")
  })

  it("does not alias the declared immutable fields", () => {
    const immutableFields = ["name"]
    const compiled = define({}, { immutableFields })
    expect(compiled.entity.immutableFields).toStrictEqual(["name"])
    expect(compiled.entity.immutableFields).not.toBe(immutableFields)
    immutableFields.push("id")
    expect(compiled.entity.immutableFields).toStrictEqual(["name"])
  })

  it("freezes a copy of the declared fields", () => {
    const fields = { id: { type: "string" }, tenantId: { type: "string" }, version: { type: "number" } }
    const compiled = define({}, { fields })
    expect(compiled.entity.fields).not.toBe(fields)
    expect(Object.isFrozen(compiled.entity.fields)).toBe(true)
  })
})
