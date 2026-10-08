import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ConfigurationError, TimeoutError } from "core/domain"
import type { PersistenceProvider, VersionedEntityDescriptor } from "core/persistence"
import { createExecutionDeadline, createOperationContext, runOperation } from "core/operation"
import { createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry, getDrizzleMySqlSession, type MySqlDatabaseLike } from "adapters/drizzle-mysql"
import { bigint, json, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { mysqlCertificationUrl } from "./database.js"

// A dedicated table keeps these timing-sensitive tests independent of the shared fixture tables.
const mysqlRecords = mysqlTable("tx_timeout_records", { id: varchar("id", { length: 100 }).primaryKey(), tenantId: varchar("tenant_id", { length: 100 }).notNull(), name: varchar("name", { length: 255 }).notNull(), version: bigint("version", { mode: "number" }).notNull().default(1), value: json("value").notNull() })

interface RecordRow { id: string; tenantId: string; name: string; version: number; value: unknown }
const entity: VersionedEntityDescriptor<RecordRow> = { name: "records", primaryKey: "id", versionField: "version", tenantField: "tenantId", fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, version: { type: "number" }, value: { type: "json" } } }
const registry = () => new DrizzleMySqlEntityRegistry().register(entity, mysqlRecords, { id: mysqlRecords.id, tenantId: mysqlRecords.tenantId, name: mysqlRecords.name, version: mysqlRecords.version, value: mysqlRecords.value })

