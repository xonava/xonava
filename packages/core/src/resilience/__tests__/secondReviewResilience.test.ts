import { describe, expect, it } from "vitest"
import { createCircuitBreaker, withResilience } from "../executor"
import { validateResiliencePolicy } from "../resilience"
import { MAX_BACKOFF_DELAY_MS } from "../backoff"
import { ConfigurationError, UnavailableError } from "../../domain/errors"

const policy = { failureThreshold: 1, resetAfterMs: 1_000 }

describe("circuit breaker admission generations (C9)", () => {
  it("ignores a stale closed-state failure that completes while half-open (no second probe)", () => {
    let now = 0
    const breaker = createCircuitBreaker(policy, () => now)
    const stale = breaker.admit()
    breaker.admit()("failure")
    expect(breaker.state.status).toBe("open")
    now = 1_000
    const probe = breaker.admit()
    expect(breaker.state).toMatchObject({ status: "half_open", trialInFlight: true })
    stale("failure")
    expect(breaker.state).toMatchObject({ status: "half_open", trialInFlight: true })
    expect(() => breaker.admit()).toThrow(UnavailableError)
    probe("success")
    expect(breaker.state.status).toBe("closed")
  })

  it("ignores a stale success that completes while half-open (does not close the circuit)", () => {
    let now = 0
    const breaker = createCircuitBreaker(policy, () => now)
    const stale = breaker.admit()
    breaker.admit()("failure")
    now = 1_000
    const probe = breaker.admit()
    stale("success")
    expect(breaker.state.status).toBe("half_open")
    expect(() => breaker.admit()).toThrow(UnavailableError)
    probe("failure")
    expect(breaker.state.status).toBe("open")
  })

  it("treats caller cancellation as neutral and releases a half-open probe", async () => {
    let now = 0
    const breaker = createCircuitBreaker({ failureThreshold: 2, resetAfterMs: 1_000 }, () => now)
    const policyWithBreaker = { circuitBreaker: { failureThreshold: 2, resetAfterMs: 1_000 } }
    const controller = new AbortController()
    const run = withResilience(policyWithBreaker, { kind: "read" }, (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))), { breaker, signal: controller.signal })
    controller.abort(new Error("caller left"))
    await expect(run).rejects.toThrow("caller left")
    expect(breaker.state).toMatchObject({ status: "closed", consecutiveFailures: 0 })

    breaker.admit()("failure"); breaker.admit()("failure")
    now = 1_000
    const probeController = new AbortController()
    const probe = withResilience(policyWithBreaker, { kind: "read" }, (signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))), { breaker, signal: probeController.signal })
    expect(breaker.state).toMatchObject({ status: "half_open", trialInFlight: true })
    probeController.abort(new Error("caller left"))
    await expect(probe).rejects.toThrow("caller left")
    expect(breaker.state).toMatchObject({ status: "half_open", trialInFlight: false })
    breaker.admit()("success")
    expect(breaker.state.status).toBe("closed")
  })
})

describe("resilience timeout bound", () => {
  it("rejects timeoutMs beyond the shared maximum delay", () => {
    expect(() => validateResiliencePolicy({ timeoutMs: 2 ** 31 }, { kind: "read" })).toThrow(ConfigurationError)
    expect(() => validateResiliencePolicy({ timeoutMs: MAX_BACKOFF_DELAY_MS + 1 }, { kind: "read" })).toThrow(ConfigurationError)
    expect(validateResiliencePolicy({ timeoutMs: MAX_BACKOFF_DELAY_MS }, { kind: "read" }).timeoutMs).toBe(MAX_BACKOFF_DELAY_MS)
  })
})
