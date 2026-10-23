import { describe, expect, it } from "vitest"
import type { AbacModuleCatalog } from "../abacCatalog"
import {
  parseFieldAccessStrict,
  parsePolicyPayloadStrict,
  parseStringArrayStrict,
  validatePayloadAgainstCatalog,
  type ParsedPolicyPayload,
  type PolicyConditionGroup,
  type PolicyFilterClause,
  type PolicyParseIssue,
} from "../abacPolicySchema"

const LIMIT = 1024 * 1024
const emptyGroup = { logic: "AND", conditions: [] }
const conditionsOf = (userFilters: unknown = emptyGroup, extra: Record<string, unknown> = {}) => ({ version: 2, systemScope: emptyGroup, userFilters, ...extra })
const payloadOf = (conditionsJson: unknown, actionsJson: unknown = ["read"], capabilitiesJson: unknown = []) => parsePolicyPayloadStrict({ actionsJson, capabilitiesJson, conditionsJson })

function issues(result: { success: boolean }): PolicyParseIssue[] {
  const value = result as { success: boolean; errors?: PolicyParseIssue[] }
  if (value.success) throw new Error("expected a failure")
  return value.errors ?? []
}

describe("input budget (exact boundaries)", () => {
  const arrayRejected = (input: unknown): boolean => {
    const result = parseStringArrayStrict(input, "p")
    if (result.success) return false
    return result.errors[0]?.message === "Expected a JSON array of strings"
  }

  it("accepts a string array at exactly 1 MiB of accounted bytes and rejects one byte more", () => {
    // 2 (array) + (a + 2) + (b + 2) + 1 (separator) = a + b + 7
    const total = LIMIT - 7
    expect(arrayRejected(["a".repeat(total - 10), "b".repeat(10)])).toBe(false)
    expect(arrayRejected(["a".repeat(total - 10 + 1), "b".repeat(10)])).toBe(true)
    const ok = parseStringArrayStrict(["a".repeat(total - 10), "b".repeat(10)], "p")
    expect(ok.success).toBe(true)
  })

  it("accounts for every primitive kind inside the budget", () => {
    // [S, 12345, true, false, null, undefined, {}, []]: 2 + (L+2) + 5 + 4 + 5 + 4 + 0 + 2 + 2 + 7 separators = L + 33
    const build = (length: number): unknown[] => ["s".repeat(length), 12345, true, false, null, undefined, {}, []]
    expect(arrayRejected(build(LIMIT - 33))).toBe(false)
    expect(arrayRejected(build(LIMIT - 33 + 1))).toBe(true)
    expect(arrayRejected(build(LIMIT - 33 - 1))).toBe(false)
  })

  it("accounts for object keys and nested values", () => {
    const fieldAccess = (length: number) => parseFieldAccessStrict({ read: {}, write: ["w".repeat(length)] }, "fa")
    // 2 (object) + 8 ("read") + 2 ({}) + 9 ("write") + 2 (array) + (L + 2) = L + 25
    expect(fieldAccess(LIMIT - 25)).toEqual({ success: true, fieldAccess: { write: ["w".repeat(LIMIT - 25)] } })
    expect(fieldAccess(LIMIT - 25 + 1)).toEqual({ success: false, errors: [{ path: "fa", message: "fieldAccess must contain plain data only" }] })
  })

  it("rejects when a key pushes the total over the limit, but not when it lands exactly on it", () => {
    // 2 + 9 + (2 + L + 2) + 7 ("zzz" key) = L + 22; the undefined value costs nothing.
    const build = (length: number) => parseFieldAccessStrict({ write: ["w".repeat(length)], zzz: undefined }, "fa")
    const accepted = build(LIMIT - 22)
    expect(issues(accepted).map((issue) => issue.message)).toEqual(["Unknown fieldAccess key: zzz"])
    expect(issues(build(LIMIT - 22 + 1))).toEqual([{ path: "fa", message: "fieldAccess must contain plain data only" }])
  })

  it("accepts exactly 5000 nodes and rejects 5001", () => {
    const build = (extra: number): unknown[] => {
      // root (1) + 500 children + numbers
      const children: unknown[][] = []
      let remaining = 4499 + extra
      for (let i = 0; i < 500; i++) {
        const take = Math.min(remaining, 9 + (extra > 0 && i === 0 ? 1 : 0))
        children.push(Array.from({ length: take }, () => 1))
        remaining -= take
      }
      return children
    }
    expect(arrayRejected(build(0))).toBe(false)
    expect(arrayRejected(build(1))).toBe(true)
    expect(arrayRejected(build(-1))).toBe(false)
  })

  it("rejects arrays with more than 500 items but accepts 500", () => {
    expect(arrayRejected(Array.from({ length: 500 }, () => "a"))).toBe(false)
    expect(arrayRejected(Array.from({ length: 501 }, () => "a"))).toBe(true)
  })

  it("accepts nesting 20 deep and rejects 21", () => {
    const nest = (levels: number): unknown => {
      let value: unknown = []
      for (let i = 1; i < levels; i++) value = [value]
      return value
    }
    // The root array is depth 0; the innermost array of an n-level nest is depth n - 1.
    expect(arrayRejected(nest(21))).toBe(false)
    expect(arrayRejected(nest(22))).toBe(true)
    expect(arrayRejected(nest(100))).toBe(true)
  })

  it("accepts a shared (diamond) reference but rejects a cycle", () => {
    const shared: unknown[] = ["a"]
    expect(arrayRejected([shared, shared])).toBe(false)
    const cyclic: unknown[] = []
    cyclic.push(cyclic)
    expect(arrayRejected(cyclic)).toBe(true)
  })

  it("rejects accessors, sparse arrays, foreign prototypes, symbols, functions and throwing proxies", () => {
    const accessor: unknown[] = []
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => "x" })
    expect(arrayRejected(accessor)).toBe(true)
    // eslint-disable-next-line no-sparse-arrays
    expect(arrayRejected(["a", , "b"])).toBe(true)
    class Custom { readonly write = ["a"] }
    expect(parseFieldAccessStrict(new Custom(), "fa")).toEqual({ success: false, errors: [{ path: "fa", message: "fieldAccess must contain plain data only" }] })
    expect(parseFieldAccessStrict(Object.assign(Object.create(null) as object, { write: ["a"] }), "fa")).toEqual({ success: true, fieldAccess: { write: ["a"] } })
    expect(parseFieldAccessStrict({ write: ["a"], [Symbol("s")]: 1 }, "fa")).toEqual({ success: false, errors: [{ path: "fa", message: "fieldAccess must contain plain data only" }] })
    expect(parseFieldAccessStrict({ write: () => 1 }, "fa")).toEqual({ success: false, errors: [{ path: "fa", message: "fieldAccess must contain plain data only" }] })
    const throwing = new Proxy({}, { ownKeys() { throw new Error("boom") } })
    expect(parseFieldAccessStrict(throwing, "fa")).toEqual({ success: false, errors: [{ path: "fa", message: "fieldAccess must contain plain data only" }] })
    const getterObject = {}
    Object.defineProperty(getterObject, "write", { enumerable: true, get: () => ["a"] })
    expect(parseFieldAccessStrict(getterObject, "fa")).toEqual({ success: false, errors: [{ path: "fa", message: "fieldAccess must contain plain data only" }] })
  })

  it("rejects an oversized JSON string up front", () => {
    const tooBig = `["${"a".repeat(LIMIT)}"]`
    expect(arrayRejected(tooBig)).toBe(true)
    expect(parseStringArrayStrict('["a","b"]', "p")).toEqual({ success: true, value: ["a", "b"] })
    expect(arrayRejected("not json")).toBe(true)
  })
})

