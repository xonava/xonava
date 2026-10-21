import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PgAtomicLeaseBackend, createPgLeaseStore } from "@xonava/adapters/drizzle-pg"
import { openPgFixture, pgCertificationUrl } from "./database.js"

const scopeId = "tenant:t1" as never

describe("PostgreSQL fenced lease backend", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl() })
  beforeAll(async () => { const fixture = await openPgFixture(); await fixture.end() })
  afterAll(() => pool.end())

  it("fences competing leases with database time and rejects released ownership", async () => {
    const leases = createPgLeaseStore(pool, "framework_test.lease_records")
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

  it("takes over an expired lease with a higher fencing token and a fresh claim token", async () => {
    const leases = createPgLeaseStore(pool, "framework_test.lease_records")
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

  it("reads backend time from the database and rejects unsafe table names", async () => {
    const backend = new PgAtomicLeaseBackend(pool, "framework_test.lease_records")
    const { lease, backendNow } = await backend.read({ scopeId, namespace: "jobs", resourceId: "never-created" })
    expect(lease).toBeNull()
    expect(Math.abs(backendNow.getTime() - Date.now())).toBeLessThan(60_000)
    expect(() => new PgAtomicLeaseBackend(pool, "x; DROP TABLE y")).toThrow("Unsafe lease table name")
    expect(() => createPgLeaseStore(pool, { tables: { leases: "bad-name" } })).toThrow("Unsafe lease table name")
    expect(() => createPgLeaseStore(pool, { schema: "bad schema" })).toThrow("Unsafe PostgreSQL schema name")
  })

  it("runs against a renamed table in another schema", async () => {
    const schema = "framework_test_alt_lease"
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await pool.query(`DROP TABLE IF EXISTS ${schema}.alt_leases`)
    await pool.query(`CREATE TABLE ${schema}.alt_leases (resource_key text PRIMARY KEY, lease jsonb NULL, revision bigint NOT NULL DEFAULT 0)`)
    try {
      const leases = createPgLeaseStore(pool, { schema, tables: { leases: "alt_leases" } })
      const lease = await leases.acquire({ scopeId, namespace: "jobs", resourceId: "alt" }, "worker", 60_000)
      await leases.assertCurrent(lease!)
      await leases.release(lease!)
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.alt_leases`)).rows[0].n).toBe(1)
    } finally { await pool.query(`DROP SCHEMA ${schema} CASCADE`) }
  })
})