type SessionLimits = { id: number; maxExecutionTime: number; lockWaitTimeout: number }
async function sessionLimits(connection: mysql.PoolConnection): Promise<SessionLimits> {
  const [rows] = await connection.query("SELECT CONNECTION_ID() AS id, @@session.max_execution_time AS maxExecutionTime, @@session.innodb_lock_wait_timeout AS lockWaitTimeout")
  const row = (rows as Record<string, unknown>[])[0]!
  return { id: Number(row.id), maxExecutionTime: Number(row.maxExecutionTime), lockWaitTimeout: Number(row.lockWaitTimeout) }
}
const failureOf = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected failure") }, (error: unknown) => error)
/** Records every timer created while `run` executes, to prove none is left armed afterwards. */
async function trackTimers<T>(run: () => Promise<T>): Promise<{ result: T; pending: () => number }> {
  const created: { _destroyed?: boolean }[] = []
  const original = globalThis.setTimeout
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { const handle = original(...args); created.push(handle as unknown as { _destroyed?: boolean }); return handle }) as typeof setTimeout
  try {
    const result = await run()
    return { result, pending: () => created.filter((handle) => handle._destroyed !== true).length }
  } finally {
    globalThis.setTimeout = original
  }
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("MYSQL transaction timeouts (TransactionOptions.timeoutMs)", () => {
  let fixture: { pool: mysql.Pool; db: MySqlDatabaseLike }
  let globals: { maxExecutionTime: number; lockWaitTimeout: number }
  beforeAll(async () => {
    const pool = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 8 })
    fixture = { pool, db: drizzle(pool) as unknown as MySqlDatabaseLike }
    await pool.query("CREATE TABLE IF NOT EXISTS tx_timeout_records (id VARCHAR(100) PRIMARY KEY, tenant_id VARCHAR(100) NOT NULL, name VARCHAR(255) NOT NULL, version BIGINT NOT NULL DEFAULT 1, value JSON NOT NULL) ENGINE=InnoDB")
    const [rows] = await fixture.pool.query("SELECT @@global.max_execution_time AS maxExecutionTime, @@global.innodb_lock_wait_timeout AS lockWaitTimeout")
    const row = (rows as Record<string, unknown>[])[0]!
    globals = { maxExecutionTime: Number(row.maxExecutionTime), lockWaitTimeout: Number(row.lockWaitTimeout) }
  })
  afterAll(async () => { await fixture.pool.query("DROP TABLE IF EXISTS tx_timeout_records"); await fixture.pool.end() })
  beforeEach(async () => {
    await fixture.pool.query("DELETE FROM tx_timeout_records")
    await fixture.pool.query("INSERT INTO tx_timeout_records VALUES ('r1','t','before',1,JSON_OBJECT()),('r2','t','before',1,JSON_OBJECT())")
  })
  const nameOf = async (id: string) => { const [rows] = await fixture.pool.query("SELECT name FROM tx_timeout_records WHERE id=?", [id]); return (rows as { name: string }[])[0]?.name }

  it("advertises transactionTimeouts and rejects invalid timeoutMs", async () => {
    const provider = createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry: registry() })
    expect(provider.capabilities.transactionTimeouts).toBe(true)
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31, Number.POSITIVE_INFINITY]) {
      await expect(provider.runInTransaction(async () => 1, { timeoutMs })).rejects.toBeInstanceOf(ConfigurationError)
    }
    await expect(provider.runInTransaction(async () => 1, { timeoutMs: 2 ** 31 - 1 })).resolves.toBe(1)
  })

  it("a transaction blocked on a row lock fails with TimeoutError near timeoutMs and rolls back", async () => {
    const provider = createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry: registry() })
    const locker = await fixture.pool.getConnection()
    try {
      await locker.beginTransaction()
      await locker.query("SELECT * FROM tx_timeout_records WHERE id='r1' FOR UPDATE")
      const started = Date.now()
      const failure = await failureOf(provider.runInTransaction(async (tx) => {
        await tx.repository(entity).update("r2", { name: "written-before-block" }, { optimisticConcurrency: { expectedVersion: 1 } })
        return tx.repository(entity).update("r1", { name: "blocked" }, { optimisticConcurrency: { expectedVersion: 1 } })
      }, { timeoutMs: 800 }))
      const elapsed = Date.now() - started
      expect(failure).toBeInstanceOf(TimeoutError)
      expect((failure as TimeoutError).details).toMatchObject({ dialect: "mysql", transactionOutcome: "rolled_back" })
      expect(elapsed).toBeGreaterThanOrEqual(700)
      expect(elapsed).toBeLessThan(2_000)
    } finally {
      await locker.rollback()
      locker.release()
    }
    // The statement that ran before the lock wait was rolled back with the transaction.
    expect(await nameOf("r2")).toBe("before")
    expect(await nameOf("r1")).toBe("before")
  })

  it("maps a lock wait timeout shortened to the budget to TimeoutError when no KILL connection is available", async () => {
    // A single-connection client has no pool for the watchdog: session limits alone bound lock waits.
    const connection = await mysql.createConnection(mysqlCertificationUrl())
    const locker = await fixture.pool.getConnection()
    try {
      const provider = createDrizzleMySqlPersistenceProvider({ db: drizzle(connection) as unknown as MySqlDatabaseLike, registry: registry() })
      expect(provider.capabilities.transactionTimeouts).toBe(false)
      await locker.beginTransaction()
      await locker.query("SELECT * FROM tx_timeout_records WHERE id='r1' FOR UPDATE")
      const started = Date.now()
      const failure = await failureOf(provider.runInTransaction(async (tx) => tx.repository(entity).update("r1", { name: "blocked" }, { optimisticConcurrency: { expectedVersion: 1 } }), { timeoutMs: 900 }))
      expect(failure).toBeInstanceOf(TimeoutError)
      expect((failure as TimeoutError).details).toMatchObject({ providerCode: "ER_LOCK_WAIT_TIMEOUT", transactionOutcome: "rolled_back" })
      expect(Date.now() - started).toBeLessThan(3_000)
      const [rows] = await connection.query("SELECT @@session.max_execution_time AS m, @@session.innodb_lock_wait_timeout AS l")
      expect((rows as { m: number; l: number }[])[0]).toEqual({ m: globals.maxExecutionTime, l: globals.lockWaitTimeout })
    } finally {
      await locker.rollback()
      locker.release()
      await connection.end()
    }
  })

  it("the watchdog interrupts a long DML statement with KILL QUERY", async () => {
    const provider = createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry: registry() })
    const started = Date.now()
    const failure = await failureOf(provider.runInTransaction(async (tx) => {
      await getDrizzleMySqlSession(tx).execute(sql`UPDATE tx_timeout_records SET name='slow' WHERE id='r1' AND SLEEP(5)=0`)
    }, { timeoutMs: 500 }))
    expect(failure).toBeInstanceOf(TimeoutError)
    expect((failure as TimeoutError).details).toMatchObject({ providerCode: "ER_QUERY_INTERRUPTED", transactionOutcome: "rolled_back" })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await nameOf("r1")).toBe("before")
  })

  it("never commits a transaction whose deadline passed between statements", async () => {
    const provider = createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry: registry() })
    const failure = await failureOf(provider.runInTransaction(async (tx) => {
      await tx.repository(entity).update("r1", { name: "late" }, { optimisticConcurrency: { expectedVersion: 1 } })
      await pause(500)
      return "done"
    }, { timeoutMs: 200 }))
    expect(failure).toBeInstanceOf(TimeoutError)
    expect(await nameOf("r1")).toBe("before")
  })

  it("interrupts DML issued after the deadline instead of letting it run unbounded", async () => {
    const provider = createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry: registry() })
    const started = Date.now()
    const failure = await failureOf(provider.runInTransaction(async (tx) => {
      await pause(400)
      await getDrizzleMySqlSession(tx).execute(sql`UPDATE tx_timeout_records SET name='slow' WHERE id='r1' AND SLEEP(5)=0`)
    }, { timeoutMs: 200 }))
    expect(failure).toBeInstanceOf(TimeoutError)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("restores the pooled connection's session limits after a timeout and keeps it usable", async () => {
    const pool = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 2 })
    try {
      const provider = createDrizzleMySqlPersistenceProvider({ db: drizzle(pool) as unknown as MySqlDatabaseLike, registry: registry() })
      let transactionConnection = 0
      const failure = await failureOf(provider.runInTransaction(async (tx) => {
        const [rows] = await getDrizzleMySqlSession(tx).execute(sql`SELECT CONNECTION_ID() AS id, @@session.max_execution_time AS m, @@session.innodb_lock_wait_timeout AS l`) as unknown as [Record<string, unknown>[]]
        transactionConnection = Number(rows[0]!.id)
        expect(Number(rows[0]!.m)).toBeGreaterThan(0)
        expect(Number(rows[0]!.m)).toBeLessThanOrEqual(400)
        expect(Number(rows[0]!.l)).toBe(1)
        await getDrizzleMySqlSession(tx).execute(sql`UPDATE tx_timeout_records SET name='slow' WHERE id='r1' AND SLEEP(5)=0`)
      }, { timeoutMs: 400 }))
      expect(failure).toBeInstanceOf(TimeoutError)
      // Check out every pooled connection so the one used by the transaction is among them.
      const connections = [await pool.getConnection(), await pool.getConnection()]
      try {
        const limits = await Promise.all(connections.map(sessionLimits))
        expect(limits.map((entry) => entry.id)).toContain(transactionConnection)
        for (const entry of limits) expect({ m: entry.maxExecutionTime, l: entry.lockWaitTimeout }).toEqual({ m: globals.maxExecutionTime, l: globals.lockWaitTimeout })
        for (const connection of connections) {
          const [rows] = await connection.query("SELECT COUNT(*) AS c FROM tx_timeout_records")
          expect(Number((rows as { c: number }[])[0]!.c)).toBe(2)
          await connection.query("UPDATE tx_timeout_records SET name='after' WHERE id='r2' AND SLEEP(0.6)=0")
        }
      } finally {
        for (const connection of connections) connection.release()
      }
      await expect(provider.runInTransaction(async (tx) => (await tx.repository(entity).findMany({})).rows.length, { timeoutMs: 5_000 })).resolves.toBe(2)
    } finally {
      await pool.end()
    }
  })

  it("a transaction finishing just before its deadline commits, leaves no timer and no stray KILL", async () => {
    const pool = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 1 })
    try {
      const provider = createDrizzleMySqlPersistenceProvider({ db: drizzle(pool) as unknown as MySqlDatabaseLike, registry: registry() })
      const tracked = await trackTimers(() => provider.runInTransaction(async (tx) => {
        await getDrizzleMySqlSession(tx).execute(sql`DO SLEEP(0.4)`)
        await tx.repository(entity).update("r1", { name: "committed" }, { optimisticConcurrency: { expectedVersion: 1 } })
        return "ok"
      }, { timeoutMs: 700 }))
      expect(tracked.result).toBe("ok")
      expect(tracked.pending()).toBe(0)
      expect(await nameOf("r1")).toBe("committed")
      // Run across the old deadline on the same (only) pooled connection: nothing interrupts it.
      const connection = await pool.getConnection()
      try {
        const started = Date.now()
        await connection.query("UPDATE tx_timeout_records SET name='after-deadline' WHERE id='r2' AND SLEEP(0.8)=0")
        expect(Date.now() - started).toBeGreaterThanOrEqual(750)
        const [rows] = await connection.query("SELECT SLEEP(0.3) AS interrupted")
        expect(Number((rows as { interrupted: number }[])[0]!.interrupted)).toBe(0)
        expect(await sessionLimits(connection)).toMatchObject({ maxExecutionTime: globals.maxExecutionTime, lockWaitTimeout: globals.lockWaitTimeout })
      } finally {
        connection.release()
      }
      expect(await nameOf("r2")).toBe("after-deadline")
    } finally {
      await pool.end()
    }
  })

  it("runs read-only transactions with a timeout", async () => {
    const provider = createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry: registry() })
    await expect(provider.runInTransaction(async (tx) => (await tx.repository(entity).findMany({})).rows.length, { timeoutMs: 2_000, accessMode: "read only" })).resolves.toBe(2)
  })

  it("runOperation bounds the transaction by the operation deadline and reports TIMEOUT", async () => {
    const provider = createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry: registry() })
    const locker = await fixture.pool.getConnection()
    try {
      await locker.beginTransaction()
      await locker.query("SELECT * FROM tx_timeout_records WHERE id='r1' FOR UPDATE")
      const started = Date.now()
      const failure = await failureOf(runOperation({
        operation: createOperationContext({ persistence: provider, runtimeCapabilities: {} as never, deadline: createExecutionDeadline(new Date(Date.now() + 700)) }),
        definition: { key: "rename-record", kind: "mutation", authorization: { authorize: async () => ({ allowed: true }) }, atomicity: { kind: "standard", mode: "required" }, execute: async ({ operation }: { operation: { persistence: PersistenceProvider } }) => operation.persistence.repository(entity).update("r1", { name: "renamed" }, { optimisticConcurrency: { expectedVersion: 1 } }) } as never,
        input: {},
      }))
      expect(failure).toBeInstanceOf(TimeoutError)
      expect(Date.now() - started).toBeLessThan(2_500)
    } finally {
      await locker.rollback()
      locker.release()
    }
    expect(await nameOf("r1")).toBe("before")
  })
})