describe("parseStringArrayStrict", () => {
  it("reports each non-string member with its index", () => {
    expect(parseStringArrayStrict(["a", 1, null], "list")).toEqual({
      success: false,
      errors: [
        { path: "list[1]", message: "Expected a string", value: 1 },
        { path: "list[2]", message: "Expected a string", value: null },
      ],
    })
    expect(parseStringArrayStrict({ a: 1 }, "list")).toEqual({ success: false, errors: [{ path: "list", message: "Expected a JSON array of strings", value: { a: 1 } }] })
  })
})

describe("parseFieldAccessStrict", () => {
  const fa = (input: unknown) => parseFieldAccessStrict(input, "fa")

  it("rejects non-objects", () => {
    expect(fa(null)).toEqual({ success: false, errors: [{ path: "fa", message: "Expected an object for fieldAccess", value: null }] })
    expect(fa(undefined)).toEqual({ success: false, errors: [{ path: "fa", message: "Expected an object for fieldAccess", value: undefined }] })
    expect(fa("x")).toEqual({ success: false, errors: [{ path: "fa", message: "Expected an object for fieldAccess", value: "x" }] })
    expect(fa(["x"])).toEqual({ success: false, errors: [{ path: "fa", message: "Expected an object for fieldAccess", value: ["x"] }] })
    expect(fa(0)).toEqual({ success: false, errors: [{ path: "fa", message: "Expected an object for fieldAccess", value: 0 }] })
  })

  it("validates read maps", () => {
    expect(fa({ read: { a: "mask", b: "omit", c: "allow" } })).toEqual({ success: true, fieldAccess: { read: { a: "mask", b: "omit", c: "allow" } } })
    expect(fa({ read: null })).toEqual({ success: false, errors: [{ path: "fa.read", message: "Expected an object with field-mode pairs", value: null }] })
    expect(fa({ read: ["a"] })).toEqual({ success: false, errors: [{ path: "fa.read", message: "Expected an object with field-mode pairs", value: ["a"] }] })
    expect(fa({ read: "a" })).toEqual({ success: false, errors: [{ path: "fa.read", message: "Expected an object with field-mode pairs", value: "a" }] })
    expect(fa({ read: { "": "mask" } })).toEqual({ success: false, errors: [{ path: "fa.read", message: "Field name must not be empty", value: "" }] })
    for (const name of ["constructor", "prototype", "*"]) {
      expect(fa({ read: { [name]: "mask" } })).toEqual({ success: false, errors: [{ path: "fa.read", message: `Reserved field name: ${name}`, value: name }] })
    }
    expect(fa(JSON.parse('{"read":{"__proto__":"mask"}}'))).toEqual({ success: false, errors: [{ path: "fa.read", message: "Reserved field name: __proto__", value: "__proto__" }] })
    expect(fa({ read: { a: "show" } })).toEqual({ success: false, errors: [{ path: "fa.read.a", message: "Invalid read mode: show", value: "show" }] })
    expect(fa({ read: {} })).toEqual({ success: true, fieldAccess: {} })
  })

  it("validates write lists", () => {
    expect(fa({ write: ["a", "b"] })).toEqual({ success: true, fieldAccess: { write: ["a", "b"] } })
    expect(fa({ write: "a" })).toEqual({ success: false, errors: [{ path: "fa.write", message: "Expected an array of field names", value: "a" }] })
    expect(fa({ write: [1, ""] })).toEqual({
      success: false,
      errors: [
        { path: "fa.write[0]", message: "Expected a string field name", value: 1 },
        { path: "fa.write[1]", message: "Field name must not be empty", value: "" },
      ],
    })
    expect(fa({ write: [] })).toEqual({ success: true, fieldAccess: {} })
  })

  it("validates query lists and keys", () => {
    expect(fa({ query: { filter: ["a"], search: ["b"], sort: ["c"] } })).toEqual({ success: true, fieldAccess: { query: { filter: ["a"], search: ["b"], sort: ["c"] } } })
    expect(fa({ query: { filter: [] } })).toEqual({ success: true, fieldAccess: {} })
    expect(fa({ query: {} })).toEqual({ success: true, fieldAccess: {} })
    for (const bad of [null, ["a"], "a", 1]) {
      expect(fa({ query: bad })).toEqual({ success: false, errors: [{ path: "fa.query", message: "Expected an object with filter/search/sort field lists", value: bad }] })
    }
    expect(fa({ query: { sort: "a" } })).toEqual({ success: false, errors: [{ path: "fa.query.sort", message: "Expected an array of field names", value: "a" }] })
    expect(fa({ query: { search: [1, ""] } })).toEqual({
      success: false,
      errors: [
        { path: "fa.query.search[0]", message: "Expected a string field name", value: 1 },
        { path: "fa.query.search[1]", message: "Field name must not be empty", value: "" },
      ],
    })
    expect(fa({ query: { other: ["a"] } })).toEqual({ success: false, errors: [{ path: "fa.query.other", message: "Unknown fieldAccess.query key: other", value: "other" }] })
    expect(fa({ extra: 1 })).toEqual({ success: false, errors: [{ path: "fa.extra", message: "Unknown fieldAccess key: extra", value: "extra" }] })
  })
})

