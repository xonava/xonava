import { describe, expect, it } from "vitest"
import { assertObjectRequestActive } from "../objectStore"
import { CancelledError, TimeoutError } from "../../domain/errors"

describe("object request activity errors", () => {
  it("raises TimeoutError for an expired deadline and CancelledError for an abort", () => {
    expect(() => assertObjectRequestActive({ deadline: 1 }, 1)).toThrow(TimeoutError)
    const reason = new Error("stop")
    const controller = new AbortController(); controller.abort(reason)
    let thrown: unknown
    try { assertObjectRequestActive({ signal: controller.signal }) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(CancelledError)
    expect((thrown as Error).cause).toBe(reason)
  })
})
