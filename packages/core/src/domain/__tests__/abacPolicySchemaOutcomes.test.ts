import { describe, expect, it } from "vitest"
import type { AbacModuleCatalog } from "../abacCatalog"
import {
  ALLOWED_USER_ATTRS,
  normalizeUserAttribute,
  parseFieldAccessStrict,
  parsePolicyPayloadStrict,
  parseStringArrayStrict,
  validatePayloadAgainstCatalog,
  type ParsedPolicyPayload,
} from "../abacPolicySchema"

const emptyConditions: ParsedPolicyPayload["conditions"] = { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "OR", conditions: [] } }

/** Parse a single clause placed in the system scope and return the full result. */
function parseClause(clause: unknown) {
  return parsePolicyPayloadStrict({
    actionsJson: [],
    capabilitiesJson: [],
    conditionsJson: { ...emptyConditions, systemScope: { logic: "AND", conditions: [clause] } },
  })
}

const CLAUSE_PATH = "conditionsJson.systemScope.conditions[0]"

describe("parseStringArrayStrict outcomes", () => {
  it("accepts exactly 500 items and rejects 501 with the array message", () => {
    const at = Array.from({ length: 500 }, () => "a")
    expect(parseStringArrayStrict(at, "actions")).toEqual({ success: true, value: at })
    expect(parseStringArrayStrict([...at, "a"], "actions")).toEqual({
      success: false,
      errors: [{ path: "actions", message: "Expected a JSON array of strings", value: undefined }],
    })
  })

  it("reports each non-string item with its index and value", () => {
    expect(parseStringArrayStrict(["a", 2, null], "actions")).toEqual({
      success: false,
      errors: [
        { path: "actions[1]", message: "Expected a string", value: 2 },
        { path: "actions[2]", message: "Expected a string", value: null },
      ],
    })
  })

  it("parses JSON text and rejects non-array JSON and invalid JSON", () => {
    expect(parseStringArrayStrict('["read","update"]', "actions")).toEqual({ success: true, value: ["read", "update"] })
    expect(parseStringArrayStrict("nope", "actions")).toEqual({
      success: false,
      errors: [{ path: "actions", message: "Expected a JSON array of strings", value: null }],
    })
    expect(parseStringArrayStrict('"read"', "actions")).toEqual({
      success: false,
      errors: [{ path: "actions", message: "Expected a JSON array of strings", value: "read" }],
    })
  })

  it("drops an oversized string item into the array message", () => {
    expect(parseStringArrayStrict(["x".repeat(1_048_577)], "actions")).toEqual({
      success: false,
      errors: [{ path: "actions", message: "Expected a JSON array of strings", value: undefined }],
    })
  })

  it("allows nesting to depth 20 and rejects depth 21", () => {
    let twenty: unknown = "x"
    for (let i = 0; i < 20; i++) twenty = [twenty]
    const atLimit = parseStringArrayStrict(twenty, "actions")
    expect(atLimit.success).toBe(false)
    if (atLimit.success) throw new Error("expected failure")
    expect(atLimit.errors[0]?.message).toBe("Expected a string")
    expect(atLimit.errors[0]?.path).toBe("actions[0]")

    let twentyOne: unknown = "x"
    for (let i = 0; i < 21; i++) twentyOne = [twentyOne]
    expect(parseStringArrayStrict(twentyOne, "actions")).toEqual({
      success: false,
      errors: [{ path: "actions", message: "Expected a JSON array of strings", value: undefined }],
    })
  })
})

