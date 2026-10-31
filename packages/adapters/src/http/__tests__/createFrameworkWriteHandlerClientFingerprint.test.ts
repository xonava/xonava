import { beforeEach, describe, expect, it, vi } from "vitest"
import { ValidationError } from "@xonava/core/domain"
import { CanonicalJsonError } from "@xonava/core/serialization"
import { IdempotencyPayloadTooLargeError } from "../idempotency"
import { idempotentConfig, makeWrite } from "./writeHandlerHarness"

const spy = vi.hoisted(() => ({
  errors: [] as unknown[],
  fingerprintFailure: undefined as unknown,
}))

vi.mock("../handleFrameworkCoreError", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../handleFrameworkCoreError")>()
  return {
    ...actual,
    createFrameworkErrorHandler: (options?: Parameters<typeof actual.createFrameworkErrorHandler>[0]) => {
      const inner = actual.createFrameworkErrorHandler(options)
      return (error: unknown, metadata?: Parameters<typeof inner>[1]) => {
        spy.errors.push(error)
        return inner(error, metadata)
      }
    },
  }
})

vi.mock("../idempotency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../idempotency")>()
  return {
    ...actual,
    fingerprintJson: async (value: unknown) => {
      if (spy.fingerprintFailure !== undefined) throw spy.fingerprintFailure
      return actual.fingerprintJson(value)
    },
  }
})

beforeEach(() => {
  spy.errors.length = 0
  spy.fingerprintFailure = undefined
})

describe("client material that cannot be fingerprinted", () => {
  it.each([
    ["a canonical JSON error", () => new CanonicalJsonError("not canonical")],
    ["an oversized payload", () => new IdempotencyPayloadTooLargeError()],
  ])("answers %s as a bad request with a fixed message", async (_label, make) => {
    spy.fingerprintFailure = make()
    const h = makeWrite(idempotentConfig())
    const response = await h.send({})
    expect(response.status).toBe(400)
    expect(spy.errors.at(-1)).toEqual(new ValidationError("Request cannot be used with an Idempotency-Key"))
    expect(h.execute).not.toHaveBeenCalled()
    expect(h.port.acquire).not.toHaveBeenCalled()
  })

  it("does not disguise any other fingerprint failure as a client error", async () => {
    const failure = new Error("digest unavailable")
    spy.fingerprintFailure = failure
    const h = makeWrite(idempotentConfig())
    const response = await h.send({})
    expect(response.status).toBe(500)
    expect(spy.errors.at(-1)).toBe(failure)
  })
})