describe("parsePolicyPayloadStrict", () => {
  it("returns the deduplicated payload and omits fieldAccess when absent", () => {
    const result = payloadOf(conditionsOf(), ["read", "read", "update"], ["cap", "cap"])
    expect(result).toEqual({ success: true, payload: { actions: ["read", "update"], capabilities: ["cap"], conditions: { version: 2, systemScope: emptyGroup, userFilters: emptyGroup } } })
    if (!result.success) throw new Error("unreachable")
    expect(Object.hasOwn(result.payload, "fieldAccess")).toBe(false)
  })

  it("deduplicates write and query lists but keeps absent query modes absent", () => {
    const result = payloadOf(conditionsOf(emptyGroup, { fieldAccess: { write: ["a", "a", "b"], query: { filter: ["x", "x"], search: ["y", "y"] } } }))
    if (!result.success) throw new Error("expected success")
    expect(result.payload.fieldAccess).toStrictEqual({ write: ["a", "b"], query: { filter: ["x"], search: ["y"] } })
    const sortOnly = payloadOf(conditionsOf(emptyGroup, { fieldAccess: { query: { sort: ["z", "z"] } } }))
    if (!sortOnly.success) throw new Error("expected success")
    expect(sortOnly.payload.fieldAccess).toStrictEqual({ query: { sort: ["z"] } })
    const readOnly = payloadOf(conditionsOf(emptyGroup, { fieldAccess: { read: { a: "mask" } } }))
    if (!readOnly.success) throw new Error("expected success")
    expect(readOnly.payload.fieldAccess).toStrictEqual({ read: { a: "mask" } })
  })

  it("names the failing input path", () => {
    expect(issues(payloadOf(conditionsOf(), ["read"], "nope"))).toEqual([{ path: "capabilitiesJson", message: "Expected a JSON array of strings", value: null }])
    expect(issues(payloadOf(conditionsOf(), 5))).toEqual([{ path: "actionsJson", message: "Expected a JSON array of strings", value: 5 }])
    expect(issues(payloadOf(conditionsOf(emptyGroup, { fieldAccess: { write: "a" } })))).toEqual([{ path: "conditionsJson.fieldAccess.write", message: "Expected an array of field names", value: "a" }])
    expect(issues(payloadOf("[]"))).toEqual([{ path: "conditionsJson", message: "conditionsJson must be a JSON object" }])
    expect(issues(payloadOf(null))).toEqual([{ path: "conditionsJson", message: "conditionsJson must be a JSON object" }])
  })

  it("collects errors from actions, capabilities and conditions together", () => {
    const result = payloadOf(conditionsOf({ logic: "XOR", conditions: [] }), 1, 2)
    expect(issues(result).map((issue) => issue.path)).toEqual(["actionsJson", "capabilitiesJson", "conditionsJson.userFilters.logic"])
  })
})

