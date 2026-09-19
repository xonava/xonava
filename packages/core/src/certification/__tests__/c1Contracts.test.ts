import { describe, expect, it } from "vitest"
import { compileCacheInvalidationStrategy } from "../../cache"
import { createIdempotencyNamespace } from "../../events/durability/idempotency"
describe("C1 cache and idempotency strategies", () => {
  it("rejects best-effort for correctness-critical cache entries", () => { expect(() => compileCacheInvalidationStrategy({ requested: "best-effort", correctnessCritical: true, atomicAvailable: true, durableEventualAvailable: true })).toThrow(/Correctness-critical/) })
  it("never silently downgrades a requested guarantee", () => { expect(() => compileCacheInvalidationStrategy({ requested: "atomic-generation", correctnessCritical: true, atomicAvailable: false, durableEventualAvailable: true })).toThrow(/Atomic/); expect(() => compileCacheInvalidationStrategy({ requested: "durable-eventual-generation", correctnessCritical: true, atomicAvailable: false, durableEventualAvailable: false })).toThrow(/finalizer/) })
  it("derives namespace from canonical execution scope and validates retention", () => { const namespace = createIdempotencyNamespace({ kind: "tenant", tenantId: "tenant-a" }, "record.update", { completedTtlMs: 86_400_000, abandonedTtlMs: 60_000 }); expect(namespace.value).toBe(`${namespace.scopeId}:record.update`); expect(namespace.operationKey).toBe("record.update"); expect(() => createIdempotencyNamespace({ kind: "platform", platformKey: "main" }, "x", { completedTtlMs: 0, abandonedTtlMs: 1 })).toThrow(/positive/) })
})
