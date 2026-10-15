import { describe, expect, it } from "vitest"
import { ConfigurationError } from "@xonava/core/domain"
import { MySqlDialect } from "drizzle-orm/mysql-core"
import { mysqlIdentifier, mysqlQualifiedTable, mysqlQualifiedTableSql, resolveMySqlTableNames, resolveMySqlTables } from "../mysqlIdentifiers"
import { DrizzleMySqlJobStore } from "../drizzleJobStore"
import { DrizzleMySqlJobProgressStore } from "../drizzleJobProgressStore"
import { DrizzleMySqlScheduleStore } from "../drizzleScheduleStore"
import { DrizzleMySqlWorkflowStore } from "../drizzleWorkflowStore"
import { DrizzleMySqlSequenceStore, mysqlSequenceSchemaSql, MYSQL_SEQUENCE_SCHEMA_SQL } from "../drizzleSequenceStore"
import { DrizzleMySqlTemporalHistoryStore, mysqlTemporalSchemaSql, MYSQL_TEMPORAL_SCHEMA_SQL } from "../drizzleTemporalHistoryStore"
import { MySqlAtomicLeaseBackend, MySqlAtomicRecordBackend, createMySqlInboxStore, createMySqlLeaseStore, createMySqlOutboxStore } from "../mysqlAtomicBackends"
import { MySqlTagGenerationStore } from "../mysqlTagGenerationStore"

const hostile = [
  "jobs`; DROP TABLE x;--",
  "jobs; DROP TABLE x",
  "a`.`b",
  "db.jobs",
  "1jobs",
  "",
  " jobs",
  "jobs ",
  "jo-bs",
  "jöbs",
  "jobs\u0000",
  "a".repeat(65),
  "x' OR '1'='1",
]
const pool = { query: async () => [[], []], getConnection: async () => { throw new Error("unused") } } as never

