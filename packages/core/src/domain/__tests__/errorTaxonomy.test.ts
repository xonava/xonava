import { describe, expect, it } from "vitest"
import { CancelledError, ConfigurationError, FrameworkCoreError, TimeoutError, UnavailableError, ValidationError } from "../errors"

describe("error taxonomy", () => {
  it("classifies timeout, cancellation, and unavailability", () => {
    expect(new TimeoutError()).toMatchObject({ code: "TIMEOUT", retryable: true, category: "dependency", publicCode: "TIMEOUT", name: "TimeoutError" })
    expect(new CancelledError()).toMatchObject({ code: "CANCELLED", retryable: false, publicCode: "CANCELLED" })
    expect(new UnavailableError()).toMatchObject({ code: "UNAVAILABLE", retryable: true, publicCode: "SERVICE_UNAVAILABLE" })
  })

  it("chains causes explicitly or from an Error passed as details", () => {
    const root = new Error("socket reset")
    expect(new ConfigurationError("wrapped", root).cause).toBe(root)
    expect(new FrameworkCoreError("explicit", "UNAVAILABLE", { safe: true }, {}, { cause: root }).cause).toBe(root)
    expect(new ValidationError("no cause", { field: "x" }).cause).toBeUndefined()
    expect("cause" in new ValidationError("no cause")).toBe(false)
  })

  it("never exposes internal messages through the public fields", () => {
    const error = new ConfigurationError("database password=hunter2 rejected")
    expect(error.safeMessage).toBe("Internal Server Error")
    expect(error.publicCode).toBe("INTERNAL_SERVER_ERROR")
    expect(Object.isFrozen(error.safeMetadata)).toBe(true)
  })
})