describe("parseFieldAccessStrict outcomes", () => {
  it("rejects missing, null and array inputs with the object message", () => {
    expect(parseFieldAccessStrict(undefined, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa", message: "Expected an object for fieldAccess", value: undefined }],
    })
    expect(parseFieldAccessStrict(null, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa", message: "Expected an object for fieldAccess", value: null }],
    })
    expect(parseFieldAccessStrict([], "fa")).toEqual({
      success: false,
      errors: [{ path: "fa", message: "Expected an object for fieldAccess", value: [] }],
    })
  })

  it("rejects accessor-backed input as not plain data", () => {
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "read", { enumerable: true, get: () => ({}) })
    expect(parseFieldAccessStrict(accessor, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa", message: "fieldAccess must contain plain data only" }],
    })
  })

  it("validates the read map", () => {
    expect(parseFieldAccessStrict({ read: "bad" }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.read", message: "Expected an object with field-mode pairs", value: "bad" }],
    })
    expect(parseFieldAccessStrict({ read: [] }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.read", message: "Expected an object with field-mode pairs", value: [] }],
    })
    expect(parseFieldAccessStrict({ read: { "": "allow" } }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.read", message: "Field name must not be empty", value: "" }],
    })
    expect(parseFieldAccessStrict(JSON.parse('{"read":{"constructor":"allow"}}'), "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.read", message: "Reserved field name: constructor", value: "constructor" }],
    })
    expect(parseFieldAccessStrict({ read: { "*": "allow" } }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.read", message: "Reserved field name: *", value: "*" }],
    })
    expect(parseFieldAccessStrict({ read: { secret: "deny" } }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.read.secret", message: "Invalid read mode: deny", value: "deny" }],
    })
    expect(parseFieldAccessStrict({ read: { email: "mask", id: "allow", hidden: "omit" } }, "fa")).toEqual({
      success: true,
      fieldAccess: { read: { email: "mask", id: "allow", hidden: "omit" } },
    })
  })

  it("validates the write list and keeps duplicates until the payload stage", () => {
    expect(parseFieldAccessStrict({ write: "a" }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.write", message: "Expected an array of field names", value: "a" }],
    })
    expect(parseFieldAccessStrict({ write: [7] }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.write[0]", message: "Expected a string field name", value: 7 }],
    })
    expect(parseFieldAccessStrict({ write: [""] }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.write[0]", message: "Field name must not be empty", value: "" }],
    })
    expect(parseFieldAccessStrict({ write: ["a", "a"] }, "fa")).toEqual({ success: true, fieldAccess: { write: ["a", "a"] } })
    expect(parseFieldAccessStrict({ write: [] }, "fa")).toEqual({ success: true, fieldAccess: {} })
  })

  it("validates query lists and unknown query keys", () => {
    expect(parseFieldAccessStrict({ query: null }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.query", message: "Expected an object with filter/search/sort field lists", value: null }],
    })
    expect(parseFieldAccessStrict({ query: { filter: "x" } }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.query.filter", message: "Expected an array of field names", value: "x" }],
    })
    expect(parseFieldAccessStrict({ query: { search: [5] } }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.query.search[0]", message: "Expected a string field name", value: 5 }],
    })
    expect(parseFieldAccessStrict({ query: { sort: [""] } }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.query.sort[0]", message: "Field name must not be empty", value: "" }],
    })
    expect(parseFieldAccessStrict({ query: { unknown: [] } }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.query.unknown", message: "Unknown fieldAccess.query key: unknown", value: "unknown" }],
    })
    expect(parseFieldAccessStrict({ query: { filter: [] } }, "fa")).toEqual({ success: true, fieldAccess: {} })
    expect(parseFieldAccessStrict({ query: { filter: ["a"], search: ["b"], sort: ["c"] } }, "fa")).toEqual({
      success: true,
      fieldAccess: { query: { filter: ["a"], search: ["b"], sort: ["c"] } },
    })
  })

  it("rejects unknown top-level keys", () => {
    expect(parseFieldAccessStrict({ bogus: 1 }, "fa")).toEqual({
      success: false,
      errors: [{ path: "fa.bogus", message: "Unknown fieldAccess key: bogus", value: "bogus" }],
    })
  })
})