describe("MySQL identifier validation", () => {
  it("accepts ASCII word identifiers up to 64 characters", () => {
    for (const ok of ["jobs", "Jobs_2", "_private", "a".repeat(64), "framework_alt_123"]) expect(mysqlIdentifier(ok)).toBe(ok)
  })

  it("rejects injection attempts and malformed identifiers with ConfigurationError, without echoing them", () => {
    for (const bad of [...hostile, 42, null, undefined, {}]) {
      let caught: unknown
      try { mysqlIdentifier(bad, "table name") } catch (error) { caught = error }
      expect(caught).toBeInstanceOf(ConfigurationError)
      expect(String((caught as Error).message)).not.toContain("DROP")
    }
  })

  it("renders backtick-quoted, optionally database-qualified references", () => {
    expect(mysqlQualifiedTable("jobs")).toBe("`jobs`")
    expect(mysqlQualifiedTable("jobs", "tenant_db")).toBe("`tenant_db`.`jobs`")
    expect(new MySqlDialect().sqlToQuery(mysqlQualifiedTableSql("jobs", "tenant_db")).sql).toBe("`tenant_db`.`jobs`")
    expect(() => mysqlQualifiedTableSql("jobs`; DROP TABLE x;--")).toThrow(ConfigurationError)
  })

  it("resolves defaults, overrides and rejects unknown keys or hostile overrides", () => {
    const defaults = { jobs: "jobs", jobExecutions: "job_executions" }
    expect(resolveMySqlTables(defaults, undefined)).toEqual({ jobs: "`jobs`", jobExecutions: "`job_executions`" })
    expect(resolveMySqlTables(defaults, { database: "alt", tables: { jobs: "queue_jobs" } })).toEqual({ jobs: "`alt`.`queue_jobs`", jobExecutions: "`alt`.`job_executions`" })
    expect(resolveMySqlTableNames(defaults, { database: "alt" })).toEqual({ database: "alt", tables: defaults })
    expect(() => resolveMySqlTables(defaults, { tables: { jobz: "x" } as never })).toThrow(ConfigurationError)
    for (const bad of hostile) {
      expect(() => resolveMySqlTables(defaults, { tables: { jobs: bad } })).toThrow(ConfigurationError)
      expect(() => resolveMySqlTables(defaults, { database: bad })).toThrow(ConfigurationError)
    }
  })

  it("every MySQL store validates its database and table options at construction", () => {
    const bad = "jobs`; DROP TABLE x;--"
    const constructors: Array<() => unknown> = [
      () => new DrizzleMySqlJobStore(pool, { tables: { jobs: bad } }),
      () => new DrizzleMySqlJobStore(pool, { tables: { jobExecutions: bad } }),
      () => new DrizzleMySqlJobStore(pool, { database: bad }),
      () => new DrizzleMySqlJobStore(pool, { executionHistory: "sometimes" as never }),
      () => new DrizzleMySqlJobProgressStore(pool, { tables: { jobProgress: bad } }),
      () => new DrizzleMySqlJobProgressStore(pool, { database: bad }),
      () => new DrizzleMySqlScheduleStore(pool, { tables: { schedules: bad } }),
      () => new DrizzleMySqlWorkflowStore(pool, { tables: { workflowSignals: bad } }),
      () => new DrizzleMySqlSequenceStore(pool, { database: bad }),
      () => new DrizzleMySqlTemporalHistoryStore(pool, { tables: { temporalSnapshots: bad } }),
      () => new MySqlAtomicRecordBackend(pool, bad, String),
      () => new MySqlAtomicRecordBackend(pool, "atomic_records", String, { database: bad }),
      () => new MySqlAtomicLeaseBackend(pool, bad),
      () => createMySqlInboxStore(pool, bad),
      () => createMySqlOutboxStore(pool, { tables: { atomicRecords: bad } }),
      () => createMySqlLeaseStore(pool, { database: bad }),
      () => new MySqlTagGenerationStore(pool, bad),
      () => new MySqlTagGenerationStore(pool, { database: bad }),
      () => mysqlSequenceSchemaSql({ tables: { sequences: bad } }),
      () => mysqlTemporalSchemaSql({ database: bad }),
    ]
    for (const build of constructors) expect(build).toThrow(ConfigurationError)
  })

  it("keeps today's table names by default and qualifies DDL when configured", () => {
    expect(mysqlSequenceSchemaSql()).toBe(MYSQL_SEQUENCE_SCHEMA_SQL.replace("EXISTS sequences(", "EXISTS `sequences`("))
    expect(mysqlSequenceSchemaSql({ database: "alt", tables: { sequences: "seq" } })).toContain("CREATE TABLE IF NOT EXISTS `alt`.`seq`(")
    const temporal = mysqlTemporalSchemaSql({ database: "alt", tables: { temporalHeads: "heads" } })
    expect(temporal).toContain("EXISTS `alt`.`heads`(")
    expect(temporal).toContain("EXISTS `alt`.`temporal_revisions`(")
    expect(temporal).toContain("EXISTS `alt`.`temporal_snapshots`(")
    expect(MYSQL_TEMPORAL_SCHEMA_SQL).toContain("EXISTS temporal_heads(")
    expect(() => new DrizzleMySqlJobStore(pool)).not.toThrow()
    expect(() => createMySqlInboxStore(pool)).not.toThrow()
    expect(() => new MySqlTagGenerationStore(pool)).not.toThrow()
  })

  it("renders configured names into the SQL each store issues", async () => {
    const seen: string[] = []
    const recording = { query: async (text: string) => { seen.push(text); return [{ insertId: 1 }, []] as [unknown, unknown] } }
    await new DrizzleMySqlSequenceStore(recording, { database: "alt", tables: { sequences: "seq" } }).next("system" as never, "n", "p")
    expect(seen[0]).toMatch(/^INSERT INTO `alt`\.`seq`\(/)
    seen.length = 0
    await new DrizzleMySqlSequenceStore(recording).next("system" as never, "n", "p")
    expect(seen[0]).toMatch(/^INSERT INTO `sequences`\(/)
  })
})
