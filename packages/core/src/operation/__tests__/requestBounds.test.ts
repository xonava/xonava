import { describe, expect, it } from "vitest"
import { createOperationContext, createOperationRunContext } from "../operationContext"
import { createExecutionDeadline } from "../deadline"

const persistence = { dialect: "test", capabilities: {}, repository: () => ({}) } as never
const runtimeCapabilities = { deferredExecution: false } as never
const now = new Date("2026-10-01T00:00:00.000Z")
const clock = { now: () => now }

describe("request cancellation and deadline bound the operation", () => {
  it("aborts the run when the request is cancelled", () => {
    const request = new AbortController()
    const run = createOperationRunContext({ ...createOperationContext({ persistence, runtimeCapabilities, clock }), request: { requestId: "r", signal: request.signal } as never })
    expect(run.signal.aborted).toBe(false)
    request.abort(new Error("client went away"))
    expect(run.signal.aborted).toBe(true)
  })

  it("still aborts on the environment signal", () => {
    const environment = new AbortController()
    const run = createOperationRunContext({ ...createOperationContext({ persistence, runtimeCapabilities, clock, signal: environment.signal }), request: { requestId: "r", signal: new AbortController().signal } as never })
    environment.abort()
    expect(run.signal.aborted).toBe(true)
  })

  it("uses the earlier of the request deadline and the execution budget", () => {
    const base = createOperationContext({ persistence, runtimeCapabilities, clock, deadline: createExecutionDeadline(new Date(now.getTime() + 60_000)) })
    const shorter = createOperationRunContext({ ...base, request: { requestId: "r", signal: new AbortController().signal, deadline: "2026-10-01T00:00:05.000Z" } as never })
    expect(shorter.deadline.expiresAt.toISOString()).toBe("2026-10-01T00:00:05.000Z")
    const longer = createOperationRunContext({ ...base, request: { requestId: "r", signal: new AbortController().signal, deadline: "2026-10-02T00:00:00.000Z" } as never })
    expect(longer.deadline.expiresAt.toISOString()).toBe("2026-10-01T00:01:00.000Z")
  })
})
