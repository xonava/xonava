import { describe, expect, it } from "vitest"
import { createExecutionDeadline, createOperationContext, createOperationInvoker, createOperationServices, validateExecutionBudget } from "../index"

const persistence = { dialect: "test", capabilities: {}, repository: () => ({}) } as never
const runtimeCapabilities = { deferredExecution: false, cache: false }

describe("OP1 execution controls and composition", () => {
  it("uses an injectable Clock and validates budgets", () => {
    const now = new Date("2026-09-11T00:00:00.000Z")
    expect(createOperationServices({ clock: { now: () => now } }).clock.now()).toBe(now)
    expect(() => validateExecutionBudget({ maxNestingDepth: 0, maxDurationMs: 1 })).toThrow(/maxNestingDepth/)
  })

  it("rejects expired and cancelled operations before execution", async () => {
    const now = new Date("2026-09-11T00:00:00.000Z")
    const services = createOperationServices({ clock: { now: () => now } })
    const expired = createOperationContext({ persistence, runtimeCapabilities, services, deadline: createExecutionDeadline(new Date(now.getTime() - 1)) })
    await expect(createOperationInvoker(expired).invoke({ key: "read", kind: "read", execute: () => "bad" }, null)).rejects.toThrow(/deadline/)
    const controller = new AbortController(); controller.abort(new Error("cancelled"))
    const cancelled = createOperationContext({ persistence, runtimeCapabilities, services, signal: controller.signal })
    await expect(createOperationInvoker(cancelled).invoke({ key: "read", kind: "read", execute: () => "bad" }, null)).rejects.toThrow(/cancelled/)
  })

  it("inherits execution identity and reruns child authorization", async () => {
    let authorized = 0
    const environment = createOperationContext({ persistence, runtimeCapabilities, executionBudget: { maxNestingDepth: 2, maxDurationMs: 1000 } })
    const value = await createOperationInvoker(environment).invoke({ key: "child", kind: "read", authorization: { async authorize() { authorized += 1; return { allowed: true } } }, execute: () => "ok" }, null)
    expect(authorized).toBe(1)
    expect(value).toBe("ok")
  })

  it("enforces maximum nesting depth", async () => {
    const environment = createOperationContext({ persistence, runtimeCapabilities, executionBudget: { maxNestingDepth: 1, maxDurationMs: 1000 } })
    const nested = { ...environment, nestingDepth: 1 }
    await expect(createOperationInvoker(nested).invoke({ key: "read", kind: "read", execute: () => "bad" }, null)).rejects.toThrow(/nesting depth/)
  })
})
