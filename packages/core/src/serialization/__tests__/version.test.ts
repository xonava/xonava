import { describe, expect, it } from "vitest"
import { ConfigurationError } from "../../domain/errors"
import { assertEntityVersion, assertEntityVersionCanIncrement, isEntityVersion } from "../version"

describe("EntityVersion", () => {
  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts persisted safe version %s", (value) => {
    expect(isEntityVersion(value)).toBe(true)
    expect(() => assertEntityVersion(value)).not.toThrow()
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null, undefined])(
    "rejects malformed version %s",
    (value) => expect(() => assertEntityVersion(value)).toThrow(ConfigurationError),
  )

  it("rejects incrementing the maximum safe version before mutation", () => {
    expect(() => assertEntityVersionCanIncrement(Number.MAX_SAFE_INTEGER)).toThrow(ConfigurationError)
    expect(() => assertEntityVersionCanIncrement(Number.MAX_SAFE_INTEGER - 1)).not.toThrow()
  })
})
