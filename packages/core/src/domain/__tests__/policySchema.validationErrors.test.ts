import { describe, expect, it } from "vitest"
import { parseFieldAccessStrict, parsePolicyPayloadStrict, validatePayloadAgainstCatalog } from "../abacPolicySchema"
import type { AbacModuleCatalog } from "../abacCatalog"

const emptyConditions = { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } }

describe("policy schema edge paths", () => {
  it("rejects legacy aliases and malformed JSON", () => {
    expect(parsePolicyPayloadStrict({ actionsJson: "not-json", capabilitiesJson: ["x", 2], conditionsJson: { system_scope: {}, user_filters: {}, field_access: { read: { email: "mask" } } } }).success).toBe(false)
    expect(parsePolicyPayloadStrict({ actionsJson: ["read"], capabilitiesJson: [], conditionsJson: { ...emptyConditions, field_access: { read: { email: "mask" } } } }).success).toBe(false)
  })

  it("reports strict field access, condition, and unknown-key errors", () => {
    const field = parseFieldAccessStrict({ read: null, write: ["", 1], extra: true }, "fieldAccess")
    expect(field.success).toBe(false)
    if (!field.success) expect(field.errors.length).toBeGreaterThanOrEqual(3)

    const result = parsePolicyPayloadStrict({
      actionsJson: ["read"], capabilitiesJson: [], conditionsJson: {
        systemScope: { logic: "AND", conditions: [{ field: "", value: "x", extra: true }] },
        userFilters: {},
        fieldAccess: { read: { email: "mask" }, write: ["email", "email"] },
      },
    })
    expect(result.success).toBe(false)
    expect(parseFieldAccessStrict({}, "fieldAccess")).toEqual({ success: true, fieldAccess: {} })
  })

  it("rejects accessor-backed field access without invoking the accessor", () => {
    let reads = 0
    const input: Record<string, unknown> = {}
    Object.defineProperty(input, "read", { enumerable: true, get() { reads += 1; return { email: "allow" } } })
    expect(parseFieldAccessStrict(input, "fieldAccess").success).toBe(false)
    expect(reads).toBe(0)
  })

  it("validates catalog actions, capabilities, fields, operators, and values", () => {
    const catalog: AbacModuleCatalog = { moduleKey: "m", actions: ["read"], capabilities: ["export"], fields: { age: { key: "age", type: "number", operators: ["equals", "in"] } } }
    const payload = {
      actions: ["write"], capabilities: ["missing"], conditions: { version: 2 as const, systemScope: { logic: "AND" as const, conditions: [{ field: "unknown", operator: "equals" as const, value: "x" }, { field: "age", operator: "greaterThan" as const, value: "bad" }] }, userFilters: { logic: "AND" as const, conditions: [{ field: "age", values: ["bad"] }] } },
      fieldAccess: { read: { missing: "mask" as const }, write: ["missing"] },
    }
    const errors = validatePayloadAgainstCatalog(payload, catalog)
    expect(errors.length).toBeGreaterThan(3)
  })

  it("validates invalid list values and nested condition groups", () => {
    const catalog: AbacModuleCatalog = { moduleKey: "m", actions: [], capabilities: [], fields: { tags: { key: "tags", type: "string-array", operators: ["in"] }, age: { key: "age", type: "number", operators: ["in"] } } }
    const payload = { actions: [], capabilities: [], conditions: { version: 2 as const, systemScope: { logic: "AND" as const, conditions: [{ logic: "OR" as const, conditions: [{ field: "tags", operator: "in" as const, values: [1] }, { field: "age", operator: "in" as const, values: ["bad"] }] }] }, userFilters: { logic: "AND" as const, conditions: [] } } }
    expect(validatePayloadAgainstCatalog(payload, catalog).length).toBeGreaterThan(0)
  })
})
