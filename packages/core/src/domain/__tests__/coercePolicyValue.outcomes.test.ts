import { describe, expect, it } from "vitest"
import { coercePolicyValue, PolicyValidationError, type AbacFieldType } from "../coercePolicyValue"

function failure(run: () => unknown): PolicyValidationError {
  try {
    run()
  } catch (error) {
    return error as PolicyValidationError
  }
  throw new Error("expected the call to throw")
}

function expectInvalid(type: AbacFieldType, value: unknown, message: string, details?: unknown): void {
  const error = failure(() => coercePolicyValue({ type, value }))
  expect(error).toBeInstanceOf(PolicyValidationError)
  expect(error.name).toBe("PolicyValidationError")
  expect(error.message).toBe(message)
  expect(error.details).toEqual(details)
}

describe("coercePolicyValue exact outcomes", () => {
  it("names the error class", () => {
    expect(new PolicyValidationError("x").name).toBe("PolicyValidationError")
    expect(new PolicyValidationError("x", { a: 1 }).details).toEqual({ a: 1 })
  })

  it("coerces numbers from finite numbers and numeric strings only", () => {
    expect(coercePolicyValue({ type: "number", value: " 12 " })).toBe(12)
    expect(coercePolicyValue({ type: "number", value: null })).toBeNull()
    expectInvalid("number", "  ", "Invalid number value:   ", { value: "  " })
    expectInvalid("number", "", "Invalid number value: ", { value: "" })
    expectInvalid("number", Number.POSITIVE_INFINITY, "Invalid number value: Infinity", { value: Number.POSITIVE_INFINITY })
    expectInvalid("number", true, "Invalid number value: true", { value: true })
    expectInvalid("number", [], "Invalid number value: ", { value: [] })
  })

  it("coerces booleans from booleans and their string spellings", () => {
    expect(coercePolicyValue({ type: "boolean", value: true })).toBe(true)
    expect(coercePolicyValue({ type: "boolean", value: false })).toBe(false)
    expect(coercePolicyValue({ type: "boolean", value: "true" })).toBe(true)
    expect(coercePolicyValue({ type: "boolean", value: "false" })).toBe(false)
    expectInvalid("boolean", "TRUE", "Invalid boolean value: TRUE", { value: "TRUE" })
    expectInvalid("boolean", 1, "Invalid boolean value: 1", { value: 1 })
    expectInvalid("boolean", null, "Invalid boolean value: null", { value: null })
  })

  it("coerces dates from Date objects and strict strings", () => {
    const date = new Date("2026-01-02T03:04:05.678Z")
    const copy = coercePolicyValue({ type: "datetime", value: date })
    expect(copy).toEqual(date)
    expect(copy).not.toBe(date)
    expect(coercePolicyValue({ type: "date", value: date })).toEqual(date)
    expect(coercePolicyValue({ type: "date", value: "2026-01-02" })).toEqual(new Date("2026-01-02T00:00:00.000Z"))
    expect(coercePolicyValue({ type: "datetime", value: "2026-01-02T03:04:05+01:00" })).toEqual(new Date("2026-01-02T02:04:05.000Z"))
    expectInvalid("date", new Date(Number.NaN), "Invalid date value: Invalid Date")
    expectInvalid("datetime", new Date(Number.NaN), "Invalid date value: Invalid Date")
    expectInvalid("date", "2026-01-02T03:04:05Z", "Invalid date value: 2026-01-02T03:04:05Z")
    expectInvalid("datetime", "2026-01-02", "Invalid datetime value: 2026-01-02")
    expectInvalid("date", "2026-02-30", "Invalid date value: 2026-02-30")
    expectInvalid("date", 5, "Invalid date value: 5")
    expectInvalid("datetime", null, "Invalid date value: null")
    expectInvalid("date", { not: "a date" }, "Invalid date value: [object Object]")
  })

  it("rejects scalars for string arrays with the list-operator hint", () => {
    expectInvalid("string-array", "x", "string-array values must be provided through a list operator (in, includesAny, includesAll)")
  })

  it("coerces strings and identifiers", () => {
    for (const type of ["string", "identifier"] as const) {
      expect(coercePolicyValue({ type, value: "x" })).toBe("x")
      expect(coercePolicyValue({ type, value: 5 })).toBe("5")
      expect(coercePolicyValue({ type, value: -1.5 })).toBe("-1.5")
      expect(coercePolicyValue({ type, value: true })).toBe("true")
      expect(coercePolicyValue({ type, value: false })).toBe("false")
      expect(coercePolicyValue({ type, value: null })).toBeNull()
      expectInvalid(type, Number.NaN, `Invalid ${type} value of type number`, { value: Number.NaN })
      expectInvalid(type, Number.POSITIVE_INFINITY, `Invalid ${type} value of type number`, { value: Number.POSITIVE_INFINITY })
      expectInvalid(type, undefined, `Invalid ${type} value of type undefined`, { value: undefined })
      expectInvalid(type, {}, `Invalid ${type} value of type object`, { value: {} })
      expectInvalid(type, 10n, `Invalid ${type} value of type bigint`, { value: 10n })
    }
  })

  it("treats an unknown type like a string", () => {
    expect(coercePolicyValue({ type: "other" as never, value: 5 })).toBe("5")
    expectInvalid("other" as never, {}, "Invalid other value of type object", { value: {} })
  })
})
