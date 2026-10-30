import { describe, expect, it } from "vitest"
import type { NormalizedAbacPolicy } from "../abacTypes"
import type { PolicyFieldAccess } from "../abacPolicySchema"
import { ForbiddenError } from "../errors"
import {
  assertFieldQueryAccess,
  assertPolicyWritableFields,
  FIELD_READ_DEFAULT_KEY,
  hasRecordDependentFieldWrite,
  projectResponseRecord,
  resolveFieldQueryAccess,
  resolveFieldQueryDenials,
  resolveFieldReadOverrides,
  type FieldReadOverride,
} from "../fieldAccess"
import { Predicate, type PredicateNode } from "../predicate"
import type { FieldDescriptor, FieldFormat } from "../../persistence/provider"

interface PolicyOptions {
  effect?: "allow" | "deny"
  priority?: number
  actions?: string[]
  moduleKey?: string
  fieldAccess?: PolicyFieldAccess
  when?: PredicateNode
}

function policy(options: PolicyOptions = {}): NormalizedAbacPolicy {
  return {
    source: { policyId: "p", scopeType: "tenant_default" },
    moduleKey: options.moduleKey ?? "m",
    effect: options.effect ?? "allow",
    priority: options.priority ?? 100,
    payload: {
      actions: options.actions ?? ["read"],
      capabilities: [],
      conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
      ...(options.fieldAccess === undefined ? {} : { fieldAccess: options.fieldAccess }),
    },
    compiledConditions: options.when ?? Predicate.alwaysTrue(),
  }
}

const read = (map: Record<string, FieldReadOverride>, options: PolicyOptions = {}): NormalizedAbacPolicy => policy({ ...options, fieldAccess: { read: map } })
const write = (list: string[] | undefined, options: PolicyOptions = {}): NormalizedAbacPolicy =>
  policy({ actions: ["update"], ...options, ...(list === undefined ? {} : { fieldAccess: { write: list } }) })
const unknownCondition: PredicateNode = Predicate.eq("absent", "x")

describe("resolveFieldReadOverrides: selection", () => {
  const resolve = (policies: NormalizedAbacPolicy[], record: Record<string, unknown> = { secret: 1 }) => resolveFieldReadOverrides({ policies, moduleKey: "m", record })

  it("ignores other modules, other actions and policies without a read map", () => {
    expect(resolve([read({ secret: "omit" }, { effect: "deny", moduleKey: "other" })])).toEqual({})
    expect(resolve([read({ secret: "omit" }, { effect: "deny", actions: ["update"] })])).toEqual({})
    expect(resolve([policy({ effect: "deny" })])).toEqual({})
    expect(resolve([policy({ effect: "deny", fieldAccess: { write: ["secret"] } })])).toEqual({})
  })

  it("folds every deny read mode to omit", () => {
    expect(resolve([read({ secret: "allow" }, { effect: "deny" })])).toEqual({ secret: "omit" })
    expect(resolve([read({ secret: "mask" }, { effect: "deny" })])).toEqual({ secret: "omit" })
  })

  it("applies a deny whose condition is UNKNOWN but grants nothing from an UNKNOWN allow", () => {
    expect(resolve([read({ secret: "mask" }, { effect: "deny", when: unknownCondition })])).toEqual({ secret: "omit" })
    expect(resolve([read({ secret: "mask" }, { effect: "allow", when: unknownCondition })])).toEqual({})
    expect(resolve([read({ secret: "mask" }, { effect: "deny", when: Predicate.alwaysFalse() })])).toEqual({})
    expect(resolve([read({ secret: "mask" }, { effect: "allow", when: Predicate.alwaysFalse() })])).toEqual({})
  })
})