describe("parsePolicyPayloadStrict outcomes", () => {
  it("deduplicates actions and capabilities and returns the conditions", () => {
    expect(parsePolicyPayloadStrict({
      actionsJson: ["read", "read", "update"],
      capabilitiesJson: ["c", "c"],
      conditionsJson: emptyConditions,
    })).toEqual({
      success: true,
      payload: { actions: ["read", "update"], capabilities: ["c"], conditions: emptyConditions },
    })
  })

  it("accepts conditions as JSON text and deduplicates field access lists", () => {
    const result = parsePolicyPayloadStrict({
      actionsJson: [],
      capabilitiesJson: [],
      conditionsJson: JSON.stringify({
        ...emptyConditions,
        fieldAccess: { write: ["a", "a"], query: { filter: ["f", "f"], search: [], sort: ["s"] } },
      }),
    })
    expect(result).toEqual({
      success: true,
      payload: {
        actions: [],
        capabilities: [],
        conditions: emptyConditions,
        fieldAccess: { write: ["a"], query: { filter: ["f"], sort: ["s"] } },
      },
    })
  })

  it("reports a non-object conditions value, including missing conditions", () => {
    const expected = { success: false, errors: [{ path: "conditionsJson", message: "conditionsJson must be a JSON object" }] }
    expect(parsePolicyPayloadStrict({ actionsJson: [], capabilitiesJson: [], conditionsJson: "[]" })).toEqual(expected)
    expect(parsePolicyPayloadStrict({ actionsJson: [], capabilitiesJson: [], conditionsJson: undefined })).toEqual(expected)
  })

  it("keeps action errors alongside condition errors", () => {
    const result = parsePolicyPayloadStrict({ actionsJson: "x", capabilitiesJson: [], conditionsJson: { ...emptyConditions, version: 3 } })
    expect(result).toEqual({
      success: false,
      errors: [
        { path: "actionsJson", message: "Expected a JSON array of strings", value: null },
        { path: "conditionsJson.version", message: "version must be 2", value: 3 },
      ],
    })
  })

  it("rejects unknown conditions keys and a wrong version", () => {
    expect(parsePolicyPayloadStrict({ actionsJson: [], capabilitiesJson: [], conditionsJson: { ...emptyConditions, zzz: 1 } })).toEqual({
      success: false,
      errors: [{ path: "conditionsJson.zzz", message: "Unknown conditions property: zzz", value: "zzz" }],
    })
  })

  it("reports a missing or invalid scope and returns early", () => {
    expect(parsePolicyPayloadStrict({
      actionsJson: [],
      capabilitiesJson: [],
      conditionsJson: { version: 2, userFilters: emptyConditions.userFilters },
    })).toEqual({
      success: false,
      errors: [{ path: "conditionsJson.systemScope", message: "Expected an object with a conditions array" }],
    })
    expect(parsePolicyPayloadStrict({
      actionsJson: [],
      capabilitiesJson: [],
      conditionsJson: { ...emptyConditions, userFilters: { logic: "XOR", conditions: [] } },
    })).toEqual({
      success: false,
      errors: [{ path: "conditionsJson.userFilters.logic", message: "logic must be AND or OR", value: "XOR" }],
    })
  })

  it("rejects unknown group keys and non-object clauses", () => {
    expect(parsePolicyPayloadStrict({
      actionsJson: [],
      capabilitiesJson: [],
      conditionsJson: { ...emptyConditions, systemScope: { logic: "AND", conditions: [], note: 1 } },
    })).toEqual({
      success: false,
      errors: [{ path: "conditionsJson.systemScope.note", message: "Unknown condition group property: note", value: "note" }],
    })
    expect(parsePolicyPayloadStrict({
      actionsJson: [],
      capabilitiesJson: [],
      conditionsJson: { ...emptyConditions, systemScope: { logic: "AND", conditions: [{ field: "a" }, 5] } },
    })).toEqual({
      success: false,
      errors: [{ path: "conditionsJson.systemScope.conditions[1]", message: "Expected an object" }],
    })
  })

  it("keeps valid nested groups and reports invalid nested logic with its path", () => {
    expect(parsePolicyPayloadStrict({
      actionsJson: [],
      capabilitiesJson: [],
      conditionsJson: {
        ...emptyConditions,
        systemScope: { logic: "AND", conditions: [{ logic: "OR", conditions: [{ field: "a", operator: "isTrue" }] }] },
      },
    })).toEqual({
      success: true,
      payload: {
        actions: [],
        capabilities: [],
        conditions: {
          ...emptyConditions,
          systemScope: { logic: "AND", conditions: [{ logic: "OR", conditions: [{ field: "a", operator: "isTrue" }] }] },
        },
      },
    })
    expect(parsePolicyPayloadStrict({
      actionsJson: [],
      capabilitiesJson: [],
      conditionsJson: { ...emptyConditions, systemScope: { logic: "AND", conditions: [{ logic: "XOR", conditions: [] }] } },
    })).toEqual({
      success: false,
      errors: [{ path: "conditionsJson.systemScope.conditions[0].logic", message: "logic must be AND or OR", value: "XOR" }],
    })
  })
})

