import { describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { ConfigurationError } from "@xonava/core/domain"
import { createFakeD1 } from "../../__tests__/support/fakeD1"
import { createDrizzleSession } from "../d1Session"

const jobs = sqliteTable("sj_jobs", { id: text("id").primaryKey(), status: text("status"), claimToken: text("claim_token") })
const history = sqliteTable("sj_history", { id: text("id").primaryKey(), jobId: text("job_id"), attempt: integer("attempt") })
const SCHEMA = [
  "CREATE TABLE sj_jobs (id TEXT PRIMARY KEY, status TEXT, claim_token TEXT)",
  "CREATE TABLE sj_history (id TEXT PRIMARY KEY, job_id TEXT, attempt INTEGER)",
]

function request(overrides: Record<string, unknown> = {}) {
  return {
    updateTable: jobs, updateSet: { status: "done", claimToken: "tok" }, updateWhere: undefined,
    historyTable: history, historyValues: { id: "h1", jobId: "j1", attempt: 2 }, historyWhere: undefined,
    ...overrides,
  } as never
}

describe("createDrizzleSession.atomicJobTransition", () => {
  it("rejects history values that do not match a history table column", async () => {
    const d1 = createFakeD1(SCHEMA)
    const session = createDrizzleSession(drizzle(d1 as never))
    await expect(session.atomicJobTransition!(request({ historyValues: { id: "h1", ghost: 1 } }))).rejects.toThrow(
      new ConfigurationError("Execution history value does not match a history table column"),
    )
  })

  it("requires the D1 binding on the database", async () => {
    const d1 = createFakeD1(SCHEMA)
    const base = drizzle(d1 as never)
    const expected = new ConfigurationError("D1 atomic job transitions require the D1 binding")
    const without = new Proxy(base, { get: (target, prop) => (prop === "$client" ? undefined : Reflect.get(target, prop)) })
    await expect(createDrizzleSession(without).atomicJobTransition!(request())).rejects.toThrow(expected)
    const noBatch = new Proxy(base, { get: (target, prop) => (prop === "$client" ? { prepare: () => ({ bind: () => ({}) }) } : Reflect.get(target, prop)) })
    await expect(createDrizzleSession(noBatch).atomicJobTransition!(request())).rejects.toThrow(expected)
  })

  const withBatch = (results: unknown[]) => {
    const batches: unknown[][] = []
    const client = {
      prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ sql, params }) }),
      batch: async (statements: unknown[]) => { batches.push(statements); return results },
    }
    const db = new Proxy(drizzle(createFakeD1(SCHEMA) as never), { get: (target, prop) => (prop === "$client" ? client : Reflect.get(target, prop)) })
    return { session: createDrizzleSession(db), batches }
  }

  it("runs the update, the history insert and the token clearing as one batch and reports whether the update applied", async () => {
    const { session, batches } = withBatch([{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }])
    const result = await session.atomicJobTransition!(request())
    expect(result).toEqual({ applied: true, historyId: "h1" })
    const statements = batches[0] as { sql: string; params: unknown[] }[]
    expect(statements).toHaveLength(3)
    expect(statements[0]!.sql).toBe('update "sj_jobs" set "status" = ?, "claim_token" = ?')
    expect(statements[0]!.params).toEqual(["done", "tok"])
    expect(statements[1]!.sql).toBe('insert into "sj_history" ("id", "job_id", "attempt") select ?, ?, ? from "sj_jobs" where 0')
    expect(statements[1]!.params).toEqual(["h1", "j1", 2])
    expect(statements[2]!.sql).toBe('update "sj_jobs" set "claim_token" = ?')
    expect(statements[2]!.params).toEqual([null])
  })

  it("reports an update that changed nothing, including a result without metadata, as not applied", async () => {
    for (const first of [{ meta: { changes: 0 } }, { meta: {} }, {}]) {
      const { session } = withBatch([first, {}, {}])
      expect(await session.atomicJobTransition!(request())).toEqual({ applied: false, historyId: "h1" })
    }
    const { session } = withBatch([{ meta: { changes: 3 } }, {}, {}])
    expect((await session.atomicJobTransition!(request())).applied).toBe(true)
  })
})

describe("createDrizzleSession.select", () => {
  it("selects all columns without arguments and a projection with one", async () => {
    const d1 = createFakeD1(SCHEMA)
    d1.sqlite.exec("INSERT INTO sj_jobs (id, status, claim_token) VALUES ('a', 's', 't')")
    const session = createDrizzleSession(drizzle(d1 as never))
    expect(await session.select().from(jobs).where(undefined).limit(1)).toEqual([{ id: "a", status: "s", claimToken: "t" }])
    expect(await session.select({ only: jobs.status }).from(jobs).where(undefined).limit(1)).toEqual([{ only: "s" }])
  })
})
