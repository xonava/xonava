import { describe, expect, it } from "vitest"
import { createDrizzlePgLeaseStore } from "../../drizzle-pg/drizzleLeaseStore"
import { createDrizzleD1LeaseStore } from "../../drizzle-d1/drizzleLeaseStore"
import type { FencedLease, LeaseResourceKey } from "@xonava/core/events"
import type { AtomicLeaseBackend } from "../fencedLeaseStore"

class Backend implements AtomicLeaseBackend {
  now = new Date("2026-09-11T00:00:00.000Z"); lease: FencedLease | null = null; token = 0; queue = Promise.resolve()
  transition<T>(_key: LeaseResourceKey, change: (current: FencedLease | null, backendNow: Date, freshToken: () => string) => { lease: FencedLease | null; result: T }): Promise<T> { const task = this.queue.then(() => { const out = change(this.lease, new Date(this.now), () => `claim-${++this.token}`); this.lease = out.lease; return out.result }); this.queue = task.then(() => undefined, () => undefined); return task }
  read() { return Promise.resolve({ lease: this.lease, backendNow: new Date(this.now) }) }
}
const resource: LeaseResourceKey = { namespace: "settlement", resourceId: "day-1", scopeId: "scope" as never }

describe.each([["PG", createDrizzlePgLeaseStore], ["D1", createDrizzleD1LeaseStore]] as const)("%s L1 lease conformance", (_name, factory) => {
  it("acquires once, renews with backend time, releases and fences stale ownership", async () => {
    const backend = new Backend(); const store = factory(backend); const lease = await store.acquire(resource, "worker-a", 1000)
    expect(lease).toMatchObject({ fencingToken: 1, claimToken: "claim-1" }); expect(await store.acquire(resource, "worker-b", 1000)).toBeNull()
    backend.now = new Date("2026-09-11T00:00:00.500Z"); expect((await store.renew(lease!, 1000)).expiresAt).toBe("2026-09-11T00:00:01.500Z")
    await expect(store.release({ ...lease!, claimToken: "stale" })).rejects.toMatchObject({ code: "STALE_CLAIM" })
  })
  it("takes over expired leases with monotonic fencing and rejects old effects", async () => {
    const backend = new Backend(); const store = factory(backend); const first = await store.acquire(resource, "a", 100)
    backend.now = new Date("2026-09-11T00:00:00.100Z"); const second = await store.acquire(resource, "b", 100)
    expect(second).toMatchObject({ fencingToken: 2, claimToken: "claim-2" }); await expect(store.assertCurrent(first!)).rejects.toMatchObject({ code: "STALE_CLAIM" }); await store.release(second!); expect(backend.lease).toMatchObject({ fencingToken: 2, expiresAt: backend.now.toISOString() }); await expect(store.assertCurrent(second!)).rejects.toMatchObject({ code: "STALE_CLAIM" }); expect(await store.acquire(resource, "c", 100)).toMatchObject({ fencingToken: 3 })
  })
})
