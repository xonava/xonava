import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClaimedPendingInvalidation, FinalizerPort } from "@xonava/core/events"
import type { TelemetryEvent } from "@xonava/core/telemetry"
import { createIdempotencyFinalizerService, drainPendingInvalidations } from "../idempotencyFinalizer"

function claimed(key: string, result: unknown): ClaimedPendingInvalidation {
  return { scope: "tenant:one", key, fingerprint: `f-${key}`, token: `t-${key}`, invalidations: [`tag-${key}`, "all"], result, claimToken: `c-${key}`, claimOwner: "worker" } as unknown as ClaimedPendingInvalidation
}

function createPort(entries: ClaimedPendingInvalidation[]) {
  const claimPendingInvalidations = vi.fn(async () => entries)
  const completeClaimedInvalidation = vi.fn(async (_entry: unknown) => undefined)
  const ackClaimedInvalidation = vi.fn(async (_entry: unknown) => undefined)
  const port = { claimPendingInvalidations, completeClaimedInvalidation, ackClaimedInvalidation } as unknown as FinalizerPort
  return { port, claimPendingInvalidations, completeClaimedInvalidation, ackClaimedInvalidation }
}

describe("drainPendingInvalidations", () => {
  it("claims with the exact limit, owner and lease and caps the limit at 100", async () => {
    const { port, claimPendingInvalidations } = createPort([])
    const invalidate = vi.fn(async () => undefined)
    await drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 5, limit: 7 })
    await drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 5, limit: 500 })
    await drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 5 })
    await drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 5, limit: 100 })
    await drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 5, limit: 99 })
    expect(claimPendingInvalidations.mock.calls).toEqual([
      [{ limit: 7, claimOwner: "w", leaseMs: 5 }],
      [{ limit: 100, claimOwner: "w", leaseMs: 5 }],
      [{ limit: 100, claimOwner: "w", leaseMs: 5 }],
      [{ limit: 100, claimOwner: "w", leaseMs: 5 }],
      [{ limit: 99, claimOwner: "w", leaseMs: 5 }],
    ])
  })

  it("rejects a missing owner, non-finite lease or non-positive lease before claiming", async () => {
    const { port, claimPendingInvalidations } = createPort([])
    const invalidate = vi.fn(async () => undefined)
    const message = "Finalizer claimOwner and positive leaseMs are required"
    await expect(drainPendingInvalidations({ port, invalidate, claimOwner: "", leaseMs: 1000 })).rejects.toThrow(message)
    await expect(drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: Number.NaN })).rejects.toThrow(message)
    await expect(drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: Number.POSITIVE_INFINITY })).rejects.toThrow(message)
    await expect(drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 0 })).rejects.toThrow(message)
    await expect(drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: -1 })).rejects.toThrow(message)
    await expect(drainPendingInvalidations({ port, invalidate, claimOwner: "", leaseMs: Number.NaN })).rejects.toThrow(message)
    expect(claimPendingInvalidations).not.toHaveBeenCalled()
    await expect(drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 1 })).resolves.toEqual({ drained: 0, acked: 0 })
  })

  it("completes and acks with the exact port payloads, treating undefined results as receipt-only", async () => {
    const withResult = claimed("a", { status: 201 })
    const undefinedResult = claimed("b", undefined)
    const falsyResult = claimed("c", 0)
    const { port, completeClaimedInvalidation, ackClaimedInvalidation } = createPort([withResult, undefinedResult, falsyResult])
    const invalidate = vi.fn(async () => undefined)
    const out = await drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 5 })
    expect(out).toEqual({ drained: 2, acked: 1 })
    expect(completeClaimedInvalidation.mock.calls).toEqual([
      [{ scope: "tenant:one", key: "a", fingerprint: "f-a", token: "t-a", claimToken: "c-a", result: { status: 201 }, invalidations: ["tag-a", "all"] }],
      [{ scope: "tenant:one", key: "c", fingerprint: "f-c", token: "t-c", claimToken: "c-c", result: 0, invalidations: ["tag-c", "all"] }],
    ])
    expect(ackClaimedInvalidation.mock.calls).toEqual([
      [{ scope: "tenant:one", key: "b", fingerprint: "f-b", token: "t-b", claimToken: "c-b" }],
    ])
    expect(invalidate.mock.calls).toEqual([[["tag-a", "all"]], [["tag-b", "all"]], [["tag-c", "all"]]])
  })

  it("continues with later entries after a failure and does not ack or complete the failed one", async () => {
    const { port, completeClaimedInvalidation } = createPort([claimed("a", { ok: 1 }), claimed("b", { ok: 2 })])
    const invalidate = vi.fn(async (tags: string[]) => { if (tags[0] === "tag-a") throw new Error("boom") })
    const out = await drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 5 })
    expect(out).toEqual({ drained: 1, acked: 0 })
    expect(completeClaimedInvalidation).toHaveBeenCalledTimes(1)
    expect(completeClaimedInvalidation.mock.calls[0]?.[0]).toMatchObject({ key: "b" })
  })

  it("emits exact telemetry events with severity, timestamp and attributes", async () => {
    const { port } = createPort([claimed("a", { ok: 1 }), claimed("b", { ok: 2 }), claimed("c", null)])
    const events: TelemetryEvent[] = []
    const telemetry = { emit: (event: TelemetryEvent) => { events.push(event) } }
    const invalidate = vi.fn(async (tags: string[]) => { if (tags[0] === "tag-b") throw new RangeError("secret-detail") })
    await drainPendingInvalidations({ port, invalidate, claimOwner: "w", leaseMs: 5, telemetry })
    expect(events.map((e) => [e.name, e.severity, { ...e.attributes }])).toEqual([
      ["idempotency.finalizer.attempt", "info", { invalidations: 2 }],
      ["idempotency.finalizer.attempt", "info", { invalidations: 2 }],
      ["idempotency.finalizer.failure", "error", { errorType: "RangeError" }],
      ["idempotency.finalizer.attempt", "info", { invalidations: 2 }],
      ["idempotency.finalizer.drained", "info", { drained: 1, acked: 1 }],
    ])
    for (const event of events) expect(event.timestamp).toBeInstanceOf(Date)
  })

  it("reports a non-Error failure as errorType unknown", async () => {
    const { port } = createPort([claimed("a", { ok: 1 })])
    const events: TelemetryEvent[] = []
    await drainPendingInvalidations({ port, invalidate: async () => { throw "plain string" }, claimOwner: "w", leaseMs: 5, telemetry: { emit: (event) => { events.push(event) } } })
    const failure = events.find((e) => e.name === "idempotency.finalizer.failure")
    expect({ ...failure?.attributes }).toEqual({ errorType: "unknown" })
  })

  it("does not fail when no telemetry port is supplied", async () => {
    const { port } = createPort([claimed("a", { ok: 1 })])
    await expect(drainPendingInvalidations({ port, invalidate: async () => { throw new Error("x") }, claimOwner: "w", leaseMs: 5 })).resolves.toEqual({ drained: 0, acked: 0 })
  })
})

