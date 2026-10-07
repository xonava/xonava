import { describe, expect, it } from "vitest"
import { abortSignalError } from "../deadline"
import { CancelledError, TimeoutError } from "../../domain/errors"

const aborted = (reason: unknown): AbortSignal => { const controller = new AbortController(); controller.abort(reason); return controller.signal }

describe("abortSignalError maps platform abort reasons", () => {
  it("maps a DOMException TimeoutError (AbortSignal.timeout) to the framework TimeoutError with the reason as cause", () => {
    const reason = new DOMException("signal timed out", "TimeoutError")
    const error = abortSignalError(aborted(reason))
    expect(error).toBeInstanceOf(TimeoutError)
    expect(error.cause).toBe(reason)
  })

  it("maps any Error named TimeoutError to the framework TimeoutError", () => {
    const reason = Object.assign(new Error("slow"), { name: "TimeoutError" })
    const error = abortSignalError(aborted(reason))
    expect(error).toBeInstanceOf(TimeoutError)
    expect(error.cause).toBe(reason)
  })

  it("maps a DOMException AbortError and the default abort reason to CancelledError", () => {
    const reason = new DOMException("aborted", "AbortError")
    const error = abortSignalError(aborted(reason))
    expect(error).toBeInstanceOf(CancelledError)
    expect(error.cause).toBe(reason)
    const controller = new AbortController(); controller.abort()
    expect(abortSignalError(controller.signal)).toBeInstanceOf(CancelledError)
  })

  it("returns framework reasons unchanged", () => {
    for (const reason of [new CancelledError(), new TimeoutError()]) expect(abortSignalError(aborted(reason))).toBe(reason)
  })
})
