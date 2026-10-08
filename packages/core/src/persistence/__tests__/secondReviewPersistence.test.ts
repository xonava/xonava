import { describe, expect, it, vi } from "vitest"
import { TenantScopeViolationError } from "../../domain/errors"
import { supportsTenantScopedAtomicBatch, type AtomicBatchProvider, type PersistenceProvider } from "../provider"
import { createTenantScopedPersistenceProvider, encodeTenantCacheTag } from "../scoped"
import { enforceBoundedStream } from "../streaming"

function atomicBase() {
  const executeAtomicBatch = vi.fn(async () => [])
  const base = {
    dialect: "d1",
    capabilities: { interactiveTransactions: false, atomicBatch: true, returningInsert: false, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false },
    repository: () => { throw new Error("unused") },
    createTenantScopedCommandEncoder: (tenantId: string) => ({ tenantId, encode: (command: string) => command }),
    executeAtomicBatch,
  } as unknown as PersistenceProvider & AtomicBatchProvider
  const scoped = createTenantScopedPersistenceProvider(base, "tenant-a")
  if (!supportsTenantScopedAtomicBatch(scoped)) throw new Error("expected tenant atomic batch provider")
  return { scoped, executeAtomicBatch }
}

describe("tenant atomic batch cache-generation isolation (C12)", () => {
  it("encodes tenant cache tags in the length-prefixed tenant namespace", () => {
    expect(encodeTenantCacheTag("tenant-a", "rows")).toBe("tenant:8:tenant-a:rows")
    expect(encodeTenantCacheTag("a:b", "rows")).toBe("tenant:3:a:b:rows")
  })

  it("forwards cache-generation items for the tenant's own tags unchanged", async () => {
    const { scoped, executeAtomicBatch } = atomicBase()
    const tag = encodeTenantCacheTag("tenant-a", "rows")
    await scoped.executeAtomicBatch({ items: [{ kind: "cache-generation", tag }] })
    expect(executeAtomicBatch).toHaveBeenCalledWith({ items: [{ kind: "cache-generation", tag }] })
  })

  it("rejects global and foreign-tenant cache-generation tags without executing the batch", async () => {
    const { scoped, executeAtomicBatch } = atomicBase()
    for (const tag of ["rows", encodeTenantCacheTag("tenant-b", "rows"), "tenant:8:tenant-ab:rows", "tenant:6:tenant-a:rows", encodeTenantCacheTag("tenant-a", "rows").replace("tenant-a", "tenant-b")]) {
      await expect(scoped.executeAtomicBatch({ items: [{ kind: "cache-generation", tag }] })).rejects.toThrow(TenantScopeViolationError)
    }
    expect(executeAtomicBatch).not.toHaveBeenCalled()
  })
})

describe("bounded stream completion", () => {
  it("does not fail a stream that delivered everything when the deadline passes after completion", async () => {
    let nowMs = 0
    const deadline = new Date(100)
    async function* source() {
      yield { batchNumber: 0, items: [1, 2] }
      nowMs = 150 // the source finishes just past the deadline
    }
    const output: number[] = []
    for await (const batch of enforceBoundedStream(source(), { batchSize: 2, maxItems: 2, signal: new AbortController().signal, deadline }, () => new Date(nowMs))) output.push(...batch.items)
    expect(output).toEqual([1, 2])
  })

  it("still enforces the deadline between batches", async () => {
    let nowMs = 0
    async function* source() {
      yield { batchNumber: 0, items: [1] }
      nowMs = 150
      yield { batchNumber: 1, items: [2] }
    }
    const consume = async () => {
      for await (const _ of enforceBoundedStream(source(), { batchSize: 1, maxItems: 2, signal: new AbortController().signal, deadline: new Date(100) }, () => new Date(nowMs))) { /* consume */ }
    }
    await expect(consume()).rejects.toThrow("deadline")
  })
})

describe("stream cancellation and deadline errors", () => {
  it("raises framework CancelledError and TimeoutError", async () => {
    const { assertStreamingReadOptions } = await import("../streaming")
    const { CancelledError, TimeoutError } = await import("../../domain/errors")
    const controller = new AbortController()
    controller.abort(new Error("client gone"))
    expect(() => assertStreamingReadOptions({ batchSize: 1, signal: controller.signal, deadline: new Date(Date.now() + 1000) })).toThrow(CancelledError)
    expect(() => assertStreamingReadOptions({ batchSize: 1, signal: new AbortController().signal, deadline: new Date(0) })).toThrow(TimeoutError)
  })
})

describe("tenant-scoped idempotency abandon", () => {
  it("forwards abandon for the tenant's own scope and rejects foreign scopes", async () => {
    const { createTenantScopedIdempotencyPort, encodeTenantIdempotencyScope } = await import("../scoped")
    const abandon = vi.fn(async () => undefined)
    const base = { acquire: vi.fn(), renew: vi.fn(), complete: vi.fn(), abandon }
    const scoped = createTenantScopedIdempotencyPort(base as never, "t1") as { abandon?: (lease: unknown) => Promise<void> }
    const own = { scope: `${encodeTenantIdempotencyScope("t1")}:create`, key: "k", fingerprint: "f", token: "tok" }
    await scoped.abandon!(own)
    expect(abandon).toHaveBeenCalledWith(own)
    await expect(scoped.abandon!({ ...own, scope: `${encodeTenantIdempotencyScope("t2")}:create` })).rejects.toThrow(TenantScopeViolationError)
  })
})
