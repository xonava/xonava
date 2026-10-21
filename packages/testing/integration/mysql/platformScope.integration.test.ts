import { afterAll, beforeAll, describe, it } from "vitest"
import type { Pool, RowDataPacket } from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry, DrizzleMySqlJobStore, DrizzleMySqlScheduleStore, DrizzleMySqlWorkflowStore } from "@xonava/adapters/drizzle-mysql"
import { announcements } from "../../tests/standaloneGuideExample.js"
import { altName, clearAltDatabase, openAltDatabase } from "./altDatabase.js"
import { assertJobScopeKeysSurviveRoundTrip, assertJobsUnderScope, assertPlatformEntityPersistence, assertPlatformHttp, assertSchedulesUnderScope, assertWorkflowsUnderScope, type PlatformPhysicalProbe } from "../shared/platformScope.js"

// Private table name; jobs, schedules and workflows live in this process's throwaway alt database.
const TABLE = "fw_platform_announcements"
const announcementTable = mysqlTable(TABLE, {
  id: varchar("id", { length: 100 }).primaryKey(), title: varchar("title", { length: 255 }).notNull(), region: varchar("region", { length: 100 }).notNull(),
  priority: int("priority").notNull(), version: int("version").notNull(),
})

describe("MySQL platform scope", () => {
  let pool: Pool
  let database: string
  let drop: () => Promise<void>
  beforeAll(async () => {
    ({ pool, database, drop } = await openAltDatabase())
    await pool.query(`DROP TABLE IF EXISTS \`${TABLE}\``)
    await pool.query(`CREATE TABLE \`${TABLE}\` (id VARCHAR(100) PRIMARY KEY, title VARCHAR(255) NOT NULL, region VARCHAR(100) NOT NULL, priority INT NOT NULL, version INT NOT NULL) ENGINE=InnoDB`)
  })
  afterAll(async () => {
    try { await pool?.query(`DROP TABLE IF EXISTS \`${TABLE}\``) } finally { await drop?.() }
  })

  const provider = () => createDrizzleMySqlPersistenceProvider({
    db: drizzle(pool),
    registry: new DrizzleMySqlEntityRegistry().register(announcements, announcementTable, {
      id: announcementTable.id, title: announcementTable.title, region: announcementTable.region, priority: announcementTable.priority, version: announcementTable.version,
    }),
  })
  const probe: PlatformPhysicalProbe = {
    columns: async () => ((await pool.query<RowDataPacket[]>("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?", [TABLE]))[0]).map((row) => String(row.name)),
    exists: async (rowId) => ((await pool.query<RowDataPacket[]>(`SELECT 1 FROM \`${TABLE}\` WHERE id=?`, [rowId]))[0]).length === 1,
  }
  const stores = () => {
    const tables = { jobs: altName("jobs"), jobExecutions: altName("job_executions") }
    return {
      jobStore: new DrizzleMySqlJobStore(pool, { database, tables }),
      scheduleStore: new DrizzleMySqlScheduleStore(pool, { database, tables: { schedules: altName("schedules") } }),
      workflowStore: new DrizzleMySqlWorkflowStore(pool, { database, tables: { workflows: altName("workflows"), workflowSignals: altName("workflow_signals") } }),
    }
  }

  it("persists a platform entity without a partition column: CRUD, list, query and OCC", async () => {
    await pool.query(`DELETE FROM \`${TABLE}\``)
    await assertPlatformEntityPersistence(provider(), probe)
  })

  it("serves the platform entity through createCrudHandlers with a fixed platform scope plan", async () => {
    await pool.query(`DELETE FROM \`${TABLE}\``)
    await assertPlatformHttp(provider(), probe)
  })

  it("runs platform and system jobs under their own scope", async () => {
    await clearAltDatabase(pool, database)
    await assertJobsUnderScope(stores().jobStore, "ps-mysql")
  })

  it("materializes platform and system schedules into jobs of the same scope", async () => {
    await clearAltDatabase(pool, database)
    const { jobStore, scheduleStore } = stores()
    await assertSchedulesUnderScope({
      scheduleStore, jobStore, prefix: "ps-mysql",
      insertSchedule: async (row) => { await pool.query(`INSERT INTO \`${database}\`.\`${altName("schedules")}\`(id,scope,scope_key,job_type,job_version,tenant_id,payload,cron_expression,timezone,overlap_policy,misfire_policy,next_run_at) VALUES(?,?,?,?,1,NULL,JSON_OBJECT(),'0 * * * *','UTC','allow','fire_now',?)`, [row.id, row.scope, row.scopeKey, row.jobType, row.nextRunAt]) },
      readSchedule: async (scheduleId) => {
        const [rows] = await pool.query<RowDataPacket[]>(`SELECT next_run_at,last_status FROM \`${database}\`.\`${altName("schedules")}\` WHERE id=?`, [scheduleId])
        return { nextRunAt: new Date(rows[0]!.next_run_at as string), lastStatus: rows[0]!.last_status as string | null }
      },
    })
  })

  it("runs a workflow under platform and system scope and keeps the scope keys", async () => {
    await clearAltDatabase(pool, database)
    await assertWorkflowsUnderScope(stores().workflowStore, "ps-wf-mysql")
  })

  it("keeps a job's platformKey and systemKey through the job store", async () => {
    await clearAltDatabase(pool, database)
    await assertJobScopeKeysSurviveRoundTrip(stores().jobStore, "ps-mysql")
  })
})
