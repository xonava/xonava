import { describe, expect, it } from "vitest"
import { normalizeUserAttribute, parseFieldAccessStrict, parsePolicyPayloadStrict, parseStringArrayStrict, validatePayloadAgainstCatalog } from "../abacPolicySchema"
import type { AbacModuleCatalog } from "../abacCatalog"

const base = { actionsJson: ["read"], capabilitiesJson: [], conditionsJson: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } } }
function strict(conditions: unknown) { return parsePolicyPayloadStrict({ ...base, conditionsJson: conditions }) }

describe("policy schema focused branches", () => {
  it("accepts the current syntax, all field modes, user attributes, and between forms", () => {
    const result = strict({ version: 2, systemScope: { logic: "OR", conditions: [
      { field: "createdAt", operator: "between", value: ["2026-01-01", "2026-12-31"] },
      { field: "age", operator: "between", value: { from: 18, to: 65 } },
       { field: "branchId", operator: "equals", userAttr: "user.branchId" },
      { field: "active", operator: "isTrue" }, { field: "tags", operator: "in", values: ["one"] },
     ] }, userFilters: { logic: "AND", conditions: [] }, fieldAccess: { read: { a: "allow", b: "omit", c: "mask" }, write: ["name", "name"] } })
    expect(result.success).toBe(true)
    if (result.success) expect(result.payload.fieldAccess?.write).toEqual(["name"])
    expect(normalizeUserAttribute("user.branchId")).toBe("user.branchId")
    expect(normalizeUserAttribute("@@user.branchId")).toBeUndefined()
    expect(normalizeUserAttribute("user.unknown")).toBeUndefined()
  })

  it.each([
    { field: "x", operator: "isTrue", value: true },
    { field: "x", operator: "between", value: [1] },
    { field: "x", operator: "between", value: { extra: 1 } },
    { field: "x", operator: "between", value: "bad" },
    { field: "x", operator: "in", value: 1 },
    { field: "x", operator: "in" },
    { field: "x", operator: "equals", userAttr: "user.unknown" },
    { field: "x", operator: "equals", value: 1, values: [1] },
  ])("rejects invalid clause shape %#", (clause) => {
    const result = strict({ version: 2, systemScope: { logic: "AND", conditions: [clause] }, userFilters: { logic: "AND", conditions: [] } })
    expect(result.success).toBe(false)
  })

  it("reports missing groups, invalid JSON, and catalog operator/value errors", () => {
    expect(strict({ systemScope: {}, userFilters: { conditions: [] } }).success).toBe(false)
    expect(parsePolicyPayloadStrict({ actionsJson: "bad", capabilitiesJson: "bad", conditionsJson: "bad" }).success).toBe(false)
    const errors = validatePayloadAgainstCatalog({ actions: ["write"], capabilities: ["x"], fieldAccess: { read: { missing: "mask" }, write: ["missing"] }, conditions: { version: 2, systemScope: { logic: "AND", conditions: [{ field: "known", operator: "in", values: ["bad"] }] }, userFilters: { logic: "AND", conditions: [] } } }, { moduleKey: "m", actions: ["read"], capabilities: [], fields: { known: { key: "known", type: "number", operators: ["equals"] } } })
    expect(errors.length).toBeGreaterThan(3)
  })

  it("covers strict clause shape", () => {
    expect(parseStringArrayStrict(["ok", 1], "items").success).toBe(false)
    const invalid = strict({ systemScope: { conditions: [
      null, { field: "x", operator: "wat" }, { field: "x", operator: "isTrue", value: true },
      { field: "x", operator: "between", value: [1] }, { field: "x", operator: "between", value: { extra: 1 } },
      { field: "x", operator: "in", values: [] }, { field: "x", userAttr: "user.unknown" },
    ] }, userFilters: { conditions: [] } })
    expect(invalid.success).toBe(false)

    expect(strict({ version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [{ field: "x" }] } }).success).toBe(true)
  })

  it("validates supported catalog branches without errors", () => {
    const catalog: AbacModuleCatalog = { moduleKey: "m", actions: ["read"], capabilities: ["view"], fields: {
      tags: { key: "tags", type: "string-array", operators: ["in"] },
      age: { key: "age", type: "number", operators: ["equals", "in"] },
    } }
    expect(validatePayloadAgainstCatalog({ actions: ["read"], capabilities: ["view"], fieldAccess: { read: { age: "allow" }, write: ["age"] }, conditions: {
      version: 2, systemScope: { logic: "AND", conditions: [{ field: "tags", operator: "in", values: ["a"] }, { field: "age", operator: "in", values: [1, 2] }] }, userFilters: { logic: "AND", conditions: [] },
    } }, catalog)).toEqual([])
  })

  it("rejects includesAll during strict ABAC bundle validation", () => {
    const result = strict({
      systemScope: { logic: "AND", conditions: [{ field: "tags", operator: "includesAll", values: ["a"] }] },
      userFilters: { logic: "AND", conditions: [] },
    })
    expect(result).toMatchObject({ success: false })
    if (!result.success) expect(result.errors).toContainEqual(expect.objectContaining({ message: "includesAll is not supported by persistence adapters" }))
  })

  it("accepts each strict clause value form and nested groups", () => {
    const clauses = [
      { field: "x" },
      { field: "x", operator: "equals", value: "value" },
      { field: "x", operator: "in", values: ["value"] },
      { field: "x", operator: "equals", userAttr: "user.id" },
      { field: "x", operator: "between", value: [1, 2] },
      { field: "x", operator: "between", value: { from: 1 } },
      { field: "x", operator: "isEmpty" },
    ]
    const result = strict({ version: 2, systemScope: { logic: "OR", conditions: [{ logic: "AND", conditions: clauses }] }, userFilters: { logic: "AND", conditions: [] } })
    expect(result.success).toBe(true)
    expect(strict({ systemScope: { conditions: [] }, user_filters: {} }).success).toBe(false)
    expect(validatePayloadAgainstCatalog({ actions: [], capabilities: [], conditions: { version: 2, systemScope: { logic: "AND", conditions: [null as never] }, userFilters: { logic: "AND", conditions: [] } } }, { moduleKey: "m", actions: [], capabilities: [], fields: {} })).toEqual([])
  })

  it("covers empty and malformed optional parser inputs", () => {
    expect(parseFieldAccessStrict(null, "fieldAccess").success).toBe(false)
    expect(parseFieldAccessStrict({ read: null, write: ["", 1], extra: true }, "fieldAccess")).toMatchObject({ success: false })
    expect(parseFieldAccessStrict({ read: {}, write: [] }, "fieldAccess")).toEqual({ success: true, fieldAccess: {} })
    expect(parseFieldAccessStrict({ read: { "": "allow" } }, "fieldAccess").success).toBe(false)
    expect(parseFieldAccessStrict({ write: "name" }, "fieldAccess").success).toBe(false)

    expect(strict({ systemScope: { conditions: [{ field: "x", value: 1, values: [2] }] }, userFilters: { conditions: [] } }).success).toBe(false)
    expect(strict({ systemScope: { conditions: [{ field: "x", operator: "between", value: { from: 1, extra: true } }] }, userFilters: { conditions: [] } }).success).toBe(false)
    expect(strict({ systemScope: { conditions: [{ field: "x", operator: "in", values: [] }] }, userFilters: { conditions: [] } }).success).toBe(false)
    expect(strict({ systemScope: { conditions: [{ conditions: [null] }] }, userFilters: { conditions: [] } }).success).toBe(false)
    expect(strict({ systemScope: { conditions: [{ field: "" }] }, userFilters: { conditions: [] } }).success).toBe(false)
    expect(parsePolicyPayloadStrict({ actionsJson: 1, capabilitiesJson: ["read"], conditionsJson: { systemScope: { conditions: [] }, userFilters: { conditions: [] } } }).success).toBe(false)
    expect(parsePolicyPayloadStrict({ actionsJson: ["read"], capabilitiesJson: [], conditionsJson: { systemScope: {}, userFilters: { conditions: [] } } }).success).toBe(false)
  })
})
