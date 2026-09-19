import { describe, expect, it, vi } from "vitest"
import type { FinalizerPort, PendingInvalidation } from "core/events"
import { drainPendingInvalidations } from "../../server/idempotencyFinalizer"

const pending: PendingInvalidation = {
  scope: "tenant:one",
  key: "key-1",
  fingerprint: "f",
  token: "t",
  invalidations: ["module:tenant:one", "module"],
  result: { status: 200 },
}

function createPort(entries: PendingInvalidation[]) {
  const completeClaimedInvalidation = vi.fn(async () => undefined)
  const ackClaimedInvalidation = vi.fn(async () => undefined)
  const port = {
    acquire: vi.fn(), renew: vi.fn(), complete: vi.fn(),
    claimPendingInvalidations: vi.fn(async () => entries.map((entry) => ({ ...entry, claimToken: "claim", claimOwner: "worker" }))),
    ackClaimedInvalidation, completeClaimedInvalidation,
  } as unknown as FinalizerPort
  return { port, completeClaimedInvalidation, ackClaimedInvalidation }
}

describe("durable idempotency invalidation finalizer", () => {
  it("applies physical invalidation and completes the committed reservation", async () => {
    const { port, completeClaimedInvalidation } = createPort([pending])
    const invalidate = vi.fn(async () => undefined)

    const result = await drainPendingInvalidations({ port, invalidate, claimOwner: "worker", leaseMs: 1000 })

    expect(result.drained).toBe(1)
    expect(result.acked).toBe(0)
    expect(invalidate).toHaveBeenCalledWith(pending.invalidations)
    expect(completeClaimedInvalidation).toHaveBeenCalledWith(expect.objectContaining({ scope: pending.scope, key: pending.key, token: pending.token, result: pending.result, claimToken: "claim" }))
  })

  it("leaves the obligation durable when physical invalidation fails", async () => {
    const { port, completeClaimedInvalidation } = createPort([pending])
    const invalidate = vi.fn(async () => { throw new Error("cache unavailable") })

    const result = await drainPendingInvalidations({ port, invalidate, claimOwner: "worker", leaseMs: 1000 })

    expect(result.drained).toBe(0)
    expect(result.acked).toBe(0)
    expect(completeClaimedInvalidation).not.toHaveBeenCalled()
  })

  it("acks invalidations for receipt-only rows without a result", async () => {
    const receiptOnly: PendingInvalidation = {
      scope: "tenant:two",
      key: "key-2",
      fingerprint: "f2",
      token: "t2",
      invalidations: ["module:tenant:two"],
      result: null,
    }
    const { port, completeClaimedInvalidation, ackClaimedInvalidation } = createPort([receiptOnly])
    const invalidate = vi.fn(async () => undefined)

    const result = await drainPendingInvalidations({ port, invalidate, claimOwner: "worker", leaseMs: 1000 })

    expect(result.drained).toBe(0)
    expect(result.acked).toBe(1)
    expect(invalidate).toHaveBeenCalledWith(receiptOnly.invalidations)
    expect(ackClaimedInvalidation).toHaveBeenCalledWith({ scope: receiptOnly.scope, key: receiptOnly.key, fingerprint: receiptOnly.fingerprint, token: receiptOnly.token, claimToken: "claim" })
    expect(completeClaimedInvalidation).not.toHaveBeenCalled()
  })

  it("emits unified safe telemetry for attempts, failures and drain completion", async () => {
    const { port } = createPort([pending])
    const emit = vi.fn()
    await drainPendingInvalidations({ port, invalidate: async () => { throw new Error("contains-secret") }, claimOwner: "worker", leaseMs: 1000, telemetry: { emit } })
    expect(emit.mock.calls.map(([event]) => event.name)).toEqual(["idempotency.finalizer.attempt", "idempotency.finalizer.failure", "idempotency.finalizer.drained"])
    expect(JSON.stringify(emit.mock.calls)).not.toContain("contains-secret")
    expect(JSON.stringify(emit.mock.calls)).not.toContain(pending.key)
  })
})
