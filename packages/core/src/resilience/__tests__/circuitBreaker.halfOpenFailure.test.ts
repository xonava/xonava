import { describe, expect, it } from "vitest"
import { recordCircuitFailure, type CircuitBreakerState } from "../executor"

describe("recordCircuitFailure in half-open", () => {
  it("reopens on a failed trial even when the failure count is below the threshold", () => {
    const halfOpen: CircuitBreakerState = { status: "half_open", consecutiveFailures: 0, openedAt: 100, trialInFlight: true, generation: 4 }
    expect(recordCircuitFailure(halfOpen, { failureThreshold: 5, resetAfterMs: 10 }, 500, 4)).toEqual({
      status: "open",
      consecutiveFailures: 1,
      openedAt: 500,
      trialInFlight: false,
      generation: 5,
    })
  })
})
