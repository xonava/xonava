import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core"
import type { SQL } from "drizzle-orm/sql/sql"
import { d1CurrentEpochMilliseconds, d1EpochMillisecondsAfter } from "../d1Utils"

const dialect = new SQLiteSyncDialect()

function expression(sqlExpression: SQL<unknown>): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(sqlExpression)
}

function value(db: DatabaseSync, sqlExpression: SQL<unknown>): number {
  const query = expression(sqlExpression)
  return (db.prepare(`SELECT ${query.sql} AS value`).get(...query.params as never[]) as { value: number }).value
}

describe("D1 epoch timestamp expressions", () => {
  it("executes numeric job claim and renewal timestamps against INTEGER columns", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, lease_expires_at INTEGER, status TEXT)")
    db.exec("INSERT INTO jobs VALUES ('job-1', NULL, 'pending')")

    const claim = expression(d1EpochMillisecondsAfter(1_500))
    db.prepare(`UPDATE jobs SET lease_expires_at = ${claim.sql}, status = 'running' WHERE id = 'job-1'`).run(...claim.params as never[])
    expect(db.prepare("SELECT typeof(lease_expires_at) AS type FROM jobs").get()).toEqual({ type: "integer" })
    expect((db.prepare("SELECT lease_expires_at > ? AS valid FROM jobs").get(value(db, d1CurrentEpochMilliseconds())) as { valid: number }).valid).toBe(1)

    const renewal = expression(d1EpochMillisecondsAfter(2_500))
    db.prepare(`UPDATE jobs SET lease_expires_at = ${renewal.sql} WHERE id = 'job-1' AND lease_expires_at > ${expression(d1CurrentEpochMilliseconds()).sql}`)
      .run(...renewal.params as never[])
    expect((db.prepare("SELECT lease_expires_at > ? AS valid FROM jobs").get(value(db, d1CurrentEpochMilliseconds())) as { valid: number }).valid).toBe(1)
  })

  it("executes numeric schedule claim and renewal timestamps against INTEGER columns", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY, lease_expires_at INTEGER, last_status TEXT)")
    db.exec("INSERT INTO schedules VALUES ('schedule-1', NULL, NULL)")

    const claim = expression(d1EpochMillisecondsAfter(1_000))
    db.prepare(`UPDATE schedules SET lease_expires_at = ${claim.sql}, last_status = 'running' WHERE id = 'schedule-1'`).run(...claim.params as never[])
    expect(db.prepare("SELECT typeof(lease_expires_at) AS type FROM schedules").get()).toEqual({ type: "integer" })
    expect((db.prepare("SELECT lease_expires_at > ? AS valid FROM schedules").get(value(db, d1CurrentEpochMilliseconds())) as { valid: number }).valid).toBe(1)

    const renewal = expression(d1EpochMillisecondsAfter(3_000))
    db.prepare(`UPDATE schedules SET lease_expires_at = ${renewal.sql} WHERE id = 'schedule-1' AND lease_expires_at > ${expression(d1CurrentEpochMilliseconds()).sql}`)
      .run(...renewal.params as never[])
    expect((db.prepare("SELECT lease_expires_at > ? AS valid FROM schedules").get(value(db, d1CurrentEpochMilliseconds())) as { valid: number }).valid).toBe(1)
  })

  it("executes numeric idempotency lease timestamps and expiry comparisons", () => {
    const db = new DatabaseSync(":memory:")
    db.exec("CREATE TABLE idempotency_records (scope TEXT, key TEXT, created_at INTEGER, completed_at INTEGER)")
    const created = expression(d1CurrentEpochMilliseconds())
    db.prepare(`INSERT INTO idempotency_records VALUES ('tenant:one', 'key-1', ${created.sql}, NULL)`).run(...created.params as never[])
    expect(db.prepare("SELECT typeof(created_at) AS type FROM idempotency_records").get()).toEqual({ type: "integer" })

    const expired = expression(d1EpochMillisecondsAfter(-30_000))
    expect((db.prepare(`SELECT created_at < ${expired.sql} AS expired FROM idempotency_records`).get(...expired.params as never[]) as { expired: number }).expired).toBe(0)
    const completed = expression(d1CurrentEpochMilliseconds())
    db.prepare(`UPDATE idempotency_records SET completed_at = ${completed.sql} WHERE scope = 'tenant:one' AND key = 'key-1'`).run(...completed.params as never[])
    expect(db.prepare("SELECT typeof(completed_at) AS type FROM idempotency_records").get()).toEqual({ type: "integer" })
  })
})
