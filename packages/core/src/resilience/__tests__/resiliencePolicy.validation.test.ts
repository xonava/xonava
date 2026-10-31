import { describe, expect, it } from "vitest"
import { CancelledError, ConfigurationError, TimeoutError } from "../../domain/errors"
import { abortSignalError } from "../abortSignal"
import { MAX_BACKOFF_ATTEMPTS, MAX_BACKOFF_DELAY_MS } from "../backoff"
import { validateResiliencePolicy, type ExternalCallSemantics, type ResiliencePolicy } from "../resilience"

const read: ExternalCallSemantics = { kind: "read" }
const fail = (policy: unknown, semantics: unknown = read): ConfigurationError => {
  try {
    validateResiliencePolicy(policy as ResiliencePolicy, semantics as ExternalCallSemantics)
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError)
    return error as ConfigurationError
  }
  throw new Error("expected validateResiliencePolicy to throw")
}

describe("validateResiliencePolicy exact outcomes", () => {
  it("rejects every non-object policy with the exact message", () => {
    for (const bad of [null, undefined, 0, 1, "x", true, [], [1]]) expect(fail(bad).message).toBe("Resilience policy must be an object")
    expect(() => validateResiliencePolicy({}, read)).not.toThrow()
  })

  it("rejects every non-object section with the exact message", () => {
    for (const name of ["retry", "circuitBreaker", "bulkhead"]) {
      for (const bad of [null, 0, 1, "x", true, [], [1]]) expect(fail({ [name]: bad }).message).toBe(`${name} must be an object`)
    }
  })

  it("requires own, defined keys and names them", () => {
    expect(fail({ retry: {} }).message).toBe("retry.maxAttempts is required")
    expect(fail({ retry: { maxAttempts: undefined } }).message).toBe("retry.maxAttempts is required")
    expect(fail({ circuitBreaker: { failureThreshold: 1 } }).message).toBe("circuitBreaker.resetAfterMs is required")
    expect(fail({ circuitBreaker: { resetAfterMs: 1 } }).message).toBe("circuitBreaker.failureThreshold is required")
    expect(fail({ bulkhead: { maxConcurrent: undefined } }).message).toBe("bulkhead.maxConcurrent is required")
    expect(fail({ bulkhead: Object.create({ maxConcurrent: 2 }) as unknown }).message).toBe("bulkhead.maxConcurrent is required")
    const accessor = Object.defineProperty({}, "maxConcurrent", { get: () => 2, enumerable: true })
    expect(fail({ bulkhead: accessor }).message).toBe("bulkhead.maxConcurrent is required")
    expect(() => validateResiliencePolicy({ bulkhead: { maxConcurrent: 2 } }, read)).not.toThrow()
  })

  it("names each non-positive field exactly", () => {
    const cases: Array<[unknown, string]> = [
      [{ timeoutMs: 0 }, "timeoutMs"],
      [{ retry: { maxAttempts: 0 } }, "retry.maxAttempts"],
      [{ retry: { maxAttempts: 1, backoffMs: 0 } }, "retry.backoffMs"],
      [{ circuitBreaker: { failureThreshold: 0, resetAfterMs: 1 } }, "circuitBreaker.failureThreshold"],
      [{ circuitBreaker: { failureThreshold: 1, resetAfterMs: 0 } }, "circuitBreaker.resetAfterMs"],
      [{ bulkhead: { maxConcurrent: 0 } }, "bulkhead.maxConcurrent"],
    ]
    for (const [policy, name] of cases) expect(fail(policy).message).toBe(`${name} must be a positive safe integer`)
  })

  it("enforces the shared caps with exact boundaries and messages", () => {
    expect(fail({ retry: { maxAttempts: MAX_BACKOFF_ATTEMPTS + 1 } }).message).toBe(`retry.maxAttempts must not exceed ${MAX_BACKOFF_ATTEMPTS}`)
    expect(fail({ timeoutMs: MAX_BACKOFF_DELAY_MS + 1 }).message).toBe(`timeoutMs must not exceed ${MAX_BACKOFF_DELAY_MS}`)
    expect(() => validateResiliencePolicy({ timeoutMs: MAX_BACKOFF_DELAY_MS, retry: { maxAttempts: MAX_BACKOFF_ATTEMPTS } }, read)).not.toThrow()
  })

  it("validates maxQueue, idempotency key and non-idempotent retries with exact messages", () => {
    for (const q of [-1, 1.5, Number.NaN]) expect(fail({ bulkhead: { maxConcurrent: 1, maxQueue: q } }).message).toBe("bulkhead.maxQueue must be a non-negative safe integer")
    expect(() => validateResiliencePolicy({ bulkhead: { maxConcurrent: 1, maxQueue: 0 } }, read)).not.toThrow()
    for (const key of ["", "  ", undefined, 3]) expect(fail({}, { kind: "idempotent-mutation", idempotencyKey: key }).message).toBe("idempotent mutation requires a non-empty idempotency key")
    expect(fail({ retry: { maxAttempts: 2 } }, { kind: "non-idempotent-mutation" }).message).toBe("non-idempotent external mutations cannot be retried automatically")
    expect(() => validateResiliencePolicy({ retry: { maxAttempts: 1 } }, { kind: "non-idempotent-mutation" })).not.toThrow()
    expect(fail({}, { kind: "other" }).message).toBe("External call semantics are invalid")
    expect(fail({}, null).message).toBe("External call semantics are invalid")
  })
})