describe("clause parsing", () => {
  const parseClause = (clause: unknown) => payloadOf(conditionsOf({ logic: "AND", conditions: [clause] }))
  const clauseErrors = (clause: unknown): PolicyParseIssue[] => issues(parseClause(clause))
  const parsedClause = (clause: unknown): PolicyFilterClause => {
    const result = parseClause(clause)
    if (!result.success) throw new Error(JSON.stringify(result.errors))
    return (result.payload.conditions.userFilters.conditions[0]) as PolicyFilterClause
  }
  const base = "conditionsJson.userFilters.conditions[0]"

  it("accepts every supported operator and defaults to equals", () => {
    for (const operator of ["equals", "notEquals", "contains", "startsWith", "endsWith", "greaterThan", "lessThan", "greaterOrEqual", "lessOrEqual", "before", "after"]) {
      expect(parsedClause({ field: "f", operator, value: "x" })).toStrictEqual({ field: "f", operator, value: "x" })
    }
    for (const operator of ["isEmpty", "isNotEmpty", "isTrue", "isFalse", "isNull", "isNotNull"]) {
      expect(parsedClause({ field: "f", operator })).toStrictEqual({ field: "f", operator })
    }
    expect(parsedClause({ field: "f", operator: "in", values: ["a"] })).toStrictEqual({ field: "f", operator: "in", values: ["a"] })
    expect(parsedClause({ field: "f", operator: "includesAny", values: ["a"] })).toStrictEqual({ field: "f", operator: "includesAny", values: ["a"] })
    expect(parsedClause({ field: "f", operator: "between", value: [1, 2] })).toStrictEqual({ field: "f", operator: "between", value: [1, 2] })
    expect(parsedClause({ field: "f", value: "x" })).toStrictEqual({ field: "f", operator: "equals", value: "x" })
    expect(parsedClause({ field: "f", operator: "equals", userAttr: "user.id" })).toStrictEqual({ field: "f", operator: "equals", userAttr: "user.id" })
    expect(parsedClause({ field: "f", operator: 5, value: "x" } as never).operator).toBe("equals")
  })

  it("rejects bad shapes with exact messages", () => {
    expect(clauseErrors("x")).toEqual([{ path: base, message: "Expected an object" }])
    expect(clauseErrors({ field: "", operator: "isNull" })).toEqual([{ path: `${base}.field`, message: "field must be a non-empty string", value: "" }])
    expect(clauseErrors({ field: 5, operator: "isNull" })).toEqual([{ path: `${base}.field`, message: "field must be a non-empty string", value: 5 }])
    expect(clauseErrors({ field: "f", operator: "isNull", junk: 1 })).toEqual([{ path: `${base}.junk`, message: "Unknown clause property: junk", value: "junk" }])
    expect(clauseErrors({ field: "f", operator: "regex", value: "x" })).toEqual([{ path: `${base}.operator`, message: "Unknown operator: regex", value: "regex" }])
    expect(clauseErrors({ field: "f", operator: "includesAll", values: ["a"] })).toEqual([{ path: `${base}.operator`, message: "includesAll is not supported by persistence adapters", value: "includesAll" }])
    expect(clauseErrors({ field: "f", userAttr: "user.nope" })).toEqual([{ path: `${base}.userAttr`, message: "Invalid user attribute: user.nope", value: "user.nope" }])
  })

  it("rejects clauses that mix value, values and userAttr", () => {
    const clause = { field: "f", operator: "in", value: "x", values: ["a"] }
    expect(clauseErrors(clause).map((issue) => issue.message)).toContain("Clause must not have more than one of value, values, or userAttr")
    const mixed = clauseErrors({ field: "f", value: "x", userAttr: "user.id" })
    expect(mixed).toEqual([{ path: base, message: "Clause must not have more than one of value, values, or userAttr", value: { field: "f", value: "x", userAttr: "user.id" } }])
  })

  it("rejects values on the value-less operators", () => {
    for (const operator of ["isTrue", "isFalse", "isNull", "isNotNull", "isEmpty", "isNotEmpty"]) {
      expect(clauseErrors({ field: "f", operator, value: "x" })).toEqual([{ path: `${base}.value`, message: `${operator} does not accept values`, value: "x" }])
      expect(clauseErrors({ field: "f", operator, values: ["x"] })).toEqual([{ path: `${base}.value`, message: `${operator} does not accept values`, value: undefined }])
      expect(clauseErrors({ field: "f", operator, userAttr: "user.id" })).toEqual([{ path: `${base}.value`, message: `${operator} does not accept values`, value: undefined }])
    }
  })

  it("validates between operands", () => {
    const arrayMessage = "between array requires exactly 2 non-undefined values"
    expect(clauseErrors({ field: "f", operator: "between", value: [1, 2, 3] })).toEqual([{ path: `${base}.value`, message: arrayMessage, value: [1, 2, 3] }])
    expect(clauseErrors({ field: "f", operator: "between", value: [1] })).toEqual([{ path: `${base}.value`, message: arrayMessage, value: [1] }])
    expect(clauseErrors({ field: "f", operator: "between", value: [undefined, 2] })[0]?.message).toBe(arrayMessage)
    expect(clauseErrors({ field: "f", operator: "between", value: [1, undefined] })[0]?.message).toBe(arrayMessage)
    expect(parsedClause({ field: "f", operator: "between", value: [null, 2] }).value).toEqual([null, 2])
    expect(clauseErrors({ field: "f", operator: "between", value: { from: 1, x: 2 } })).toEqual([{ path: `${base}.value`, message: "between object must only have from/to keys", value: { from: 1, x: 2 } }])
    expect(clauseErrors({ field: "f", operator: "between", value: {} })).toEqual([{ path: `${base}.value`, message: "between object requires at least one of from or to", value: {} }])
    expect(parsedClause({ field: "f", operator: "between", value: { to: 2 } }).value).toEqual({ to: 2 })
    for (const value of [undefined, null, "x", 5, true]) {
      expect(clauseErrors({ field: "f", operator: "between", ...(value === undefined ? {} : { value }) })).toEqual([
        { path: `${base}.value`, message: "between requires [from, to] array or {from, to} object", value },
      ])
    }
  })

  it("validates list operators", () => {
    for (const operator of ["in", "includesAny"]) {
      expect(clauseErrors({ field: "f", operator, value: "x" }).map((issue) => issue.message)).toEqual([`${operator} does not accept value; use values instead`, `${operator} requires a non-empty array`])
      expect(clauseErrors({ field: "f", operator })).toEqual([{ path: `${base}.values`, message: `${operator} requires a non-empty array`, value: undefined }])
      expect(clauseErrors({ field: "f", operator, values: [] })).toEqual([{ path: `${base}.values`, message: `${operator} requires a non-empty array`, value: [] }])
      expect(clauseErrors({ field: "f", operator, values: "a" })).toEqual([{ path: `${base}.values`, message: `${operator} requires a non-empty array`, value: "a" }])
    }
    expect(clauseErrors({ field: "f", operator: "includesAll", values: [] }).map((issue) => issue.message)).toEqual(["includesAll is not supported by persistence adapters", "includesAll requires a non-empty array"])
  })
})

