import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain"
import { Predicate } from "../../domain/predicate"
import { ENTITY_DEFINITION_BRAND, isEntityDefinition, registerEntityDefinition } from "../brands"
import { assertUniqueCacheKeyPrefixes, assertUniqueEntityCachePrefixes } from "../cachePrefixes"
import { assertCapabilityConfigValid, assertEntityCapabilityAvailable, resolveCapabilityKey } from "../capabilityCheck"
import { compileEntityScope } from "../entityScope"
import { compileEntityLifecycle } from "../lifecycle"
import { entityFieldClassifications, queryableFieldFilter } from "../queryableFields"
import { defineReadModelDefinition } from "../readModelDefinition"

function messageOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError)
    return (error as Error).message
  }
  throw new Error("expected a ConfigurationError")
}

describe("entity brands", () => {
  it("recognises only registered objects", () => {
    const registered = {}
    expect(isEntityDefinition(registered)).toBe(false)
    registerEntityDefinition(registered)
    expect(isEntityDefinition(registered)).toBe(true)
    expect(isEntityDefinition({})).toBe(false)
    expect(isEntityDefinition(null)).toBe(false)
    expect(isEntityDefinition(undefined)).toBe(false)
    expect(isEntityDefinition("x")).toBe(false)
    expect(isEntityDefinition(5)).toBe(false)
    expect(typeof ENTITY_DEFINITION_BRAND).toBe("symbol")
  })

  it("never treats a registered function as an entity definition", () => {
    const fn = () => undefined
    registerEntityDefinition(fn)
    expect(isEntityDefinition(fn)).toBe(false)
  })
})

describe("cache prefix uniqueness", () => {
  it("accepts distinct prefixes and an empty list", () => {
    expect(() => assertUniqueCacheKeyPrefixes([])).not.toThrow()
    expect(() => assertUniqueCacheKeyPrefixes([{ owner: "a", keyPrefix: "x" }, { owner: "b", keyPrefix: "y" }])).not.toThrow()
  })

  it("names both owners and the shared prefix", () => {
    expect(messageOf(() => assertUniqueCacheKeyPrefixes([{ owner: "a", keyPrefix: "x" }, { owner: "b", keyPrefix: "x" }]))).toBe(
      'Entities "a" and "b" share the cache key prefix "x"; each entity needs its own.',
    )
  })

  it("derives owners from module key and entity name and skips uncached entities", () => {
    const entity = (moduleKey: string, name: string, cache: false | { keyPrefix: string }) => ({ moduleKey, entity: { name }, cache })
    expect(() => assertUniqueEntityCachePrefixes([entity("m", "a", false), entity("m", "b", false)])).not.toThrow()
    expect(() => assertUniqueEntityCachePrefixes([entity("m", "a", { keyPrefix: "x" }), entity("m", "b", { keyPrefix: "y" })])).not.toThrow()
    expect(messageOf(() => assertUniqueEntityCachePrefixes([entity("m", "a", { keyPrefix: "x" }), entity("n", "b", false), entity("o", "c", { keyPrefix: "x" })]))).toBe(
      'Entities "m:a" and "o:c" share the cache key prefix "x"; each entity needs its own.',
    )
  })
})

