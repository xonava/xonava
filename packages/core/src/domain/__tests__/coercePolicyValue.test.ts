import { describe, expect, it } from "vitest"
import { coercePolicyValue, coercePolicyValueList, PolicyValidationError } from "../coercePolicyValue"

describe("coercePolicyValue", () => {
  it.each([
    ["number string", "number", "12.5", 12.5],
    ["number", "number", 7, 7],
    ["boolean true", "boolean", "true", true],
    ["boolean false", "boolean", false, false],
    ["date", "date", "2026-01-02", new Date("2026-01-02T00:00:00.000Z")],
    ["datetime", "datetime", new Date("2026-01-02T03:04:05Z"), new Date("2026-01-02T03:04:05.000Z")],
    ["identifier", "identifier", 123, "123"],
    ["nullable string", "string", null, null],
  ] as const)("coerces %s", (_name, type, value, expected) => {
    expect(coercePolicyValue({ type, value })).toEqual(expected)
  })

  it.each([
    ["NaN", "number", "not-a-number"],
    ["boolean", "boolean", "yes"],
    ["date", "date", "not-a-date"],
    ["array scalar", "string-array", "tag"],
  ] as const)("rejects invalid %s", (_name, type, value) => {
    expect(() => coercePolicyValue({ type, value })).toThrow(PolicyValidationError)
  })

  it("coerces lists and reports every invalid item with its index", () => {
    expect(coercePolicyValueList({ type: "number", values: ["1", 2] })).toEqual({ success: true, values: [1, 2] })
    const result = coercePolicyValueList({ type: "number", values: ["bad", "also-bad"] })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors).toHaveLength(2)
      expect(result.errors.map((error) => error.details)).toEqual([
        { index: 0, value: "bad", cause: { value: "bad" } },
        { index: 1, value: "also-bad", cause: { value: "also-bad" } },
      ])
    }
  })

  it("requires strings for string-array lists", () => {
    expect(coercePolicyValueList({ type: "string-array", values: ["a", "b"] })).toEqual({ success: true, values: ["a", "b"] })
    const result = coercePolicyValueList({ type: "string-array", values: ["a", 2] })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.errors[0]?.message).toContain("Expected string")
  })
})