describe("group parsing", () => {
  const parse = (userFilters: unknown) => payloadOf(conditionsOf(userFilters))

  it("requires an object with a conditions array and a valid logic", () => {
    expect(issues(parse(null))).toEqual([{ path: "conditionsJson.userFilters", message: "Expected an object with a conditions array" }])
    expect(issues(parse({ logic: "AND" }))).toEqual([{ path: "conditionsJson.userFilters", message: "Expected an object with a conditions array" }])
    expect(issues(parse({ logic: "and", conditions: [] }))).toEqual([{ path: "conditionsJson.userFilters.logic", message: "logic must be AND or OR", value: "and" }])
    expect(issues(parse({ logic: "AND", conditions: [], extra: 1 }))).toEqual([{ path: "conditionsJson.userFilters.extra", message: "Unknown condition group property: extra", value: "extra" }])
    expect(parse({ logic: "OR", conditions: [] })).toMatchObject({ success: true })
  })

  it("parses nested groups and reports nested errors with their path", () => {
    const nested = parse({ logic: "AND", conditions: [{ logic: "OR", conditions: [{ field: "f", operator: "isNull" }] }] })
    expect(nested).toMatchObject({ success: true })
    expect(issues(parse({ logic: "AND", conditions: [{ logic: "XOR", conditions: [] }] }))).toEqual([
      { path: "conditionsJson.userFilters.conditions[0].logic", message: "logic must be AND or OR", value: "XOR" },
    ])
  })

  it("requires version 2 and stops at the first invalid scope", () => {
    expect(issues(payloadOf({ version: 1, systemScope: emptyGroup, userFilters: emptyGroup }))).toEqual([{ path: "conditionsJson.version", message: "version must be 2", value: 1 }])
    expect(issues(payloadOf({ version: 2, systemScope: emptyGroup, userFilters: emptyGroup, extra: 1 }))).toEqual([{ path: "conditionsJson.extra", message: "Unknown conditions property: extra", value: "extra" }])
    expect(issues(payloadOf({ version: 2, systemScope: null, userFilters: null })).map((issue) => issue.path)).toEqual(["conditionsJson.systemScope"])
    expect(issues(payloadOf({ version: 2, systemScope: emptyGroup, userFilters: null })).map((issue) => issue.path)).toEqual(["conditionsJson.userFilters"])
  })
})

