import { describe, expect, it } from "vitest"
import { MySqlDialect, int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { sql, type SQL } from "drizzle-orm"
import { ConfigurationError, TimeoutError } from "core/domain"
import type { VersionedEntityDescriptor } from "core/persistence"
import { DrizzleMySqlEntityRegistry, createDrizzleMySqlPersistenceProvider, getDrizzleMySqlSession } from "../drizzlePersistenceProvider"
import type { MySqlDatabaseLike } from "../drizzleRepository"
import { validateMySqlConstraintMap, validateMySqlTransactionTimeout } from "../mysqlUtils"

const table = mysqlTable("timeout_rows", { id: varchar("id", { length: 100 }).primaryKey(), email: varchar("email", { length: 100 }).notNull(), version: int("version").notNull() })
type Row = { id: string; email: string; version: number }
const entity: VersionedEntityDescriptor<Row> = { name: "timeoutRow", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, email: { type: "string" }, version: { type: "number" } } }
const registry = () => new DrizzleMySqlEntityRegistry().register(entity, table, { id: table.id, email: table.email, version: table.version })
const dialect = new MySqlDialect()
const driverError = (code: string, errno: number, sqlMessage: string) => Object.assign(new Error(`${sqlMessage} -- SELECT secret`), { code, errno, sqlMessage })

/** A fake mysql2-backed Drizzle database: records statements and lets a statement block until KILL QUERY. */
function fakeDatabase(options: { pool?: boolean; session?: { maxExecutionTime: number; lockWaitTimeout: number } } = {}) {
  const statements: string[] = []
  const kills: string[] = []
  let interrupt: ((error: Error) => void) | undefined
  const session = { ...(options.session ?? { maxExecutionTime: 0, lockWaitTimeout: 50 }) }
  const tx = {
    async execute(query: SQL) {
      const text = dialect.sqlToQuery(query).sql
      statements.push(text)
      if (text.startsWith("SELECT CONNECTION_ID()")) return [[{ connectionId: 42, maxExecutionTime: session.maxExecutionTime, lockWaitTimeout: session.lockWaitTimeout }], []]
      if (text.startsWith("SET SESSION")) {
        const match = /max_execution_time = (\d+), innodb_lock_wait_timeout = (\d+)/.exec(text)!
        session.maxExecutionTime = Number(match[1]); session.lockWaitTimeout = Number(match[2])
        return [{ affectedRows: 0 }, undefined]
      }
      if (text === "BLOCK") return new Promise((_resolve, reject) => { interrupt = reject })
      return [[], []]
    },
  }
  const db = {
    async transaction(work: (scoped: unknown) => Promise<unknown>) {
      statements.push("begin")
      try { const result = await work(tx); statements.push("commit"); return result } catch (error) { statements.push("rollback"); throw error }
    },
    ...(options.pool === false ? {} : {
      $client: {
        async getConnection() {
          return {
            threadId: 7,
            async query(text: string) { kills.push(text); interrupt?.(driverError("ER_QUERY_INTERRUPTED", 1317, "Query execution was interrupted")); interrupt = undefined; return [{}, undefined] },
            release() { /* returned to the fake pool */ },
          }
        },
      },
    }),
  }
  return { db: db as unknown as MySqlDatabaseLike, statements, kills, session }
}

