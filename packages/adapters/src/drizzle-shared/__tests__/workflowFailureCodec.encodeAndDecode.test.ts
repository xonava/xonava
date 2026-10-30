import { describe, expect, it } from "vitest"
import type { WorkflowFailure } from "@xonava/core/workflow"
import { decodeWorkflowFailure, encodeWorkflowFailure } from "../workflowFailureCodec"

const AT = "2026-03-04T05:06:07.089Z"
const valid = { code: "STEP_FAILED", message: "boom", step: "charge", phase: "execute", attempt: 2, at: AT }
const failure: WorkflowFailure = { code: "STEP_FAILED", message: "boom", step: "charge", phase: "execute", attempt: 2, at: new Date(AT) }

describe("encodeWorkflowFailure", () => {
  it("returns null for null, undefined", () => {
    expect(encodeWorkflowFailure(null)).toBeNull()
    expect(encodeWorkflowFailure(undefined)).toBeNull()
  })
  it("encodes the exact JSON with key order and ISO timestamp", () => {
    expect(encodeWorkflowFailure(failure)).toBe(`{"code":"STEP_FAILED","message":"boom","step":"charge","phase":"execute","attempt":2,"at":"${AT}"}`)
  })
})

describe("decodeWorkflowFailure", () => {
  it("round-trips encode -> decode with a frozen, exact record", () => {
    const decoded = decodeWorkflowFailure(encodeWorkflowFailure(failure))
    expect(decoded).toStrictEqual(failure)
    expect(Object.isFrozen(decoded)).toBe(true)
    expect(decoded?.at).toBeInstanceOf(Date)
    expect(decoded?.at.toISOString()).toBe(AT)
  })
  it("accepts an already-parsed object and the compensate phase", () => {
    const decoded = decodeWorkflowFailure({ ...valid, phase: "compensate", attempt: 0 })
    expect(decoded).toStrictEqual({ ...failure, phase: "compensate", attempt: 0 })
  })
  it("returns null for null, undefined and invalid JSON text", () => {
    expect(decodeWorkflowFailure(null)).toBeNull()
    expect(decodeWorkflowFailure(undefined)).toBeNull()
    expect(decodeWorkflowFailure("{not json")).toBeNull()
    expect(decodeWorkflowFailure("")).toBeNull()
  })
  it("rejects non-object JSON values and arrays", () => {
    for (const v of ["null", "0", "42", "\"text\"", "true", "[]", JSON.stringify([valid]), 5, true, [valid], []]) {
      expect(decodeWorkflowFailure(v as never)).toBeNull()
    }
  })
  it("rejects each wrongly typed or missing field", () => {
    const bad: Array<Record<string, unknown>> = [
      { ...valid, code: 1 }, { ...valid, code: undefined },
      { ...valid, message: 1 }, { ...valid, message: undefined },
      { ...valid, step: 1 }, { ...valid, step: undefined },
      { ...valid, phase: "other" }, { ...valid, phase: undefined }, { ...valid, phase: 1 },
      { ...valid, attempt: "2" }, { ...valid, attempt: undefined },
      { ...valid, attempt: 1.5 }, { ...valid, attempt: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, attempt: Number.NaN },
      { ...valid, at: 1700000000000 }, { ...valid, at: undefined }, { ...valid, at: null },
      { ...valid, at: "not a date" }, { ...valid, at: "" },
    ]
    for (const record of bad) {
      expect(decodeWorkflowFailure(record as never)).toBeNull()
      expect(decodeWorkflowFailure(JSON.stringify(record))).toBeNull()
    }
  })
  it("rejects a Date instance in place of the stored string", () => {
    expect(decodeWorkflowFailure({ ...valid, at: new Date(AT) } as never)).toBeNull()
  })
  it("accepts boundary safe integers", () => {
    expect(decodeWorkflowFailure({ ...valid, attempt: Number.MAX_SAFE_INTEGER })?.attempt).toBe(Number.MAX_SAFE_INTEGER)
    expect(decodeWorkflowFailure({ ...valid, attempt: -3 })?.attempt).toBe(-3)
  })
  it("ignores extra fields", () => {
    expect(decodeWorkflowFailure({ ...valid, extra: 1 })).toStrictEqual(failure)
  })
})
