import { describe, expect, it, vi } from "vitest"
import { boundedTelemetryAttributes, createTelemetryLogger, MAX_TELEMETRY_LOG_ATTRIBUTES, MAX_TELEMETRY_LOG_STRING_BYTES } from "../telemetry"

describe("bounded telemetry logger", () => {
  it("keeps structured primitives and drops values that cannot be safely encoded", () => {
    const attributes = boundedTelemetryAttributes("job failed", {
      jobId: "j1", attempt: 2, retried: true, at: new Date(0),
      nested: { secret: "x" }, list: [1], fn: () => undefined, nan: Number.NaN, missing: undefined, badDate: new Date("x"),
      message: "spoofed",
    })
    expect(attributes).toEqual({ message: "job failed", jobId: "j1", attempt: 2, retried: true, at: "1970-01-01T00:00:00.000Z" })
    expect(Object.isFrozen(attributes)).toBe(true)
  })

  it("truncates oversized strings on a code-point boundary and caps attribute count", () => {
    const long = "😀".repeat(MAX_TELEMETRY_LOG_STRING_BYTES)
    const attributes = boundedTelemetryAttributes(long, Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, index])))
    const message = attributes.message as string
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(MAX_TELEMETRY_LOG_STRING_BYTES)
    expect(message.endsWith("…[truncated]")).toBe(true)
    expect(message.includes("�")).toBe(false)
    expect(Object.keys(attributes)).toHaveLength(MAX_TELEMETRY_LOG_ATTRIBUTES)
  })

  it("uses the injected clock and never throws, even when the clock or sink fails", () => {
    const emit = vi.fn()
    const at = new Date("2026-01-01T00:00:00.000Z")
    createTelemetryLogger({ emit }, "test.event", () => at).warn("hello", { id: "1" })
    expect(emit).toHaveBeenCalledWith({ name: "test.event", severity: "warn", timestamp: at, attributes: { message: "hello", id: "1" } })
    expect(() => createTelemetryLogger({ emit() { throw new Error("down") } }, "x").error("boom")).not.toThrow()
    expect(() => createTelemetryLogger({ emit }, "x", () => { throw new Error("clock") }).info("boom")).not.toThrow()
    createTelemetryLogger({ emit }, "x", () => new Date("invalid")).debug("fallback")
    expect((emit.mock.calls.at(-1)![0] as { timestamp: Date }).timestamp.getTime()).not.toBeNaN()
    expect(() => createTelemetryLogger(undefined, "x").info("no sink")).not.toThrow()
  })
})