describe("MySQL transaction timeouts (unit)", () => {
  it("validates timeoutMs before opening a transaction", async () => {
    expect(validateMySqlTransactionTimeout(undefined)).toBeUndefined()
    expect(validateMySqlTransactionTimeout(2 ** 31 - 1)).toBe(2 ** 31 - 1)
    const fake = fakeDatabase()
    const provider = createDrizzleMySqlPersistenceProvider({ db: fake.db, registry: registry() })
    for (const timeoutMs of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "100" as never]) {
      await expect(provider.runInTransaction(async () => 1, { timeoutMs })).rejects.toBeInstanceOf(ConfigurationError)
    }
    expect(fake.statements).toEqual([])
  })

  it("advertises transactionTimeouts only when a pool is available for KILL QUERY", () => {
    expect(createDrizzleMySqlPersistenceProvider({ db: fakeDatabase().db, registry: registry() }).capabilities.transactionTimeouts).toBe(true)
    expect(createDrizzleMySqlPersistenceProvider({ db: fakeDatabase({ pool: false }).db, registry: registry() }).capabilities.transactionTimeouts).toBe(false)
  })

  it("lowers session limits at BEGIN, restores them before COMMIT, and leaves no KILL behind", async () => {
    const fake = fakeDatabase({ session: { maxExecutionTime: 0, lockWaitTimeout: 50 } })
    const provider = createDrizzleMySqlPersistenceProvider({ db: fake.db, registry: registry() })
    await expect(provider.runInTransaction(async () => "ok", { timeoutMs: 1_500 })).resolves.toBe("ok")
    expect(fake.statements[0]).toBe("begin")
    expect(fake.statements[1]).toMatch(/^SELECT CONNECTION_ID\(\)/)
    expect(fake.statements[2]).toMatch(/^SET SESSION max_execution_time = (1[0-4]\d\d|1500), innodb_lock_wait_timeout = 2$/)
    expect(fake.statements.slice(3)).toEqual(["SET SESSION max_execution_time = 0, innodb_lock_wait_timeout = 50", "commit"])
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    expect(fake.kills).toEqual([])
  })

  it("never lengthens stricter session limits", async () => {
    const fake = fakeDatabase({ session: { maxExecutionTime: 100, lockWaitTimeout: 1 } })
    await createDrizzleMySqlPersistenceProvider({ db: fake.db, registry: registry() }).runInTransaction(async () => undefined, { timeoutMs: 10_000 })
    expect(fake.statements[2]).toBe("SET SESSION max_execution_time = 100, innodb_lock_wait_timeout = 1")
  })

  it("on expiry sends KILL QUERY for the transaction's connection, rolls back and reports TIMEOUT", async () => {
    const fake = fakeDatabase()
    const provider = createDrizzleMySqlPersistenceProvider({ db: fake.db, registry: registry() })
    const failure = await provider.runInTransaction(async (scoped) => { await blockingStatement(scoped); return "never" }, { timeoutMs: 50 }).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(TimeoutError)
    expect((failure as TimeoutError).details).toEqual({ dialect: "mysql", providerCode: "ER_QUERY_INTERRUPTED", transactionOutcome: "rolled_back" })
    expect(fake.kills).toEqual(["KILL QUERY 42"])
    expect(fake.statements.slice(-3)).toEqual(["BLOCK", "SET SESSION max_execution_time = 0, innodb_lock_wait_timeout = 50", "rollback"])
  })

  it("does not commit when the deadline passed without an in-flight statement", async () => {
    const fake = fakeDatabase()
    const provider = createDrizzleMySqlPersistenceProvider({ db: fake.db, registry: registry() })
    await expect(provider.runInTransaction(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return "late" }, { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError)
    expect(fake.statements).toContain("rollback")
    expect(fake.statements).not.toContain("commit")
  })

  it("keeps lock wait timeouts retryable unless the transaction shortened them", async () => {
    const lockWait = () => driverError("ER_LOCK_WAIT_TIMEOUT", 1205, "Lock wait timeout exceeded")
    const unbounded = createDrizzleMySqlPersistenceProvider({ db: fakeDatabase().db, registry: registry() })
    await expect(unbounded.runInTransaction(async () => { throw lockWait() })).rejects.toMatchObject({ code: "RETRYABLE_PERSISTENCE_ERROR" })
    const longBudget = createDrizzleMySqlPersistenceProvider({ db: fakeDatabase({ session: { maxExecutionTime: 0, lockWaitTimeout: 5 } }).db, registry: registry() })
    await expect(longBudget.runInTransaction(async () => { throw lockWait() }, { timeoutMs: 60_000 })).rejects.toMatchObject({ code: "RETRYABLE_PERSISTENCE_ERROR" })
    const shortened = createDrizzleMySqlPersistenceProvider({ db: fakeDatabase().db, registry: registry() })
    const failure = await shortened.runInTransaction(async () => { throw lockWait() }, { timeoutMs: 2_000 }).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(TimeoutError)
    expect((failure as TimeoutError).details).toMatchObject({ providerCode: "ER_LOCK_WAIT_TIMEOUT", transactionOutcome: "rolled_back" })
    const maxExecution = await shortened.runInTransaction(async () => { throw driverError("ER_QUERY_TIMEOUT", 3024, "maximum statement execution time exceeded") }, { timeoutMs: 2_000 }).then(() => null, (error: unknown) => error)
    expect(maxExecution).toBeInstanceOf(TimeoutError)
    expect(String((maxExecution as Error).message)).not.toContain("secret")
  })
})

async function blockingStatement(scoped: unknown): Promise<void> {
  const session = getDrizzleMySqlSession(scoped as never) as unknown as { execute(query: SQL): Promise<unknown> }
  await session.execute(sql.raw("BLOCK"))
}

describe("MySQL constraintMap validation (unit)", () => {
  it("accepts own non-empty string entries and freezes a copy", () => {
    const source = { users_email_uq: "email" }
    const validated = validateMySqlConstraintMap(source)!
    source.users_email_uq = "changed"
    expect(validated.users_email_uq).toBe("email")
    expect(Object.isFrozen(validated)).toBe(true)
    expect(validateMySqlConstraintMap(Object.create({ inherited: "x" }))).toEqual({})
  })
  it("rejects malformed maps", () => {
    for (const invalid of [null, [], "x", 1, { "": "a" }, { " ": "a" }, { a: "" }, { a: 2 }, { [Symbol("a")]: "a" }]) {
      expect(() => validateMySqlConstraintMap(invalid)).toThrow(ConfigurationError)
      expect(() => createDrizzleMySqlPersistenceProvider({ db: fakeDatabase().db, registry: registry(), constraintMap: invalid as never })).toThrow(ConfigurationError)
    }
    const getter = Object.defineProperty({}, "a", { get: () => "email", enumerable: true })
    expect(() => validateMySqlConstraintMap(getter)).toThrow(ConfigurationError)
  })
})
