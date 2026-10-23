// @ts-nocheck
import { describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"
import { CapabilityError, ForbiddenError, OptimisticConcurrencyError, PreconditionRequiredError, PublicBusinessError, RequiredHeaderMissingError, RetryablePersistenceError, UnauthorizedError, ValidationError } from "@xonava/core/domain"
import { createFrameworkErrorHandler } from "../handleFrameworkCoreError"
import { RequestBodyNotAcceptedError, RequestBodyTooLargeError, UnsupportedMediaTypeError } from "../requestBody"

async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json()
  return body
}

describe("framework HTTP error serialization", () => {
  it.each([
    [new UnauthorizedError("credential detail", { userId: "user-1" }), 401, { error: "Unauthorized", code: "UNAUTHORIZED" }],
    [new ForbiddenError("ABAC policy detail", { policy: "secret-policy", fields: ["ssn"] }), 403, { error: "Forbidden", code: "FORBIDDEN" }],
    [new CapabilityError("tenant.module:manage", { moduleKey: "tenant.module" }), 403, { error: "Forbidden", code: "CAPABILITY_REQUIRED" }],
  ] as const)("sanitizes %s responses", async (error, status, expected) => {
    const reportError = vi.fn()
    const response = createFrameworkErrorHandler({ reportError })(error)

    expect(response.status).toBe(status)
    expect(await responseBody(response)).toEqual(expected)
    expect(reportError).toHaveBeenCalledWith(error)
  })

  it("does not leak freeform exception text on 4xx reason codes", async () => {
    const cases: Array<[unknown, number, Record<string, unknown>]> = [
      [new ValidationError("leaked validation detail", { dbPassword: "s3cret" }), 400, { error: "Validation failed", code: "VALIDATION_ERROR" }],
      [new RequestBodyTooLargeError(1024), 413, { error: "Request body is too large", code: "REQUEST_BODY_TOO_LARGE" }],
      [new UnsupportedMediaTypeError(), 415, { error: "Unsupported media type", code: "UNSUPPORTED_MEDIA_TYPE" }],
      [new RequestBodyNotAcceptedError(), 415, { error: "This operation does not accept a request body", code: "BODY_NOT_ACCEPTED" }],
    ]
    for (const [error, status, expected] of cases) {
      const response = createFrameworkErrorHandler()(error)
      expect(response.status).toBe(status)
      const body = await responseBody(response)
      expect(body).not.toMatchObject({ error: expect.stringContaining("leaked") as unknown })
      expect(body).toEqual(expected)
    }
  })

  it("refuses a body sent to an operation that accepts none with BODY_NOT_ACCEPTED", async () => {
    const response = createFrameworkErrorHandler()(new RequestBodyNotAcceptedError())
    expect(response.status).toBe(415)
    expect(await responseBody(response)).toEqual({
      error: "This operation does not accept a request body",
      code: "BODY_NOT_ACCEPTED",
    })
  })

  it("sanitizes ZodError issues and never returns raw issues", async () => {
    const zodError = new ZodError([
      {
        code: "custom",
        path: ["a", 1, "nested"],
        message: "boom",
        secret: "do-not-leak",
        input: { confidential: true },
      } as never,
    ])
    const response = createFrameworkErrorHandler()(zodError)
    expect(response.status).toBe(400)

    const body = await responseBody(response)
    expect(body).toEqual({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: [{ code: "custom", path: "a.1.nested", message: "boom" }],
    })
    expect(JSON.stringify(body)).not.toContain("do-not-leak")
  })

  it("maps a ZodError from another zod installation to 400 VALIDATION_ERROR", async () => {
    class ZodError extends Error {
      name = "ZodError"
      issues = [{ code: "too_small", path: ["items", 0, "qty"], message: "Too small" }]
    }
    const response = createFrameworkErrorHandler()(new ZodError("foreign"))
    expect(response.status).toBe(400)
    expect(await responseBody(response)).toEqual({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: [{ code: "too_small", path: "items.0.qty", message: "Too small" }],
    })
  })

  it("sanitizes hostile foreign issue shapes without echoing their extra data", async () => {
    class ZodError extends Error {
      name = "ZodError"
      issues = [
        { path: "not-an-array", message: { leaked: "secret" }, received: "secret" },
        { code: { leaked: "secret" }, path: ["a", { leaked: "secret" }, 2], message: "ok" },
      ]
    }
    const response = createFrameworkErrorHandler()(new ZodError("foreign"))
    expect(response.status).toBe(400)
    const body = await responseBody(response)
    expect(body).toEqual({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      details: [
        { code: "invalid", path: "", message: "Invalid value" },
        { code: "invalid", path: "a.2", message: "ok" },
      ],
    })
    expect(JSON.stringify(body)).not.toContain("secret")
  })

  it("keeps an Error named ZodError without an issues array as an internal error", async () => {
    const response = createFrameworkErrorHandler()(Object.assign(new Error("fake"), { name: "ZodError" }))
    expect(response.status).toBe(500)
    expect(await responseBody(response)).toEqual({ error: "Internal Server Error", code: "INTERNAL_SERVER_ERROR" })
  })

  it("routes 413/415 and capability responses through metadata decoration", () => {
    const metadata = { requestId: "req-123", correlationId: "corr-456" }
    const cases = [
      createFrameworkErrorHandler()(new RequestBodyTooLargeError(1024), metadata),
      createFrameworkErrorHandler()(new UnsupportedMediaTypeError(), metadata),
      createFrameworkErrorHandler()(new RequestBodyNotAcceptedError(), metadata),
      createFrameworkErrorHandler()(new CapabilityError("tenant.module:manage", { moduleKey: "tenant.module" }), metadata),
    ]
    for (const response of cases) {
      expect(response.headers.get("x-request-id")).toBe("req-123")
      expect(response.headers.get("x-correlation-id")).toBe("corr-456")
    }
    expect(cases.map((response) => response.status)).toEqual([413, 415, 415, 403])
  })

  it("maps framework errors only from canonical metadata",async()=>{const conflict=await createFrameworkErrorHandler()(new OptimisticConcurrencyError("table users version leaked")).json();expect(conflict).toEqual({error:"Conflict",code:"OPTIMISTIC_CONCURRENCY_FAILED"});const unavailable=createFrameworkErrorHandler()(new RetryablePersistenceError("postgres host leaked"));expect(unavailable.status).toBe(503);expect(await unavailable.json()).toEqual({error:"Service temporarily unavailable",code:"SERVICE_UNAVAILABLE"})})

  describe("public error contract", () => {
    it("returns the code, message and fields of a PublicBusinessError", async () => {
      const response = createFrameworkErrorHandler()(new PublicBusinessError({ publicCode: "ORDER_ALREADY_SHIPPED", publicMessage: "This order has already shipped", fields: ["orderId"] }, { secret: "x" }))
      expect(response.status).toBe(400)
      expect(await responseBody(response)).toEqual({ error: "This order has already shipped", code: "ORDER_ALREADY_SHIPPED", details: { fields: ["orderId"] } })
    })

    it("keeps the generic body for a plain business rule error, unknown errors and forbidden errors", async () => {
      const forbidden = createFrameworkErrorHandler()(new ForbiddenError("policy detail", { fields: ["ssn"] }))
      expect(forbidden.status).toBe(403)
      expect(await responseBody(forbidden)).toEqual({ error: "Forbidden", code: "FORBIDDEN" })
      const unknown = createFrameworkErrorHandler()(new Error("boom"))
      expect(unknown.status).toBe(500)
      expect(await responseBody(unknown)).toEqual({ error: "Internal Server Error", code: "INTERNAL_SERVER_ERROR" })
    })

    it("maps header errors to 400 and 428 with details.header", async () => {
      const missing = createFrameworkErrorHandler()(new RequiredHeaderMissingError("Idempotency-Key"))
      expect(missing.status).toBe(400)
      expect(await responseBody(missing)).toEqual({ error: "A required request header is missing", code: "REQUIRED_HEADER_MISSING", details: { header: "Idempotency-Key" } })
      const precondition = createFrameworkErrorHandler()(new PreconditionRequiredError("If-Match"))
      expect(precondition.status).toBe(428)
      expect(await responseBody(precondition)).toEqual({ error: "A precondition header is required", code: "PRECONDITION_REQUIRED", details: { header: "If-Match" } })
    })
  })
})