describe("clause parsing outcomes", () => {
  it("validates the field name and unknown clause keys", () => {
    expect(parseClause({ field: "" })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.field`, message: "field must be a non-empty string", value: "" }],
    })
    expect(parseClause({ field: "a", bad: 1 })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.bad`, message: "Unknown clause property: bad", value: "bad" }],
    })
  })

  it("validates operators and defaults a non-string operator to equals", () => {
    expect(parseClause({ field: "a", operator: "nope" })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.operator`, message: "Unknown operator: nope", value: "nope" }],
    })
    expect(parseClause({ field: "a", operator: "includesAll", values: ["x"] })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.operator`, message: "includesAll is not supported by persistence adapters", value: "includesAll" }],
    })
    expect(parseClause({ field: "a", operator: 5 })).toEqual({
      success: true,
      payload: { actions: [], capabilities: [], conditions: { ...emptyConditions, systemScope: { logic: "AND", conditions: [{ field: "a", operator: "equals" }] } } },
    })
  })

  it("rejects combinations of value, values and userAttr", () => {
    const clause = { field: "a", value: 1, values: ["x"] }
    expect(parseClause(clause)).toEqual({
      success: false,
      errors: [{ path: CLAUSE_PATH, message: "Clause must not have more than one of value, values, or userAttr", value: clause }],
    })
    expect(parseClause({ field: "a", value: 1, userAttr: "user.id" })).toEqual({
      success: false,
      errors: [{ path: CLAUSE_PATH, message: "Clause must not have more than one of value, values, or userAttr", value: { field: "a", value: 1, userAttr: "user.id" } }],
    })
  })

  it("rejects values on valueless operators, including empty values arrays", () => {
    expect(parseClause({ field: "a", operator: "isTrue", value: 1 })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.value`, message: "isTrue does not accept values", value: 1 }],
    })
    expect(parseClause({ field: "a", operator: "isNull", values: [] })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.value`, message: "isNull does not accept values", value: undefined }],
    })
    expect(parseClause({ field: "a", operator: "isEmpty", userAttr: "user.id" })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.value`, message: "isEmpty does not accept values", value: undefined }],
    })
  })

  it("validates between arrays, objects and other shapes", () => {
    expect(parseClause({ field: "a", operator: "between", value: [1] })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.value`, message: "between array requires exactly 2 non-undefined values", value: [1] }],
    })
    expect(parseClause({ field: "a", operator: "between", value: [1, undefined] })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.value`, message: "between array requires exactly 2 non-undefined values", value: [1, undefined] }],
    })
    expect(parseClause({ field: "a", operator: "between", value: { from: 1, extra: 2 } })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.value`, message: "between object must only have from/to keys", value: { from: 1, extra: 2 } }],
    })
    expect(parseClause({ field: "a", operator: "between", value: {} })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.value`, message: "between object requires at least one of from or to", value: {} }],
    })
    expect(parseClause({ field: "a", operator: "between", value: "x" })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.value`, message: "between requires [from, to] array or {from, to} object", value: "x" }],
    })
    expect(parseClause({ field: "a", operator: "between", value: null })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.value`, message: "between requires [from, to] array or {from, to} object", value: null }],
    })
    expect(parseClause({ field: "a", operator: "between", value: { to: 2 } }).success).toBe(true)
    expect(parseClause({ field: "a", operator: "between", value: [1, 2] }).success).toBe(true)
  })

  it("validates list operators", () => {
    expect(parseClause({ field: "a", operator: "in", value: 1, values: [] })).toEqual({
      success: false,
      errors: [
        { path: `${CLAUSE_PATH}.value`, message: "in does not accept value; use values instead", value: 1 },
        { path: `${CLAUSE_PATH}.values`, message: "in requires a non-empty array", value: [] },
      ],
    })
    expect(parseClause({ field: "a", operator: "includesAny", values: "x" })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.values`, message: "includesAny requires a non-empty array", value: "x" }],
    })
    expect(parseClause({ field: "a", operator: "in", values: ["x"] })).toEqual({
      success: true,
      payload: { actions: [], capabilities: [], conditions: { ...emptyConditions, systemScope: { logic: "AND", conditions: [{ field: "a", operator: "in", values: ["x"] }] } } },
    })
  })

  it("validates user attributes and keeps the normalized one", () => {
    expect(parseClause({ field: "a", userAttr: "user.bogus" })).toEqual({
      success: false,
      errors: [{ path: `${CLAUSE_PATH}.userAttr`, message: "Invalid user attribute: user.bogus", value: "user.bogus" }],
    })
    expect(parseClause({ field: "a", userAttr: "user.id" })).toEqual({
      success: true,
      payload: { actions: [], capabilities: [], conditions: { ...emptyConditions, systemScope: { logic: "AND", conditions: [{ field: "a", operator: "equals", userAttr: "user.id" }] } } },
    })
  })

  it("keeps explicit null and empty values on the clause", () => {
    expect(parseClause({ field: "a", value: null })).toEqual({
      success: true,
      payload: { actions: [], capabilities: [], conditions: { ...emptyConditions, systemScope: { logic: "AND", conditions: [{ field: "a", operator: "equals", value: null }] } } },
    })
    expect(parseClause({ field: "a", values: [] })).toEqual({
      success: true,
      payload: { actions: [], capabilities: [], conditions: { ...emptyConditions, systemScope: { logic: "AND", conditions: [{ field: "a", operator: "equals", values: [] }] } } },
    })
  })
})