describe("capability checks", () => {
  const manifest = { application: new Set(["manage"]), runtime: new Set<string>() }

  it("requires an enabled capability to be in the manifest", () => {
    expect(messageOf(() => assertEntityCapabilityAvailable({ customCapabilityKey: "other" }, manifest))).toBe(
      "Required entity capability 'other' is unavailable in the environment manifest.",
    )
    expect(() => assertEntityCapabilityAvailable({ customCapabilityKey: "manage" }, manifest)).not.toThrow()
  })

  it("does not consult the manifest when the check is skipped", () => {
    expect(() => assertEntityCapabilityAvailable({ skipCapabilityCheck: true }, { application: new Set(), runtime: new Set() })).not.toThrow()
  })

  it("rejects non-object configurations with the object message", () => {
    const message = "Invalid capability configuration: expected a CapabilityCheckConfig object."
    for (const config of [undefined, null, "abc", 5, true, []]) {
      expect(messageOf(() => assertCapabilityConfigValid(config)), JSON.stringify(config)).toBe(message)
    }
  })

  it("rejects non-boolean skip flags, contradictory and empty configurations", () => {
    expect(messageOf(() => assertCapabilityConfigValid({ skipCapabilityCheck: "yes" }))).toBe("skipCapabilityCheck must be boolean.")
    expect(messageOf(() => assertCapabilityConfigValid({ skipCapabilityCheck: true, customCapabilityKey: "x" }))).toBe(
      "Invalid capability configuration: cannot set both skipCapabilityCheck: true and customCapabilityKey.",
    )
    const neither = "Invalid capability configuration: must declare customCapabilityKey or set skipCapabilityCheck: true."
    expect(messageOf(() => assertCapabilityConfigValid({}))).toBe(neither)
    expect(messageOf(() => assertCapabilityConfigValid({ skipCapabilityCheck: false }))).toBe(neither)
    expect(messageOf(() => assertCapabilityConfigValid({ skipCapabilityCheck: undefined }))).toBe(neither)
  })

  it("accepts only well-formed capability keys", () => {
    for (const key of ["a", "ab", "manage", "Manage", "a1", "a:b", "a_b", "a-b", "a1:b_c-d", "A9"]) {
      expect(() => assertCapabilityConfigValid({ customCapabilityKey: key }), key).not.toThrow()
    }
    for (const key of ["", "1abc", "-a", "_a", ":a", "a b", "a.b", "a!", "ab$", "!abc", "abc!", " abc", "abc ", "a\nb", 5, null, {}]) {
      expect(messageOf(() => assertCapabilityConfigValid({ customCapabilityKey: key })), JSON.stringify(key)).toBe(
        `Invalid capability configuration: customCapabilityKey "${String(key)}" is not a valid capability key.`,
      )
    }
    expect(() => assertCapabilityConfigValid({ skipCapabilityCheck: false, customCapabilityKey: "x" })).not.toThrow()
    expect(() => assertCapabilityConfigValid({ skipCapabilityCheck: true })).not.toThrow()
  })

  it("resolves a canonical key", () => {
    expect(resolveCapabilityKey({ skipCapabilityCheck: true })).toStrictEqual({ enabled: false })
    expect(resolveCapabilityKey({ customCapabilityKey: "manage" })).toStrictEqual({ enabled: true, key: "manage" })
    expect(resolveCapabilityKey({ customCapabilityKey: "manage", skipCapabilityCheck: false })).toStrictEqual({ enabled: true, key: "manage" })
    expect(messageOf(() => resolveCapabilityKey({} as never))).toBe(
      "Invalid capability configuration: must declare customCapabilityKey or set skipCapabilityCheck: true.",
    )
  })
})

describe("entity scope compilation", () => {
  it("falls back to the tenant field only when the scope names none", () => {
    expect(compileEntityScope({ kind: "tenant", field: "a" }, "b")).toStrictEqual({ kind: "tenant", field: "a" })
    expect(compileEntityScope({ kind: "tenant" }, "b")).toStrictEqual({ kind: "tenant", field: "b" })
    expect(compileEntityScope({ kind: "tenant" }, undefined)).toStrictEqual({ kind: "tenant" })
    expect(Object.hasOwn(compileEntityScope({ kind: "tenant" }), "field")).toBe(false)
  })

  it("compiles application, platform and system scopes", () => {
    expect(compileEntityScope({ kind: "application", field: "app" }, "tenantId")).toStrictEqual({ kind: "application", field: "app" })
    const filter = Predicate.isNull("deletedAt")
    expect(compileEntityScope({ kind: "platform", acknowledged: true, scopeFilter: filter })).toStrictEqual({ kind: "platform", structuralFilter: filter })
    expect(compileEntityScope({ kind: "system", acknowledged: true, scopeFilter: filter })).toStrictEqual({ kind: "system", structuralFilter: filter })
    const bare = compileEntityScope({ kind: "platform", acknowledged: true })
    expect(bare).toStrictEqual({ kind: "platform" })
    expect(Object.hasOwn(bare, "structuralFilter")).toBe(false)
    expect(Object.hasOwn(bare, "field")).toBe(false)
    expect(compileEntityScope({ kind: "system", acknowledged: true })).toStrictEqual({ kind: "system" })
  })

  it("freezes every compiled scope", () => {
    expect(Object.isFrozen(compileEntityScope({ kind: "tenant" }, "t"))).toBe(true)
    expect(Object.isFrozen(compileEntityScope({ kind: "application", field: "a" }))).toBe(true)
    expect(Object.isFrozen(compileEntityScope({ kind: "platform", acknowledged: true }))).toBe(true)
  })
})

