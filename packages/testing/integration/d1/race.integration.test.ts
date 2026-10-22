import { describe, expect, it } from "vitest"
import { openD1Fixture, temporaryD1Fixture } from "./database.js"

/**
 * Two Miniflare instances share one SQLite file, so a write can find the file locked by the other instance's write and
 * fail with SQLITE_BUSY before SQLite's own busy handler gives up (more likely when the machine is loaded). A statement
 * that failed that way did not execute, so it is sent again, a bounded number of times and only for that signature. Any
 * other error propagates, and the outcome assertions below still demand exactly one winner.
 */
const MAX_BUSY_ATTEMPTS = 50
const isSqliteBusy = (error: unknown): boolean => /SQLITE_BUSY|database is locked/i.test(`${(error as Error | null)?.message ?? error} ${(error as { cause?: Error } | null)?.cause?.message ?? ""}`)
async function runWhenNotBusy<T>(statement: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await statement() } catch (error) {
      if (attempt >= MAX_BUSY_ATTEMPTS || !isSqliteBusy(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt))
    }
  }
}

describe("D1 database races", () => {
  it("permits exactly one finalizer claim and fences stale owners", async () => {
    const seed = await temporaryD1Fixture(); const path = seed.persistPath; await seed.close()
    const first = await openD1Fixture(path); const second = await openD1Fixture(path)
    const claims = await Promise.all([
      runWhenNotBusy<{ meta: { changes: number } }>(() => first.db.prepare("INSERT OR IGNORE INTO framework_finalizers VALUES(?,?,?,?)").bind("x", "one", 1, "claimed").run()),
      runWhenNotBusy<{ meta: { changes: number } }>(() => second.db.prepare("INSERT OR IGNORE INTO framework_finalizers VALUES(?,?,?,?)").bind("x", "two", 2, "claimed").run()),
    ])
    expect(claims.reduce((sum: number, result: { meta: { changes: number } }) => sum + result.meta.changes, 0)).toBe(1)
    const verifier = await openD1Fixture(path)
    const winner = await verifier.db.prepare("SELECT owner, fence FROM framework_finalizers WHERE finalizer_key='x'").first<{ owner: string; fence: number }>()
    expect(winner).not.toBeNull()
    const loser = winner?.owner === "one" ? { owner: "two", fence: 2 } : { owner: "one", fence: 1 }
    expect((await verifier.db.prepare("UPDATE framework_finalizers SET state='done' WHERE finalizer_key='x' AND owner=? AND fence=?").bind(loser.owner, loser.fence).run()).meta.changes).toBe(0)
    expect((await verifier.db.prepare("UPDATE framework_finalizers SET state='done' WHERE finalizer_key='x' AND owner=? AND fence=?").bind(winner?.owner ?? "", winner?.fence ?? -1).run()).meta.changes).toBe(1)
    await first.close(); await second.close(); await verifier.close(); await seed.cleanup()
  })
})
