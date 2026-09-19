import { describe, expect, it } from "vitest"
import { ConflictError, FrameworkCoreError, RetryablePersistenceError } from "../../domain"

describe("RetryablePersistenceError", () => {
  it("is a framework error with retryable job classification", () => {
    const error = new RetryablePersistenceError("Serialization failure", { postgresCode: "40001" })

    expect(error).toBeInstanceOf(FrameworkCoreError)
    expect(error).toBeInstanceOf(RetryablePersistenceError)
    expect(error).not.toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({
      code: "RETRYABLE_PERSISTENCE_ERROR",
      safeMessage: "Service temporarily unavailable",
      retryable: true,
      category: "dependency",
      publicCode: "SERVICE_UNAVAILABLE",
      safeMetadata: {},
      kind: "retryable",
      details: { postgresCode: "40001" },
    })
    expect(error).not.toHaveProperty("httpStatus")
  })
})