describe("validatePayloadAgainstCatalog", () => {
  const catalog: AbacModuleCatalog = {
    moduleKey: "m",
    actions: ["read"],
    capabilities: ["export"],
    fields: {
      name: { key: "name", type: "string", operators: ["equals", "in"] },
      tags: { key: "tags", type: "string-array", operators: ["in", "includesAny", "includesAll", "equals"] },
      age: { key: "age", type: "number", operators: ["equals", "in"] },
    },
  }
  const payload = (conditions: Partial<{ systemScope: PolicyConditionGroup; userFilters: PolicyConditionGroup }> = {}, extra: Partial<ParsedPolicyPayload> = {}): ParsedPolicyPayload => ({
    actions: ["read"], capabilities: [],
    conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] }, ...conditions },
    ...extra,
  })
  const filters = (...conditions: PolicyFilterClause[]): PolicyConditionGroup => ({ logic: "AND", conditions })

  it("names unknown actions, capabilities and fields in every access list", () => {
    expect(validatePayloadAgainstCatalog(payload({}, { actions: ["read", "drop"], capabilities: ["export", "root"] }), catalog)).toEqual([
      { path: "actions", message: "Unknown action: drop", value: "drop" },
      { path: "capabilities", message: "Unknown capability: root", value: "root" },
    ])
    expect(validatePayloadAgainstCatalog(payload({}, { fieldAccess: { read: { name: "mask", ghost: "omit" }, write: ["name", "ghost2"], query: { filter: ["ghost3"], search: ["ghost4"], sort: ["ghost5", "name"] } } }), catalog)).toEqual([
      { path: "fieldAccess.read.ghost", message: "Unknown field for read access: ghost", value: "ghost" },
      { path: "fieldAccess.write.ghost2", message: "Unknown field for write access: ghost2", value: "ghost2" },
      { path: "fieldAccess.query.filter", message: "Unknown field for query access: ghost3", value: "ghost3" },
      { path: "fieldAccess.query.search", message: "Unknown field for query access: ghost4", value: "ghost4" },
      { path: "fieldAccess.query.sort", message: "Unknown field for query access: ghost5", value: "ghost5" },
    ])
    expect(validatePayloadAgainstCatalog(payload({}, { fieldAccess: { read: { toString: "mask" } } }), catalog)[0]?.message).toBe("Unknown field for read access: toString")
  })

  it("validates clause fields, operators and values", () => {
    expect(validatePayloadAgainstCatalog(payload({ userFilters: filters({ field: "ghost", operator: "equals", value: "x" }) }), catalog)).toEqual([
      { path: "userFilters.conditions[0].field", message: "Unknown field: ghost", value: "ghost" },
    ])
    expect(validatePayloadAgainstCatalog(payload({ systemScope: filters({ field: "name", operator: "greaterThan", value: "x" }) }), catalog)).toEqual([
      { path: "systemScope.conditions[0].operator", message: "Operator greaterThan is not supported for field name", value: "greaterThan" },
    ])
    expect(validatePayloadAgainstCatalog(payload({ userFilters: filters({ field: "age", operator: "equals", value: "abc" }) }), catalog)).toEqual([
      { path: "userFilters.conditions[0].value", message: "Invalid value for field age", value: "abc" },
    ])
    expect(validatePayloadAgainstCatalog(payload({ userFilters: filters({ field: "age", operator: "equals", value: "abc", userAttr: "user.id" }) }), catalog)).toEqual([])
    expect(validatePayloadAgainstCatalog(payload({ userFilters: filters({ field: "age", operator: "in", values: [1, "x", "y"] }) }), catalog)).toEqual([
      { path: "userFilters.conditions[0].values[1]", message: "Invalid value for field age", value: "x" },
      { path: "userFilters.conditions[0].values[2]", message: "Invalid value for field age", value: "y" },
    ])
    expect(validatePayloadAgainstCatalog(payload({ userFilters: filters({ field: "age", operator: "in", values: ["x"], userAttr: "user.id" }) }), catalog)).toEqual([])
  })

  it("coerces string-array lists as lists for list operators only", () => {
    for (const operator of ["in", "includesAny", "includesAll"] as const) {
      const result = validatePayloadAgainstCatalog(payload({ userFilters: filters({ field: "tags", operator, values: ["a", 1 as never] }) }), catalog)
      expect(result.map((issue) => [issue.path, issue.message])).toEqual([["userFilters.conditions[0].values", "Expected string, got number"]])
      expect(validatePayloadAgainstCatalog(payload({ userFilters: filters({ field: "tags", operator, values: ["a", "b"] }) }), catalog)).toEqual([])
    }
    // Any other operator coerces every member as a scalar, which a string-array rejects.
    expect(validatePayloadAgainstCatalog(payload({ userFilters: filters({ field: "tags", operator: "equals", values: ["a"] }) }), catalog)).toEqual([
      { path: "userFilters.conditions[0].values[0]", message: "Invalid value for field tags", value: "a" },
    ])
    expect(validatePayloadAgainstCatalog(payload({ userFilters: filters({ field: "tags", values: ["a"] }) }), catalog)).toEqual([
      { path: "userFilters.conditions[0].values[0]", message: "Invalid value for field tags", value: "a" },
    ])
  })

  it("walks nested groups and treats objects without a conditions array as clauses", () => {
    const nested: PolicyConditionGroup = { logic: "OR", conditions: [{ logic: "AND", conditions: [{ field: "ghost", operator: "equals", value: "x" }] }] }
    expect(validatePayloadAgainstCatalog(payload({ userFilters: nested }), catalog)).toEqual([
      { path: "userFilters.conditions[0].conditions[0].field", message: "Unknown field: ghost", value: "ghost" },
    ])
    const odd = { logic: "AND", field: "ghost", operator: "equals", value: "x" } as unknown as PolicyFilterClause
    expect(validatePayloadAgainstCatalog(payload({ userFilters: filters(odd) }), catalog)).toEqual([
      { path: "userFilters.conditions[0].field", message: "Unknown field: ghost", value: "ghost" },
    ])
    const sparse = filters({ field: "ghost", operator: "equals", value: "x" })
    ;(sparse.conditions as unknown[]).length = 2
    expect(validatePayloadAgainstCatalog(payload({ userFilters: sparse }), catalog)).toHaveLength(1)
  })
})
