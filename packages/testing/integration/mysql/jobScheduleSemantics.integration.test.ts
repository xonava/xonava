import { describe, it } from "vitest"
import type { RowDataPacket } from "mysql2/promise"
import { DrizzleMySqlJobStore, DrizzleMySqlScheduleStore } from "adapters/drizzle-mysql"
import { openMySqlFixture } from "./database.js"
import { assertDefinitionMaxAttempts, assertScheduleOccurrencesAndBackoff, assertUnknownDefinitionDeferral } from "../shared/jobScheduleSemantics.js"

describe("MySQL job and schedule semantics", () => {
  it("applies the job definition's maxAttempts when a job has no explicit budget", async () => {
    const { pool } = await openMySqlFixture()
    try {
      await assertDefinitionMaxAttempts(new DrizzleMySqlJobStore(pool), async (id) => {
        const [rows] = await pool.query<RowDataPacket[]>("SELECT max_attempts FROM jobs WHERE id=?", [id])
        return Number(rows[0]!.max_attempts)
      })
    } finally {
      await pool.end()
    }
  })

  it("measures the unknown-definition deferral window from the first deferral", async () => {
    const { pool } = await openMySqlFixture()
    try {
      await assertUnknownDefinitionDeferral(new DrizzleMySqlJobStore(pool))
    } finally {
      await pool.end()
    }
  })

  it("caps catch-up by remainingOccurrences and backs off failing schedules", async () => {
    const { pool } = await openMySqlFixture()
    try {
      await assertScheduleOccurrencesAndBackoff({
        scheduleStore: new DrizzleMySqlScheduleStore(pool), jobStore: new DrizzleMySqlJobStore(pool), prefix: "mysql",
        insertSchedule: async (row) => { await pool.query("INSERT INTO schedules(id,scope,job_type,job_version,tenant_id,payload,cron_expression,timezone,overlap_policy,misfire_policy,next_run_at,remaining_occurrences) VALUES(?,'system','sched.job',1,NULL,?,?,'UTC','allow',?,?,?)", [row.id, JSON.stringify(row.payload), row.cronExpression, row.misfirePolicy, row.nextRunAt, row.remainingOccurrences]) },
        readSchedule: async (id) => {
          const [rows] = await pool.query<RowDataPacket[]>("SELECT next_run_at,last_status,last_error,remaining_occurrences FROM schedules WHERE id=?", [id])
          const row = rows[0]!
          return { nextRunAt: new Date(row.next_run_at as string), lastStatus: row.last_status as string | null, lastError: row.last_error as string | null, remainingOccurrences: row.remaining_occurrences as number | null }
        },
      })
    } finally {
      await pool.end()
    }
  })
})