describe("user attributes", () => {
  it("allows exactly the documented user attributes", () => {
    expect([...ALLOWED_USER_ATTRS].sort()).toEqual(["user.branchId", "user.departmentId", "user.id", "user.roleId", "user.tenantId"])
    expect(normalizeUserAttribute("user.id")).toBe("user.id")
    expect(normalizeUserAttribute("user.foo")).toBeUndefined()
  })
})

describe("validatePayloadAgainstCatalog outcomes", () => {
  const catalog: AbacModuleCatalog = {
    moduleKey: "m",
    actions: ["read"],
    capabilities: ["cap"],
    fields: {
      name: { key: "name", type: "string", operators: ["equals", "contains"] },
      amount: { key: "amount", type: "number", operators: ["equals", "greaterThan"] },
      tags: { key: "tags", type: "string-array", operators: ["in", "includesAny"] },
    },
  }

  function payloadWith(
    conditions: ParsedPolicyPayload["conditions"],
    extra: Partial<ParsedPolicyPayload> = {},
  ): ParsedPolicyPayload {
    return { actions: ["read"], capabilities: ["cap"], conditions, ...extra }
  }

  it("reports unknown actions, capabilities and field access entries", () => {
    const payload = payloadWith(emptyConditions, {
      actions: ["read", "write"],
      capabilities: ["cap", "x"],
      fieldAccess: {
        read: { ghost: "mask" },
        write: ["ghostW"],
        query: { filter: ["ghostF"], search: ["ghostS"], sort: ["ghostO"] },
      },
    })
    expect(validatePayloadAgainstCatalog(payload, catalog)).toEqual([
      { path: "actions", message: "Unknown action: write", value: "write" },
      { path: "capabilities", message: "Unknown capability: x", value: "x" },
      { path: "fieldAccess.read.ghost", message: "Unknown field for read access: ghost", value: "ghost" },
      { path: "fieldAccess.write.ghostW", message: "Unknown field for write access: ghostW", value: "ghostW" },
      { path: "fieldAccess.query.filter", message: "Unknown field for query access: ghostF", value: "ghostF" },
      { path: "fieldAccess.query.search", message: "Unknown field for query access: ghostS", value: "ghostS" },
      { path: "fieldAccess.query.sort", message: "Unknown field for query access: ghostO", value: "ghostO" },
    ])
  })

  it("accepts known field access entries and a query with no lists", () => {
    const payload = payloadWith(emptyConditions, {
      fieldAccess: { read: { name: "allow" }, write: ["name"], query: { sort: ["amount"] } },
    })
    expect(validatePayloadAgainstCatalog(payload, catalog)).toEqual([])
    expect(validatePayloadAgainstCatalog(payloadWith(emptyConditions, { fieldAccess: { query: {} } }), catalog)).toEqual([])
  })

  it("reports unknown and unsupported clause fields", () => {
    const conditions: ParsedPolicyPayload["conditions"] = {
      ...emptyConditions,
      systemScope: { logic: "AND", conditions: [{ field: "nope", operator: "equals", value: "x" }] },
    }
    expect(validatePayloadAgainstCatalog(payloadWith(conditions), catalog)).toEqual([
      { path: "systemScope.conditions[0].field", message: "Unknown field: nope", value: "nope" },
    ])
    const unsupported: ParsedPolicyPayload["conditions"] = {
      ...emptyConditions,
      systemScope: { logic: "AND", conditions: [{ field: "name", operator: "greaterThan", value: "x" }] },
    }
    expect(validatePayloadAgainstCatalog(payloadWith(unsupported), catalog)).toEqual([
      { path: "systemScope.conditions[0].operator", message: "Operator greaterThan is not supported for field name", value: "greaterThan" },
    ])
  })

  it("validates single values against the field type unless a user attribute is set", () => {
    const bad: ParsedPolicyPayload["conditions"] = {
      ...emptyConditions,
      systemScope: { logic: "AND", conditions: [{ field: "amount", operator: "greaterThan", value: "abc" }] },
    }
    expect(validatePayloadAgainstCatalog(payloadWith(bad), catalog)).toEqual([
      { path: "systemScope.conditions[0].value", message: "Invalid value for field amount", value: "abc" },
    ])
    const skipped: ParsedPolicyPayload["conditions"] = {
      ...emptyConditions,
      systemScope: { logic: "AND", conditions: [{ field: "amount", operator: "greaterThan", value: "abc", userAttr: "user.id" }] },
    }
    expect(validatePayloadAgainstCatalog(payloadWith(skipped), catalog)).toEqual([])
    const stringArrayValue: ParsedPolicyPayload["conditions"] = {
      ...emptyConditions,
      systemScope: { logic: "AND", conditions: [{ field: "tags", operator: "equals", value: "x" }] },
    }
    expect(validatePayloadAgainstCatalog(payloadWith(stringArrayValue), catalog)).toEqual([
      { path: "systemScope.conditions[0].operator", message: "Operator equals is not supported for field tags", value: "equals" },
      { path: "systemScope.conditions[0].value", message: "Invalid value for field tags", value: "x" },
    ])
  })

  it("validates list values for list operators and element by element otherwise", () => {
    const badList: ParsedPolicyPayload["conditions"] = {
      ...emptyConditions,
      systemScope: { logic: "AND", conditions: [{ field: "tags", operator: "in", values: [1] }] },
    }
    expect(validatePayloadAgainstCatalog(payloadWith(badList), catalog)).toEqual([
      { path: "systemScope.conditions[0].values", message: "Expected string, got number", value: undefined },
    ])
    const goodList: ParsedPolicyPayload["conditions"] = {
      ...emptyConditions,
      systemScope: { logic: "AND", conditions: [{ field: "tags", operator: "in", values: ["a"] }] },
    }
    expect(validatePayloadAgainstCatalog(payloadWith(goodList), catalog)).toEqual([])
    const elementwise: ParsedPolicyPayload["conditions"] = {
      ...emptyConditions,
      systemScope: { logic: "AND", conditions: [{ field: "amount", values: ["x", 2] }] },
    }
    expect(validatePayloadAgainstCatalog(payloadWith(elementwise), catalog)).toEqual([
      { path: "systemScope.conditions[0].values[0]", message: "Invalid value for field amount", value: "x" },
    ])
  })

  it("walks nested groups and reports the nested path", () => {
    const nested: ParsedPolicyPayload["conditions"] = {
      ...emptyConditions,
      userFilters: { logic: "OR", conditions: [{ logic: "OR", conditions: [{ field: "nope", operator: "equals", value: "x" }] }] },
    }
    expect(validatePayloadAgainstCatalog(payloadWith(nested), catalog)).toEqual([
      { path: "userFilters.conditions[0].conditions[0].field", message: "Unknown field: nope", value: "nope" },
    ])
  })
})
