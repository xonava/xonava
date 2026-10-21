import { describe, expect, it } from "vitest"
import type { Pool } from "mysql2/promise"
import { createMySqlLeaseStore } from "../mysqlAtomicBackends"

const resource = { scopeId: "scope" as never, namespace: "jobs", resourceId: "r1" }

/** A pool whose first `failures` UPDATEs are aborted by InnoDB the way concurrent INSERT IGNORE / SELECT FOR UPDATE pairs are. */
function pool(failures: number, code = "ER_LOCK_DEADLOCK") {
  const log = { begins: 0, commits: 0, rollbacks: 0, released: 0, open: 0 }
  let remaining = failures
  let stored: unknown = null
  const connection = {
    beginTransaction: async () => { log.begins++ },
    commit: async () => { log.commits++ },
    rollback: async () => { log.rollbacks++ },
    release: () => { log.released++ },
    query: async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("INSERT IGNORE")) return [{}, undefined]
      if (sql.startsWith("SELECT lease")) return [[{ lease: stored }], undefined]
      if (sql.startsWith("SELECT CURRENT_TIMESTAMP")) return [[{ now: new Date("2030-06-01T00:00:00.000Z") }], undefined]
      if (sql.startsWith("UPDATE")) {
        if (remaining-- > 0) throw Object.assign(new Error("Deadlock found when trying to get lock"), { code, errno: ({ ER_LOCK_DEADLOCK: 1213, ER_LOCK_WAIT_TIMEOUT: 1205, ER_DUP_ENTRY: 1062 } as Record<string, number>)[code] })
        stored = params![0]
        return [{}, undefined]
      }
      throw new Error(`unexpected statement ${sql}`)
    },
  }
  return { pool: { getConnection: async () => connection } as unknown as Pool, log }
}

describe("MySQL lease backend transaction retry", () => {
  it.each(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"])("retries a transition aborted with %s and grants the lease once", async (code) => {
    const { pool: fake, log } = pool(2, code)
    const lease = await createMySqlLeaseStore(fake).acquire(resource, "w1", 60_000)
    expect(lease).toMatchObject({ owner: "w1", fencingToken: 1 })
    expect(log).toMatchObject({ begins: 3, commits: 1, rollbacks: 2, released: 3 })
  })

  it("does not retry errors that are not lock aborts", async () => {
    const { pool: fake, log } = pool(1, "ER_DUP_ENTRY")
    await expect(createMySqlLeaseStore(fake).acquire(resource, "w1", 60_000)).rejects.toMatchObject({ code: "ER_DUP_ENTRY" })
    expect(log).toMatchObject({ begins: 1, commits: 0, rollbacks: 1, released: 1 })
  })
})