describe("resolveFieldReadOverrides: allowlists and priorities", () => {
  const resolve = (policies: NormalizedAbacPolicy[], record: Record<string, unknown>) => resolveFieldReadOverrides({ policies, moduleKey: "m", record })

  it("an allow read map is an allowlist that omits every other record field", () => {
    expect(resolve([read({ name: "allow", ssn: "mask" })], { name: 1, ssn: 2, other: 3 })).toEqual({
      [FIELD_READ_DEFAULT_KEY]: "omit", other: "omit", name: "allow", ssn: "mask",
    })
    expect(FIELD_READ_DEFAULT_KEY).toBe("*")
  })

  it("equal-priority allowlists intersect and never resurrect fields outside the record", () => {
    const first = read({ a: "allow", x: "mask" })
    const second = read({ b: "allow" })
    const expected = { [FIELD_READ_DEFAULT_KEY]: "omit", a: "omit", b: "omit", c: "omit" }
    expect(resolve([first, second], { a: 1, b: 2, c: 3 })).toEqual(expected)
    expect(resolve([second, first], { a: 1, b: 2, c: 3 })).toEqual(expected)
    // x is absent from the record and outside the second list: no override at all.
    expect(Object.hasOwn(resolve([first, second], { a: 1 }), "x")).toBe(false)
    expect(resolve([first, second], { a: 1 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", a: "omit" })
  })

  it("keeps a field in both equal-priority allowlists at its own mode", () => {
    const first = read({ a: "allow" })
    const second = read({ a: "mask" })
    expect(resolve([first, second], { a: 1 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", a: "mask" })
    expect(resolve([second, first], { a: 1 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", a: "mask" })
  })

  it("a lower-priority policy cannot relax a higher-priority decision", () => {
    // z is outside the allowlist (omitted at priority 100); the lower allow cannot re-open it.
    const top = read({ a: "allow" }, { priority: 100 })
    const lower = read({ z: "allow" }, { priority: 50 })
    expect(resolve([top, lower], { a: 1, z: 2 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", z: "omit", a: "allow" })
    // A lower-priority deny cannot override a higher-priority mask either.
    const masked = read({ a: "mask" }, { priority: 100 })
    const lowerDeny = read({ a: "omit" }, { priority: 50, effect: "deny" })
    expect(resolve([masked, lowerDeny], { a: 1 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", a: "mask" })
    expect(resolve([lowerDeny, masked], { a: 1 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", a: "mask" })
  })

  it("a higher-priority policy wins and is itself not displaced by a lower one", () => {
    const high = read({ m: "mask" }, { priority: 200 })
    const low = read({ m: "allow" }, { priority: 100 })
    expect(resolve([low, high], { m: 1 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", m: "mask" })
    const deny = read({ a: "allow" }, { priority: 200, effect: "deny" })
    const allow = read({ b: "allow" }, { priority: 100 })
    expect(resolve([allow, deny], { a: 1, b: 2 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", a: "omit", b: "allow" })
  })

  it("equal-priority conflicts resolve to the more restrictive mode in either order", () => {
    const allow = read({ a: "mask" })
    const deny = read({ a: "allow" }, { effect: "deny" })
    const expected = { [FIELD_READ_DEFAULT_KEY]: "omit", a: "omit" }
    expect(resolve([allow, deny], { a: 1 })).toEqual(expected)
    expect(resolve([deny, allow], { a: 1 })).toEqual(expected)
    const mask = read({ a: "mask" }, { effect: "allow" })
    const open = read({ a: "allow" }, { effect: "allow" })
    expect(resolve([mask, open], { a: 1 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", a: "mask" })
  })

  it("without any allow policy the default key is absent and deny fields are omitted", () => {
    const result = resolve([read({ a: "mask" }, { effect: "deny" }), read({ b: "mask" }, { effect: "deny", priority: 10 })], { a: 1, b: 2, c: 3 })
    expect(result).toEqual({ a: "omit", b: "omit" })
    expect(Object.hasOwn(result, FIELD_READ_DEFAULT_KEY)).toBe(false)
  })

  it("a field absent from the record but listed by a deny keeps the deny", () => {
    expect(resolve([read({ a: "allow" }), read({ x: "mask" }, { effect: "deny", priority: 200 })], { a: 1 })).toEqual({ [FIELD_READ_DEFAULT_KEY]: "omit", x: "omit", a: "allow" })
  })
})

describe("projectResponseRecord", () => {
  const entity = (formats: Record<string, FieldFormat | undefined>) => ({
    fields: Object.fromEntries(Object.entries(formats).map(([name, format]) => [name, { type: "string", ...(format === undefined ? {} : { format }) } as unknown as FieldDescriptor])),
  })

  it("returns declared fields present on the record and nothing else", () => {
    const result = projectResponseRecord({ entity: entity({ a: undefined, b: undefined, c: undefined }), record: { a: 1, c: 3, undeclared: 9 } })
    expect(result).toEqual({ a: 1, c: 3 })
    expect(Object.keys(result)).toEqual(["a", "c"])
  })

  it("applies per-field overrides, then the default key, then allow", () => {
    const e = entity({ a: undefined, b: undefined, c: undefined })
    const record = { a: "x", b: "y", c: "z" }
    expect(projectResponseRecord({ entity: e, record, overrides: { a: "omit" } })).toEqual({ b: "y", c: "z" })
    expect(projectResponseRecord({ entity: e, record, overrides: { [FIELD_READ_DEFAULT_KEY]: "omit", b: "allow" } })).toEqual({ b: "y" })
    expect(projectResponseRecord({ entity: e, record, overrides: { [FIELD_READ_DEFAULT_KEY]: "mask" } })).toEqual({ a: "[REDACTED]", b: "[REDACTED]", c: "[REDACTED]" })
    expect(projectResponseRecord({ entity: e, record, overrides: {} })).toEqual(record)
    expect(projectResponseRecord({ entity: e, record })).toEqual(record)
    expect(projectResponseRecord({ entity: e, record, overrides: { a: "mask" } })).toEqual({ a: "[REDACTED]", b: "y", c: "z" })
  })

  it.each<[FieldFormat | undefined, unknown, unknown]>([
    ["email", "ab@x.com", "a***@x.com"],
    ["email", "a@x.com", "[REDACTED]"],
    ["email", "@x.com", "[REDACTED]"],
    ["email", "plain", "[REDACTED]"],
    ["email", "abc@x.com", "a***@x.com"],
    ["phone", "1234", "[REDACTED]"],
    ["phone", "12345", "***2345"],
    ["phone", "0123456789", "***6789"],
    ["phone", 12345, "***2345"],
    ["identifier", "abcd", "[REDACTED]"],
    ["identifier", "abcde", "***bcde"],
    ["date", "2026-01-02", "2026"],
    ["date", "20260102", "2026"],
    ["date", "x2026-01-02", "[REDACTED]"],
    ["date", "abcd", "[REDACTED]"],
    ["date", 20260102, "2026"],
    [undefined, "anything", "[REDACTED]"],
    ["email", null, null],
    ["phone", undefined, undefined],
    [undefined, 0, "[REDACTED]"],
  ])("masks format %s value %j as %j", (format, value, expected) => {
    const result = projectResponseRecord({ entity: entity({ f: format }), record: { f: value }, overrides: { f: "mask" } })
    expect(result.f).toEqual(expected)
  })

  it("masks a boolean by string coercion rules of the format", () => {
    expect(projectResponseRecord({ entity: entity({ f: "phone" }), record: { f: false }, overrides: { f: "mask" } }).f).toBe("***alse")
  })
})

describe("hasRecordDependentFieldWrite", () => {
  const check = (policies: NormalizedAbacPolicy[]) => hasRecordDependentFieldWrite(policies, "m", "update")
  const conditional = Predicate.eq("status", "draft")

  it("flags a conditional policy that restricts fields", () => {
    expect(check([write(["a"], { when: conditional })])).toBe(true)
    expect(check([write(["a"], { when: conditional, effect: "deny" })])).toBe(true)
  })

  it("does not flag unconditional or unrestricting single policies", () => {
    expect(check([write(["a"])])).toBe(false)
    expect(check([write([], { when: conditional })])).toBe(false)
    expect(check([write(undefined, { when: conditional })])).toBe(false)
    expect(check([policy({ actions: ["update"], when: conditional, fieldAccess: { read: { a: "omit" } } })])).toBe(false)
    expect(check([])).toBe(false)
  })

  it("treats an empty conjunction as unconditional and anything else as conditional", () => {
    expect(check([write(["a"], { when: Predicate.and() })])).toBe(false)
    expect(check([write(["a"], { when: Predicate.or() })])).toBe(true)
    expect(check([write(["a"], { when: Predicate.and(Predicate.eq("s", 1)) })])).toBe(true)
    expect(check([write(["a"], { when: Predicate.alwaysFalse() })])).toBe(true)
    expect(check([write(["a"], { when: { kind: "and", filters: "x" } as never })])).toBe(true)
    expect(check([write(["a"], { when: { kind: "or", filters: [] } as never })])).toBe(true)
    expect(check([write(["a"], { when: "and" as never })])).toBe(true)
  })

  it("flags two allows when one restricts and one is conditional", () => {
    expect(check([write(["a"]), write(undefined, { when: conditional })])).toBe(true)
    expect(check([write(undefined, { when: conditional }), write(["a"])])).toBe(true)
    expect(check([write(["a"]), write(undefined)])).toBe(false)
    expect(check([write(undefined), write(undefined, { when: conditional })])).toBe(false)
    expect(check([write(["a"]), write(["b"])])).toBe(false)
  })

  it("only counts allow policies for the pair rule and only matching module and action", () => {
    expect(check([write(["a"]), write(undefined, { when: conditional, effect: "deny" })])).toBe(false)
    expect(check([write(["a"]), write(undefined, { when: conditional, moduleKey: "other" })])).toBe(false)
    expect(check([write(["a"]), write(undefined, { when: conditional, actions: ["delete"] })])).toBe(false)
    expect(check([write(["a"], { when: conditional, moduleKey: "other" })])).toBe(false)
    expect(check([write(["a"], { when: conditional, actions: ["delete"] })])).toBe(false)
  })
})

describe("assertPolicyWritableFields", () => {
  function denied(args: { policies: NormalizedAbacPolicy[]; record?: Record<string, unknown>; existing?: Record<string, unknown>; changedFields?: string[]; action?: string }): string[] | null {
    try {
      assertPolicyWritableFields({
        policies: args.policies, moduleKey: "m", action: args.action ?? "update", record: args.record ?? {},
        ...(args.existing === undefined ? {} : { existing: args.existing }),
        ...(args.changedFields === undefined ? {} : { changedFields: args.changedFields }),
      })
      return null
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenError)
      const forbidden = error as ForbiddenError
      expect(forbidden.message).toBe("You do not have permission to update one or more fields.")
      expect(forbidden.details).toEqual({ fields: (forbidden.details as { fields: string[] }).fields, reasonCode: "ABAC_FIELD_WRITE_DENIED" })
      return (forbidden.details as { fields: string[] }).fields
    }
  }

  it("denies every field under a deny without a write list and only listed ones with a list", () => {
    expect(denied({ policies: [write(undefined, { effect: "deny" })], changedFields: ["a", "b"] })).toEqual(["a", "b"])
    expect(denied({ policies: [write([], { effect: "deny" })], changedFields: ["a"] })).toEqual(["a"])
    expect(denied({ policies: [write(["b"], { effect: "deny" })], changedFields: ["a", "b", "c"] })).toEqual(["b"])
  })

  it("allows everything under an allow without a list and only listed fields with one", () => {
    expect(denied({ policies: [write(undefined)], changedFields: ["a", "b"] })).toBeNull()
    expect(denied({ policies: [write(["a"])], changedFields: ["a", "b", "c"] })).toEqual(["b", "c"])
    expect(denied({ policies: [write(["a"]), write(["b"])], changedFields: ["a", "b", "c"] })).toEqual(["c"])
  })

  it("lets a deny listing a field beat an allow of it at the same priority", () => {
    expect(denied({ policies: [write(["a", "b"]), write(["b"], { effect: "deny" })], changedFields: ["a", "b"] })).toEqual(["b"])
    expect(denied({ policies: [write(undefined), write(["b"], { effect: "deny" })], changedFields: ["a", "b"] })).toEqual(["b"])
  })

  it("denies fields a tier with an allow does not mention even when a deny names others", () => {
    expect(denied({ policies: [write(["a"]), write(["b"], { effect: "deny" })], changedFields: ["a", "c"] })).toEqual(["c"])
  })

  it("does not deny unmentioned fields when the deciding tier has no allow", () => {
    expect(denied({ policies: [write(["b"], { effect: "deny" })], changedFields: ["c"] })).toBeNull()
  })

  it("only the highest matching priority tier decides", () => {
    expect(denied({ policies: [write(["a"], { priority: 200 }), write(["b"], { priority: 100 })], changedFields: ["a", "b"] })).toEqual(["b"])
    expect(denied({ policies: [write(["b"], { priority: 100 }), write(["a"], { priority: 200 })], changedFields: ["a", "b"] })).toEqual(["b"])
    expect(denied({ policies: [write(undefined, { priority: 200 }), write(["b"], { effect: "deny", priority: 100 })], changedFields: ["b"] })).toBeNull()
  })

  it("ignores policies of other modules and actions", () => {
    expect(denied({ policies: [write(undefined, { effect: "deny", moduleKey: "other" })], changedFields: ["a"] })).toBeNull()
    expect(denied({ policies: [write(undefined, { effect: "deny", actions: ["delete"] })], changedFields: ["a"] })).toBeNull()
    expect(denied({ policies: [], changedFields: ["a"] })).toBeNull()
  })

  it("treats a policy that is FALSE as absent, an UNKNOWN deny as applying and an UNKNOWN allow as granting nothing", () => {
    expect(denied({ policies: [write(undefined, { effect: "deny", when: Predicate.alwaysFalse() })], changedFields: ["a"] })).toBeNull()
    expect(denied({ policies: [write(undefined, { effect: "deny", when: unknownCondition })], changedFields: ["a"] })).toEqual(["a"])
    expect(denied({ policies: [write(undefined, { when: unknownCondition })], changedFields: ["a"] })).toEqual(["a"])
    expect(denied({ policies: [write(["a"], { when: unknownCondition })], changedFields: ["a"] })).toEqual(["a"])
    expect(denied({ policies: [write(undefined, { when: unknownCondition }), write(["a"], { priority: 50 })], changedFields: ["a"] })).toEqual(["a"])
  })

  it("an allow with a write list and one without behave independently inside a tier", () => {
    expect(denied({ policies: [write(["a"]), write(undefined, { when: unknownCondition })], changedFields: ["a", "b"] })).toEqual(["b"])
    expect(denied({ policies: [write(["a"]), write(undefined)], changedFields: ["a", "b"] })).toBeNull()
  })

  it("creates ignore UNKNOWN caused by absent fields, updates keep it", () => {
    const deny = write(undefined, { effect: "deny", when: unknownCondition, actions: ["create", "update"] })
    expect(denied({ policies: [deny], action: "create", changedFields: ["a"] })).toBeNull()
    expect(denied({ policies: [deny], action: "update", changedFields: ["a"] })).toEqual(["a"])
    expect(denied({ policies: [deny], action: "create", record: { absent: "other" }, changedFields: ["a"] })).toBeNull()
    expect(denied({ policies: [deny], action: "create", record: { absent: null }, changedFields: ["a"] })).toEqual(["a"])
  })

  it("defaults to the record's keys when no changed fields are given", () => {
    expect(denied({ policies: [write(["a"])], record: { a: 1, b: 2 } })).toEqual(["b"])
  })

  it("requires both the pre-image and the post-image to permit each field, without duplicates", () => {
    const draft = Predicate.eq("status", "draft")
    const policies = [write(["a"], { priority: 200, when: draft }), write(["a", "b"], { priority: 100 })]
    expect(denied({ policies, record: { status: "published" }, existing: { status: "draft" }, changedFields: ["a", "b"] })).toEqual(["b"])
    expect(denied({ policies, record: { status: "draft" }, existing: { status: "published" }, changedFields: ["a", "b"] })).toEqual(["b"])
    expect(denied({ policies, record: { status: "published" }, existing: { status: "published" }, changedFields: ["a", "b"] })).toBeNull()
    expect(denied({ policies: [write(["a"])], record: {}, existing: {}, changedFields: ["b", "c"] })).toEqual(["b", "c"])
    expect(denied({ policies: [write(["a"], { priority: 200, when: draft }), write(["b"], { priority: 100 })], record: { status: "published" }, existing: { status: "draft" }, changedFields: ["a", "b"] })).toEqual(["b", "a"])
  })
})

describe("assertFieldQueryAccess", () => {
  it("passes when no field is denied", () => {
    expect(() => assertFieldQueryAccess({ denied: ["x"], fields: ["a", "b"], mode: "filter" })).not.toThrow()
    expect(() => assertFieldQueryAccess({ denied: [], fields: ["a"], mode: "sort" })).not.toThrow()
    expect(() => assertFieldQueryAccess({ denied: ["a"], fields: [], mode: "sort" })).not.toThrow()
  })

  it("names the offending fields and mode", () => {
    let caught: unknown
    try {
      assertFieldQueryAccess({ denied: ["b", "a", "z"], fields: ["a", "ok", "b"], mode: "search" })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ForbiddenError)
    const error = caught as ForbiddenError
    expect(error.message).toBe("Querying field(s) a, b via search is not permitted by policy")
    expect(error.details).toEqual({ fields: ["a", "b"], reasonCode: "ABAC_FIELD_QUERY_DENIED" })
  })
})

describe("query access", () => {
  const fields = ["ssn", "name", "pin", "extra"]
  const denials = (policies: NormalizedAbacPolicy[], known: readonly string[] = fields) => resolveFieldQueryDenials({ policies, moduleKey: "m", fields: known })
  const access = (policies: NormalizedAbacPolicy[], known: readonly string[] = fields) => resolveFieldQueryAccess({ policies, moduleKey: "m", fields: known })

  it("denies masked and omitted fields of an allow policy plus every field it does not list", () => {
    const result = denials([read({ ssn: "mask", name: "allow", pin: "omit" })])
    expect(result).toEqual({ filter: ["ssn", "pin", "extra"], search: ["ssn", "pin", "extra"], sort: ["ssn", "pin", "extra"] })
  })

  it("an allow read map for another action or module restricts nothing", () => {
    expect(denials([read({ ssn: "mask" }, { actions: ["update"] })])).toEqual({ filter: ["ssn"], search: ["ssn"], sort: ["ssn"] })
    expect(denials([read({ ssn: "mask" }, { moduleKey: "other" })])).toEqual({ filter: [], search: [], sort: [] })
    expect(denials([policy({ actions: ["read"] })])).toEqual({ filter: [], search: [], sort: [] })
  })

  it("a deny folds every mode to omit, and only a default key hides the unnamed fields", () => {
    expect(denials([read({ ssn: "allow" }, { effect: "deny" })]).filter).toEqual(["ssn"])
    expect(denials([read({ ssn: "omit", [FIELD_READ_DEFAULT_KEY]: "omit" }, { effect: "deny" })]).filter).toEqual(["ssn", FIELD_READ_DEFAULT_KEY, "name", "pin", "extra"])
    expect(denials([read({ ssn: "omit" }, { effect: "deny" })]).sort).toEqual(["ssn"])
  })

  it("lists each denied field once across policies", () => {
    expect(denials([read({ ssn: "mask" }, { effect: "deny" }), read({ ssn: "omit" }, { effect: "deny" })]).filter).toEqual(["ssn"])
    expect(denials([read({ ssn: "mask" }, { actions: ["update"] }), read({ ssn: "mask", name: "mask" }, { actions: ["update"] })]).filter).toEqual(["ssn", "name"])
  })

  it("an unconditional allow with a query grant re-opens only the granted modes", () => {
    const hidden = read({ ssn: "mask", name: "allow", pin: "allow", extra: "allow" }, { actions: ["update"] })
    const grant = policy({ actions: ["update"], fieldAccess: { query: { filter: ["ssn"] } } })
    expect(denials([hidden, grant])).toEqual({ filter: [], search: ["ssn"], sort: ["ssn"] })
    const all = policy({ actions: ["update"], fieldAccess: { query: { filter: ["ssn"], search: ["ssn"], sort: ["ssn"] } } })
    expect(denials([hidden, all])).toEqual({ filter: [], search: [], sort: [] })
    const sortOnly = policy({ actions: ["update"], fieldAccess: { query: { sort: ["ssn"] } } })
    expect(denials([hidden, sortOnly])).toEqual({ filter: ["ssn"], search: ["ssn"], sort: [] })
    const searchOnly = policy({ actions: ["update"], fieldAccess: { query: { search: ["ssn"] } } })
    expect(denials([hidden, searchOnly])).toEqual({ filter: ["ssn"], search: [], sort: ["ssn"] })
  })

  it("conditional, deny-effect and other-module grants grant nothing", () => {
    const hidden = read({ ssn: "mask" }, { actions: ["update"] })
    const query = { query: { filter: ["ssn"] } }
    const expected = { filter: ["ssn"], search: ["ssn"], sort: ["ssn"] }
    expect(denials([hidden, policy({ actions: ["update"], when: Predicate.eq("a", 1), fieldAccess: query })])).toEqual(expected)
    expect(denials([hidden, policy({ actions: ["update"], effect: "deny", fieldAccess: query })])).toEqual(expected)
    expect(denials([hidden, policy({ actions: ["update"], moduleKey: "other", fieldAccess: query })])).toEqual(expected)
    expect(denials([hidden, policy({ actions: ["update"], fieldAccess: { read: { other: "allow" } } })])).toEqual(expected)
  })

  it("a deny's omission is never subtracted by a grant", () => {
    const deny = read({ ssn: "omit" }, { effect: "deny" })
    const grant = policy({ actions: ["update"], fieldAccess: { query: { filter: ["ssn"] } } })
    expect(denials([deny, grant]).filter).toEqual(["ssn"])
    const mask = read({ ssn: "mask" }, { effect: "allow", actions: ["update"] })
    expect(denials([mask, grant]).filter).toEqual([])
  })

  it("allowed access lists explicit allow reads and grants once per mode", () => {
    const explicit = read({ name: "allow" }, { actions: ["update"] })
    expect(access([explicit], ["name"])).toEqual({ filter: ["name"], search: ["name"], sort: ["name"] })
    expect(access([explicit, explicit], ["name"])).toEqual({ filter: ["name"], search: ["name"], sort: ["name"] })
    const grant = policy({ actions: ["update"], fieldAccess: { query: { filter: ["ssn", "name"], sort: ["ssn"] } } })
    const twice = access([explicit, grant, grant], ["name", "ssn"])
    expect(twice).toEqual({ filter: ["ssn", "name"], search: ["name"], sort: ["ssn", "name"] })
  })

  it("allowed access skips masked reads, deny reads, hidden fields and other modules", () => {
    expect(access([read({ name: "mask" }, { actions: ["update"] })], ["name"])).toEqual({ filter: [], search: [], sort: [] })
    expect(access([read({ name: "allow" }, { effect: "deny" })], ["name"])).toEqual({ filter: [], search: [], sort: [] })
    expect(access([read({ name: "allow" }, { actions: ["update"], moduleKey: "other" })], ["name"])).toEqual({ filter: [], search: [], sort: [] })
    // An allow that lists name plus another allow that does not list it hides name.
    expect(access([read({ name: "allow" }), read({ other: "allow" })], ["name", "other"])).toEqual({ filter: [], search: [], sort: [] })
    expect(access([policy()], ["name"])).toEqual({ filter: [], search: [], sort: [] })
  })
})
