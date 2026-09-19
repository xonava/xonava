import { describe, it, expect } from "vitest"
import { parsePolicyPayloadStrict, parseStringArrayStrict } from "../abacPolicySchema"

describe("parsePolicyPayloadStrict", () => {
  it("bounds direct strings and shared subtrees while copying", () => {
    expect(parseStringArrayStrict(["x".repeat(1_048_577)], "actions").success).toBe(false)
    const leaf = { logic: "AND", conditions: [] }
    const wide = { logic: "AND", conditions: Array.from({ length: 100 }, () => ({ logic: "AND", conditions: Array(100).fill(leaf) })) }
    expect(parsePolicyPayloadStrict({ actionsJson: [], capabilitiesJson: [], conditionsJson: { version: 2, systemScope: wide, userFilters: leaf } }).success).toBe(false)
    expect(parseStringArrayStrict(["read", "update"], "actions")).toEqual({ success: true, value: ["read", "update"] })
  })
  it("accepts valid payload", () => {
    const result = parsePolicyPayloadStrict({
      actionsJson: '["read","update"]',
      capabilitiesJson: '["export"]',
      conditionsJson: JSON.stringify({
        version: 2,
        systemScope: { logic: "AND", conditions: [{ field: "status", operator: "equals", value: "active" }] },
        userFilters: { logic: "AND", conditions: [] },
        fieldAccess: {},
      }),
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.payload.actions).toEqual(["read", "update"])
      expect(result.payload.capabilities).toEqual(["export"])
    }
  })

  it("rejects non-array actionsJson", () => {
    const result = parsePolicyPayloadStrict({
      actionsJson: '"read"',
      capabilitiesJson: "[]",
      conditionsJson: '{"version":2,"systemScope":{"logic":"AND","conditions":[]},"userFilters":{"logic":"AND","conditions":[]}}',
    })
    expect(result.success).toBe(false)
  })

  it("rejects array with non-string action", () => {
    const result = parsePolicyPayloadStrict({
      actionsJson: '["read", 25]',
      capabilitiesJson: "[]",
      conditionsJson: '{"version":2,"systemScope":{"logic":"AND","conditions":[]},"userFilters":{"logic":"AND","conditions":[]}}',
    })
    expect(result.success).toBe(false)
  })

  it("rejects unknown operator", () => {
    const result = parsePolicyPayloadStrict({
      actionsJson: '["read"]',
      capabilitiesJson: "[]",
      conditionsJson: JSON.stringify({
        version: 2,
        systemScope: { logic: "AND", conditions: [{ field: "age", operator: "unknownOp", value: "10" }] },
        userFilters: { logic: "AND", conditions: [] },
      }),
    })
    expect(result.success).toBe(false)
  })

  it("deduplicates actions", () => {
    const result = parsePolicyPayloadStrict({
      actionsJson: '["read","read","update"]',
      capabilitiesJson: "[]",
      conditionsJson: '{"version":2,"systemScope":{"logic":"AND","conditions":[]},"userFilters":{"logic":"AND","conditions":[]},"fieldAccess":{}}',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.payload.actions).toEqual(["read", "update"])
    }
  })

  it("missing fieldAccess is valid", () => {
    const result = parsePolicyPayloadStrict({
      actionsJson: '["read"]',
      capabilitiesJson: "[]",
      conditionsJson: JSON.stringify({
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
      }),
    })
    expect(result.success).toBe(true)
  })

  it("malformed fieldAccess fails", () => {
    const result = parsePolicyPayloadStrict({
      actionsJson: '["read"]',
      capabilitiesJson: "[]",
      conditionsJson: JSON.stringify({
        version: 2,
        systemScope: { logic: "AND", conditions: [] },
        userFilters: { logic: "AND", conditions: [] },
        fieldAccess: { read: { email: "unknown-mode" }, write: ["name", 25] },
      }),
    })
    expect(result.success).toBe(false)
  })

  it("rejects clause with both value and userAttr", () => {
    const result = parsePolicyPayloadStrict({
      actionsJson: '["read"]',
      capabilitiesJson: "[]",
      conditionsJson: JSON.stringify({
        version: 2,
        systemScope: { logic: "AND", conditions: [{ field: "branchId", operator: "equals", value: "branch-1", userAttr: "user.branchId" }] },
        userFilters: { logic: "AND", conditions: [] },
      }),
    })
    expect(result.success).toBe(false)
  })

  it("rejects oversized and over-deep policy input before recursive parsing", () => {
    expect(parseStringArrayStrict(`["${"x".repeat(1_048_577)}"]`, "actionsJson").success).toBe(false)
    let group: unknown = { logic: "AND", conditions: [] }
    for (let index = 0; index < 21; index += 1) group = { logic: "AND", conditions: [group] }
    expect(parsePolicyPayloadStrict({ actionsJson: "[]", capabilitiesJson: "[]", conditionsJson: { version: 2, systemScope: group, userFilters: { logic: "AND", conditions: [] } } }).success).toBe(false)
  })

  it("rejects accessor-backed direct inputs without invoking the accessor", () => {
    let accessed = false
    const group = Object.defineProperty({}, "logic", {
      enumerable: true,
      get: () => {
        accessed = true
        return "AND"
      },
    })
    const result = parsePolicyPayloadStrict({
      actionsJson: ["read"],
      capabilitiesJson: [],
      conditionsJson: { version: 2, systemScope: group, userFilters: { logic: "AND", conditions: [] } },
    })
    expect(result.success).toBe(false)
    expect(accessed).toBe(false)
  })

  it.each([
    ["JSON array", '["read", "update"]', true, ["read", "update"]],
    ["array value", ["read", "update"], true, ["read", "update"]],
    ["invalid JSON", "not-json", false, undefined],
    ["non-array", '"read"', false, undefined],
    ["mixed values", '["read", 42]', false, undefined],
  ] as const)("strictly parses %s", (_name, input, success, value) => {
    const result = parseStringArrayStrict(input, "actionsJson")
    expect(result.success).toBe(success)
    if (result.success === true) expect(result.value).toEqual(value)
    else expect(result.errors[0]?.path).toContain("actionsJson")
  })

  it.each([
    ["duplicate capabilities", '["export", "export"]', ["export"]],
    ["empty actions", "[]", []],
  ] as const)("normalizes %s", (_name, capabilitiesJson, expected) => {
    const result = parsePolicyPayloadStrict({
      actionsJson: capabilitiesJson,
      capabilitiesJson,
      conditionsJson: '{"version":2,"systemScope":{"logic":"AND","conditions":[]},"userFilters":{"logic":"AND","conditions":[]}}',
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.payload.actions).toEqual(expected)
  })
})