describe("abortSignalError exact mapping", () => {
  const aborted = (reason?: unknown): AbortSignal => {
    const c = new AbortController()
    c.abort(reason)
    return c.signal
  }

  it("uses the default message and keeps Error reasons as the cause", () => {
    const reason = new Error("boom")
    const error = abortSignalError(aborted(reason))
    expect(error).toBeInstanceOf(CancelledError)
    expect(error.message).toBe("The operation was cancelled")
    expect(error.cause).toBe(reason)
    expect(abortSignalError(aborted(reason), "custom").message).toBe("custom")
  })

  it("keeps non-Error reasons as a non-enumerable, writable, configurable cause", () => {
    for (const reason of ["why", 0, false, { a: 1 }]) {
      const error = abortSignalError(aborted(reason))
      expect(error.cause).toBe(reason)
      const d = Object.getOwnPropertyDescriptor(error, "cause")
      expect(d).toMatchObject({ value: reason, writable: true, configurable: true, enumerable: false })
    }
  })

  it("sets no cause for an undefined reason and for an Error reason beyond the constructor", () => {
    const error = abortSignalError({ reason: undefined } as AbortSignal)
    expect(error.cause).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(error, "cause")).toBeUndefined()
    const err = abortSignalError(aborted(new Error("e")))
    expect(Object.getOwnPropertyDescriptor(err, "cause")?.enumerable).toBeFalsy()
  })

  it("returns framework errors unchanged and maps platform timeouts", () => {
    const cancelled = new CancelledError("c")
    const timeout = new TimeoutError("t")
    expect(abortSignalError(aborted(cancelled))).toBe(cancelled)
    expect(abortSignalError(aborted(timeout))).toBe(timeout)
    const named = new Error("slow")
    named.name = "TimeoutError"
    const mapped = abortSignalError(aborted(named), "ignored")
    expect(mapped).toBeInstanceOf(TimeoutError)
    expect(mapped.message).toBe("The operation timed out")
    expect(mapped.cause).toBe(named)
    const dom = abortSignalError(aborted(new DOMException("x", "TimeoutError")))
    expect(dom).toBeInstanceOf(TimeoutError)
    expect(abortSignalError(aborted(new DOMException("x", "AbortError")))).toBeInstanceOf(CancelledError)
    expect(abortSignalError(aborted({ name: "TimeoutError" }))).toBeInstanceOf(CancelledError)
  })

  it("maps a DOMException timeout that is not an Error instance, and works without DOMException", () => {
    const fake = Object.create(DOMException.prototype, { name: { value: "TimeoutError" } }) as unknown
    expect(abortSignalError({ reason: fake } as AbortSignal)).toBeInstanceOf(TimeoutError)
    const original = globalThis.DOMException
    try {
      Object.defineProperty(globalThis, "DOMException", { value: undefined, configurable: true, writable: true })
      expect(abortSignalError({ reason: { name: "TimeoutError" } } as AbortSignal)).toBeInstanceOf(CancelledError)
      expect(abortSignalError({ reason: "x" } as AbortSignal)).toBeInstanceOf(CancelledError)
    } finally {
      Object.defineProperty(globalThis, "DOMException", { value: original, configurable: true, writable: true })
    }
  })
})