describe("entity lifecycle compilation", () => {
  it("compiles hard-delete", () => {
    const compiled = compileEntityLifecycle({ kind: "hard-delete" })
    expect(compiled).toStrictEqual({ kind: "hard-delete", protectedFields: [], deleteStrategy: "hard", restoreStrategy: "none" })
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.protectedFields)).toBe(true)
  })

  it("compiles append-only", () => {
    const compiled = compileEntityLifecycle({ kind: "append-only" })
    expect(compiled).toStrictEqual({ kind: "append-only", protectedFields: [], deleteStrategy: "forbidden", restoreStrategy: "forbidden" })
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.protectedFields)).toBe(true)
  })

  it("compiles soft-delete", () => {
    const compiled = compileEntityLifecycle({ kind: "soft-delete", deletedAtField: "deletedAt" })
    expect(compiled).toStrictEqual({
      kind: "soft-delete",
      deletedAtField: "deletedAt",
      activeRowFilter: Predicate.isNull("deletedAt"),
      protectedFields: ["deletedAt"],
      deleteStrategy: "occ-soft",
      restoreStrategy: "occ-restore",
    })
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.protectedFields)).toBe(true)
  })

  it("treats any other kind as hard-delete behaviour", () => {
    expect(compileEntityLifecycle({ kind: "weird" } as never)).toStrictEqual({ kind: "weird", protectedFields: [], deleteStrategy: "hard", restoreStrategy: "none" })
  })
})

describe("queryable fields", () => {
  it("merges descriptor classifications under the entity map", () => {
    const fields = { a: { classification: "restricted" }, b: { classification: "public" }, c: {}, d: undefined }
    expect(entityFieldClassifications(fields, undefined)).toStrictEqual({ a: "restricted", b: "public" })
    expect(entityFieldClassifications(fields, { a: "public", z: "internal" })).toStrictEqual({ a: "public", b: "public", z: "internal" })
  })

  it("tolerates fields that are not an object", () => {
    for (const fields of [undefined, null, 0, 5, false, ""]) {
      expect(entityFieldClassifications(fields, undefined), JSON.stringify(fields)).toStrictEqual({})
      expect(entityFieldClassifications(fields, { a: "public" }), JSON.stringify(fields)).toStrictEqual({ a: "public" })
    }
  })

  it("filters fields above the search ceiling", () => {
    const queryable = queryableFieldFilter({ pub: "public", int: "internal", conf: "confidential", sec: "restricted" })
    expect(queryable("pub")).toBe(true)
    expect(queryable("int")).toBe(true)
    expect(queryable("conf")).toBe(true)
    expect(queryable("sec")).toBe(false)
    expect(queryable("unclassified")).toBe(true)
    expect(queryable("toString")).toBe(true)
  })
})

describe("read model definitions", () => {
  const source = (key: string) => ({ source: key as never, capabilities: { readConsistency: ["eventual" as const], writable: false, localTransactions: false } })

  it("requires a non-blank key", () => {
    for (const key of ["", "   ", undefined, null]) {
      expect(messageOf(() => defineReadModelDefinition({ key } as never)), JSON.stringify(key)).toBe("Read model key must be non-empty.")
    }
  })

  it("defaults to one writable strong primary source", () => {
    const definition = defineReadModelDefinition({ key: "k" })
    expect(definition).toStrictEqual({
      key: "k",
      sources: [{ source: "primary", capabilities: { readConsistency: ["strong"], writable: true, localTransactions: true } }],
      consistency: "strong",
    })
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.sources)).toBe(true)
    expect(defineReadModelDefinition({ key: "k", sources: [] }).sources).toHaveLength(1)
  })

  it("keeps a single declared source with strong consistency regardless of the declaration", () => {
    const definition = defineReadModelDefinition({ key: "k", sources: [source("replica")], consistency: { kind: "eventual" } })
    expect(definition.sources).toStrictEqual([source("replica")])
    expect(definition.consistency).toBe("strong")
  })

  it("requires consistency semantics for several sources and rejects duplicates", () => {
    expect(messageOf(() => defineReadModelDefinition({ key: "k", sources: [source("a"), source("b")] }))).toBe(
      "Multi-source read model 'k' must declare consistency semantics.",
    )
    expect(messageOf(() => defineReadModelDefinition({ key: "k", sources: [source("a"), source("a")] }))).toBe("Read model 'k' has duplicate sources.")
    expect(messageOf(() => defineReadModelDefinition({ key: "k", sources: [source("a"), source("a")], consistency: { kind: "eventual" } }))).toBe(
      "Read model 'k' has duplicate sources.",
    )
    const multi = defineReadModelDefinition({ key: "k", sources: [source("a"), source("b")], consistency: { kind: "bounded-staleness", maxStalenessMs: 50 } })
    expect(multi.consistency).toStrictEqual({ kind: "bounded-staleness", maxStalenessMs: 50 })
    expect(multi.sources).toHaveLength(2)
  })
})
