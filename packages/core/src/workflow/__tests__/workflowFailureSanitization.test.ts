import { describe, expect, it } from "vitest"
import { createWorkflowFailure } from "../workflowStateMachine"

const at = new Date("2026-01-01T00:00:00.000Z")
const failure = (message: unknown) => createWorkflowFailure({ code: "STEP_FAILED", message, step: "s", phase: "execute", attempt: 1, at })

describe("createWorkflowFailure sanitization bounds", () => {
  it("falls back to a fixed message when the capped text is one long token that has to be dropped whole", () => {
    expect(failure("x".repeat(100_000)).message).toBe("Workflow step failed (message truncated)")
    expect(failure("9".repeat(100_000)).message).toBe("Workflow step failed (message truncated)")
    expect(failure(`${"a.".repeat(50_000)}`).message).toBe("Workflow step failed (message truncated)")
    expect(failure(`   ${"x".repeat(10_000)}`).message).toBe("Workflow step failed (message truncated)")
  })

  it("keeps the readable prefix when the cut token is not the only token", () => {
    const message = failure(`database unavailable ${"x".repeat(10_000)}`).message
    expect(message).toBe("database unavailable ")
  })

  it("leaves short messages untouched, including an empty one", () => {
    expect(failure("boom").message).toBe("boom")
    expect(failure("").message).toBe("")
  })

  it("sanitizes a 1 MB adversarial message quickly", () => {
    const started = performance.now()
    failure("a.".repeat(500_000))
    failure("1 ".repeat(500_000))
    expect(performance.now() - started).toBeLessThan(500)
  })
})
