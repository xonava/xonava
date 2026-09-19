import { describe, expect, it } from "vitest"
import type { AtomicBatchPlan, AtomicBatchProvider, VersionedEntityDescriptor, PersistenceProvider } from "core/persistence"
import type { AuditRecord, AuditSink, IdempotencyPort, OutboxRecord, OutboxSink } from "core/events"

export interface IdempotencyTransitionContractOptions<TResult = unknown> {
  createStore: () => IdempotencyPort<TResult>
  request?: { scope: string; key: string; fingerprint: string }
  waitForLeaseMs?: number
}

export function runIdempotencyTransitionContractTests<TResult = unknown>(
  label: string,
  options: IdempotencyTransitionContractOptions<TResult>,
): void {
  describe.sequential(`Idempotency transition contract: ${label}`, () => {
    it("transitions acquisition to replay and rejects a fingerprint conflict", async () => {
      const store = options.createStore()
      const request = options.request ?? { scope: "contract", key: "transition", fingerprint: "one" }
      const acquired = await store.acquire(request)
      expect(acquired.outcome).toBe("acquired")
      if (acquired.outcome !== "acquired") throw new Error("expected an idempotency reservation")

      await store.complete({ ...request, token: acquired.token, result: { committed: true } as TResult })
      await expect(store.acquire(request)).resolves.toEqual({ outcome: "replay", result: { committed: true } })
      await expect(store.acquire({ ...request, fingerprint: "two" })).resolves.toEqual({ outcome: "conflict" })
    })

    it("takes over an expired reservation and fences the stale token", async () => {
      const store = options.createStore()
      const request = options.request ?? { scope: "contract", key: "expired", fingerprint: "one" }
      const first = await store.acquire({ ...request, leaseDurationMs: options.waitForLeaseMs ?? 1 })
      expect(first.outcome).toBe("acquired")
      if (first.outcome !== "acquired") throw new Error("expected an idempotency reservation")
      await new Promise((resolve) => setTimeout(resolve, (options.waitForLeaseMs ?? 1) + 10))

      const second = await store.acquire({ ...request, leaseDurationMs: options.waitForLeaseMs ?? 1 })
      expect(second.outcome).toBe("acquired")
      if (second.outcome !== "acquired") throw new Error("expected expired reservation takeover")
      await expect(store.renew({ ...request, token: first.token })).rejects.toThrow()
      await expect(store.complete({ ...request, token: first.token, result: {} as TResult })).rejects.toThrow()
      await store.complete({ ...request, token: second.token, result: { owner: "second" } as TResult })
    })
  })
}

export interface OutboxReplayContractOptions {
  createSink: () => OutboxSink
  record: OutboxRecord
  conflictingRecord: OutboxRecord
}

export function runOutboxReplayContractTests(label: string, options: OutboxReplayContractOptions): void {
  describe.sequential(`Outbox replay contract: ${label}`, () => {
    it("is idempotent for identical records and rejects conflicting replays", async () => {
      const sink = options.createSink()
      await sink.append(options.record)
      await expect(sink.append({ ...options.record, payload: { ...options.record.payload } })).resolves.toBeUndefined()
      await expect(sink.append(options.conflictingRecord)).rejects.toThrow()
    })
  })
}

export interface AuditGuaranteeContractOptions {
  createSink: () => AuditSink
  record: AuditRecord
  readById: (id: string) => Promise<AuditRecord | null>
}

export function runAuditGuaranteeContractTests(label: string, options: AuditGuaranteeContractOptions): void {
  describe.sequential(`Audit guarantee contract: ${label}`, () => {
    it("persists the complete audit record and does not silently lose a write", async () => {
      await options.createSink().write(options.record)
      await expect(options.readById(options.record.id)).resolves.toMatchObject({
        id: options.record.id,
        action: options.record.action,
        resourceId: options.record.resourceId,
        tenantId: options.record.tenantId,
      })
    })
  })
}

export interface CacheGenerationItemContractOptions<TCommand> {
  createProvider: () => AtomicBatchProvider<TCommand>
  createPlan: () => AtomicBatchPlan<TCommand>
  readGeneration: (tag: string) => Promise<number | string | null>
}

export function runCacheGenerationItemContractTests<TCommand>(label: string, options: CacheGenerationItemContractOptions<TCommand>): void {
  describe.sequential(`Cache-generation item contract: ${label}`, () => {
    it("commits the generation item through the adapter's atomic path", async () => {
      const plan = options.createPlan()
      const item = plan.items.find((candidate) => candidate.kind === "cache-generation")
      expect(item?.kind).toBe("cache-generation")
      if (!item || item.kind !== "cache-generation") throw new Error("plan must contain a cache-generation item")
      await options.createProvider().executeAtomicBatch(plan)
      expect(await options.readGeneration(item.tag)).not.toBeNull()
    })
  })
}

export interface AtomicRollbackContractOptions<TCommand> {
  createProvider: () => AtomicBatchProvider<TCommand>
  createPlan: () => AtomicBatchPlan<TCommand>
  assertRolledBack: () => void | Promise<void>
}

export function runAtomicRollbackContractTests<TCommand>(label: string, options: AtomicRollbackContractOptions<TCommand>): void {
  describe.sequential(`Atomic rollback contract: ${label}`, () => {
    it("rolls back every item when a later item fails", async () => {
      await expect(options.createProvider().executeAtomicBatch(options.createPlan())).rejects.toThrow()
      await options.assertRolledBack()
    })
  })
}

export interface TenantOccContractOptions<T> {
  entity: VersionedEntityDescriptor<T>
  createProvider: () => PersistenceProvider
  createSecondProvider: () => PersistenceProvider
  createTenantProvider: (provider: PersistenceProvider, tenantId: string) => PersistenceProvider
  createRow: (tenantId: string) => Partial<T>
  getId: (row: T) => string
  getVersion: (row: T) => number
}

export function runTenantOccContractTests<T>(label: string, options: TenantOccContractOptions<T>): void {
  describe.sequential(`Tenant/OCC contract: ${label}`, () => {
    it("fences cross-tenant reads and one stale writer across real provider instances", async () => {
      const providerA = options.createProvider()
      const providerB = options.createSecondProvider()
      const unscoped = providerA.repository(options.entity)
      const tenantA = options.createTenantProvider(providerA, "tenant-a").repository(options.entity)
      const tenantB = options.createTenantProvider(providerB, "tenant-b").repository(options.entity)
      const row = await unscoped.insert(options.createRow("tenant-a"))
      const id = options.getId(row)
      expect(await tenantB.findById(id)).toBeNull()
      const expectedVersion = options.getVersion(row)
      const results = await Promise.allSettled([
        tenantA.update(id, {}, { optimisticConcurrency: { expectedVersion } }),
        providerB.repository(options.entity).update(id, {}, { optimisticConcurrency: { expectedVersion } }),
      ])
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
      expect(options.getVersion(await unscoped.findById(id) as T)).toBe(expectedVersion + 1)
    })
  })
}