describe("createIdempotencyFinalizerService", () => {
  afterEach(() => { vi.useRealTimers() })

  it("drains on every interval tick, starts only once and stops cleanly", async () => {
    vi.useFakeTimers()
    const drain = vi.fn(async () => ({ drained: 0, acked: 0 }))
    const service = createIdempotencyFinalizerService({ drain, intervalMs: 100 })
    service.start()
    service.start()
    expect(vi.getTimerCount()).toBe(1)
    expect(drain).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(99)
    expect(drain).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(drain).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(drain).toHaveBeenCalledTimes(2)
    service.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(drain).toHaveBeenCalledTimes(2)
    service.stop()
    service.start()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(drain).toHaveBeenCalledTimes(3)
    service.stop()
  })

  it("skips ticks while a drain is in flight and resumes afterwards", async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const drain = vi.fn(() => new Promise<{ drained: number; acked: number }>((resolve) => { release = () => resolve({ drained: 0, acked: 0 }) }))
    const service = createIdempotencyFinalizerService({ drain, intervalMs: 10 })
    service.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(drain).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(drain).toHaveBeenCalledTimes(2)
    service.stop()
  })

  it("emits service failure telemetry for Error and non-Error rejections and keeps ticking", async () => {
    vi.useFakeTimers()
    const events: TelemetryEvent[] = []
    const failures: unknown[] = [new TypeError("bad"), "text"]
    const drain = vi.fn(async (): Promise<{ drained: number; acked: number }> => { throw failures.shift() })
    const service = createIdempotencyFinalizerService({ drain, intervalMs: 10, telemetry: { emit: (event) => { events.push(event) } } })
    service.start()
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    service.stop()
    expect(events.map((e) => [e.name, e.severity, { ...e.attributes }])).toEqual([
      ["idempotency.finalizer.service.failure", "error", { errorType: "TypeError" }],
      ["idempotency.finalizer.service.failure", "error", { errorType: "unknown" }],
    ])
    expect(events[0]?.timestamp).toBeInstanceOf(Date)
  })

  it("swallows a drain rejection when no telemetry is configured", async () => {
    vi.useFakeTimers()
    const drain = vi.fn(async (): Promise<{ drained: number; acked: number }> => { throw new Error("x") })
    const service = createIdempotencyFinalizerService({ drain, intervalMs: 10 })
    service.start()
    await vi.advanceTimersByTimeAsync(10)
    service.stop()
    expect(drain).toHaveBeenCalledTimes(1)
  })
})
