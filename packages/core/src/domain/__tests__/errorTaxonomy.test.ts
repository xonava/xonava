import { describe, expect, it } from "vitest"
import { BusinessRuleError, CancelledError, ConfigurationError, ForbiddenError, FrameworkCoreError, PreconditionRequiredError, PublicBusinessError, RequiredHeaderMissingError, TimeoutError, UnavailableError, ValidationError } from "../errors"

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

  it("classifies header errors with public metadata", () => {
    expect(new RequiredHeaderMissingError("Idempotency-Key")).toMatchObject({ code: "REQUIRED_HEADER_MISSING", publicCode: "REQUIRED_HEADER_MISSING", safeMessage: "A required request header is missing", category: "validation", retryable: false, safeMetadata: { header: "Idempotency-Key" } })
    expect(new PreconditionRequiredError("If-Match")).toMatchObject({ code: "PRECONDITION_REQUIRED", publicCode: "PRECONDITION_REQUIRED", safeMessage: "A precondition header is required", safeMetadata: { header: "If-Match" } })
    expect(() => new RequiredHeaderMissingError("bad header\n")).toThrow(ConfigurationError)
  })

  describe("PublicBusinessError", () => {
    const valid = { publicCode: "ORDER_ALREADY_SHIPPED", publicMessage: "This order has already shipped", fields: ["orderId"] }

    it("exposes the supplied code, message and fields while staying a BAD_REQUEST", () => {
      const error = new PublicBusinessError(valid, { internal: "x" })
      expect(error).toBeInstanceOf(BusinessRuleError)
      expect(error).toMatchObject({ code: "BAD_REQUEST", safeMessage: valid.publicMessage, publicCode: valid.publicCode, fields: ["orderId"], category: "validation" })
      expect(new PublicBusinessError({ publicCode: "ABC", publicMessage: "m" }).fields).toEqual([])
    })

    it("does not change the generic BusinessRuleError or other registry errors", () => {
      expect(new BusinessRuleError("secret")).toMatchObject({ safeMessage: "Business rule violation", publicCode: "BAD_REQUEST" })
      expect(new ForbiddenError("secret").safeMessage).toBe("Forbidden")
    })

    it.each([
      ["lowercase code", { ...valid, publicCode: "order_shipped" }],
      ["too short code", { ...valid, publicCode: "AB" }],
      ["too long code", { ...valid, publicCode: "A".repeat(65) }],
      ["registry code", { ...valid, publicCode: "FORBIDDEN" }],
      ["registry public code", { ...valid, publicCode: "INTERNAL_SERVER_ERROR" }],
      ["new registry code", { ...valid, publicCode: "PRECONDITION_REQUIRED" }],
      ["empty message", { ...valid, publicMessage: "" }],
      ["long message", { ...valid, publicMessage: "x".repeat(201) }],
      ["control character", { ...valid, publicMessage: "bad\nmessage" }],
      ["too many fields", { ...valid, fields: Array.from({ length: 21 }, (_, i) => `f${i}`) }],
      ["empty field", { ...valid, fields: [""] }],
      ["long field", { ...valid, fields: ["x".repeat(201)] }],
    ])("rejects %s with ConfigurationError", (_name, input) => {
      expect(() => new PublicBusinessError(input)).toThrow(ConfigurationError)
    })
  })
})
