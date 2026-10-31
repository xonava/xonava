import { describe, expect, it } from "vitest"
import { D1AtomicLeaseBackend, createD1LeaseStore } from "@xonava/adapters/drizzle-d1"
import { temporaryD1Fixture } from "./database.js"

const scopeId = "tenant:t1" as never

const withFixture = async (run: (fixture: Awaited<ReturnType<typeof temporaryD1Fixture>>) => Promise<void>) => {
  const fixture = await temporaryD1Fixture()
  try { await run(fixture) } finally { await fixture.close(); await fixture.cleanup() }
}

describe("D1 fenced lease backend", () => {
  it("fences competing leases with database time and rejects released ownership", async () => {
    await withFixture(async fixture => {
      const leases = createD1LeaseStore(fixture.db as never, "framework_lease_records")
      const resource = { scopeId, namespace: "jobs", resourceId: "job-1" }
      const [first, second] = await Promise.all([leases.acquire(resource, "worker-a", 60_000), leases.acquire(resource, "worker-b", 60_000)])
      expect([first, second].filter(Boolean)).toHaveLength(1)
      const lease = (first ?? second)!
      expect(lease.fencingToken).toBe(1)
      await leases.assertCurrent(lease)
      const renewed = await leases.renew(lease, 120_000)
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt))
      await leases.release(lease)
      await expect(leases.assertCurrent(lease)).rejects.toMatchObject({ code: "STALE_CLAIM" })
      await expect(leases.release(lease)).rejects.toMatchObject({ code: "STALE_CLAIM" })
    })
  })

  it("lets exactly one of many racing acquirers win", async () => {
    await withFixture(async fixture => {
      const leases = createD1LeaseStore(fixture.db as never, "framework_lease_records")
      const resource = { scopeId, namespace: "jobs", resourceId: "race" }
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => leases.acquire(resource, `worker-${index}`, 60_000)))
      expect(results.filter(Boolean)).toHaveLength(1)
    })
  })

  it("takes over an expired lease with a higher fencing token and a fresh claim token", async () => {
    await withFixture(async fixture => {
      const leases = createD1LeaseStore(fixture.db as never, "framework_lease_records")
      const resource = { scopeId, namespace: "jobs", resourceId: "takeover" }
      const first = (await leases.acquire(resource, "first", 1))!
      await new Promise(resolve => setTimeout(resolve, 10))
      const second = (await leases.acquire(resource, "second", 60_000))!
      expect(second.fencingToken).toBe(first.fencingToken + 1)
      expect(second.claimToken).not.toBe(first.claimToken)
      await expect(leases.assertCurrent(first)).rejects.toMatchObject({ code: "STALE_CLAIM" })
      await expect(leases.renew(first, 1000)).rejects.toMatchObject({ code: "STALE_CLAIM" })
      await leases.assertCurrent(second)
    })
  })

  it("reads backend time from the database and rejects unsafe table names", async () => {
    await withFixture(async fixture => {
      const backend = new D1AtomicLeaseBackend(fixture.db as never, "framework_lease_records")
      const { lease, backendNow } = await backend.read({ scopeId, namespace: "jobs", resourceId: "never-created" })
      expect(lease).toBeNull()
      expect(Math.abs(backendNow.getTime() - Date.now())).toBeLessThan(60_000)
      expect(() => new D1AtomicLeaseBackend(fixture.db as never, "x; DROP TABLE y")).toThrow("Unsafe lease table name")
    })
  })

  it("runs against a renamed table", async () => {
    await withFixture(async fixture => {
      await fixture.db.exec("CREATE TABLE alt_leases (resource_key TEXT PRIMARY KEY, lease TEXT NULL, revision INTEGER NOT NULL DEFAULT 0)")
      const leases = createD1LeaseStore(fixture.db as never, { tables: { leases: "alt_leases" } })
      const lease = await leases.acquire({ scopeId, namespace: "jobs", resourceId: "alt" }, "worker", 60_000)
      await leases.assertCurrent(lease!)
      await leases.release(lease!)
      expect(await fixture.db.prepare("SELECT COUNT(*) AS n FROM alt_leases").first()).toEqual({ n: 1 })
    })
  })
})
