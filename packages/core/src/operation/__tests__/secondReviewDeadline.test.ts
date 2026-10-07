import { describe, expect, it } from "vitest"
import { assertExecutionActive, createExecutionDeadline } from "../deadline"
import { CancelledError, TimeoutError } from "../../domain/errors"

const clock = (ms: number) => ({ now: () => new Date(ms) })

describe("execution deadline errors are framework errors", () => {
  it("throws TimeoutError when the deadline has passed", () => {
    const deadline = createExecutionDeadline(new Date(100))
    expect(() => assertExecutionActive(new AbortController().signal, deadline, clock(100))).toThrow(TimeoutError)
    expect(() => assertExecutionActive(new AbortController().signal, deadline, clock(99))).not.toThrow()
  })

  it("throws CancelledError on abort and keeps the abort reason as its cause", () => {
    const deadline = createExecutionDeadline(new Date(100))
    const reason = new Error("client went away")
    const controller = new AbortController(); controller.abort(reason)
    let thrown: unknown
    try { assertExecutionActive(controller.signal, deadline, clock(0)) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(CancelledError)
    expect((thrown as Error).cause).toBe(reason)

    const plain = new AbortController(); plain.abort("shutdown")
    try { assertExecutionActive(plain.signal, deadline, clock(0)) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(CancelledError)
    expect((thrown as Error).cause).toBe("shutdown")
  })

  it("rethrows framework cancellation and timeout reasons unchanged", () => {
    const deadline = createExecutionDeadline(new Date(100))
    for (const reason of [new CancelledError(), new TimeoutError()]) {
      const controller = new AbortController(); controller.abort(reason)
      expect(() => assertExecutionActive(controller.signal, deadline, clock(0))).toThrow(reason)
    }
  })
})
