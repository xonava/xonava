import { afterEach, describe, expect, it, vi } from "vitest"
import { MySqlDialect, int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import type { SQL } from "drizzle-orm"
import { ConfigurationError, FrameworkCoreError, PersistenceError, TimeoutError, TransactionRolledBackError } from "@xonava/core/domain"
import type { InteractiveTransactionProvider, VersionedEntityDescriptor } from "@xonava/core/persistence"
import { DrizzleMySqlEntityRegistry, createDrizzleMySqlPersistenceProvider } from "../drizzlePersistenceProvider"
import type { MySqlDatabaseLike } from "../drizzleRepository"

const table = mysqlTable("kill_rows", { id: varchar("id", { length: 100 }).primaryKey(), name: varchar("name", { length: 100 }).notNull(), version: int("version").notNull() })
const columns = { id: table.id, name: table.name, version: table.version }
const entity: VersionedEntityDescriptor<{ id: string; name: string; version: number }> = { name: "killRow", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } } }
const registry = () => new DrizzleMySqlEntityRegistry().register(entity, table, columns)
const dialect = new MySqlDialect()
const driverError = (code: string | undefined, errno?: number) => Object.assign(new Error("driver text SELECT secret"), { ...(code === undefined ? {} : { code }), ...(errno === undefined ? {} : { errno }) })
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const BASE_SET = /^SET SESSION max_execution_time = \d+, innodb_lock_wait_timeout = \d+$/

interface FakeOptions {
  /** false: no `$client` at all. */
  pool?: boolean
  client?: unknown
  session?: { connectionId?: unknown; maxExecutionTime?: unknown; lockWaitTimeout?: unknown }
  /** Raw result of the session-limits SELECT. */
  selectResult?: unknown
  handler?: (text: string, statements: string[]) => unknown
  threadId?: number
  kill?: (text: string, statements: string[]) => Promise<unknown>
  getConnection?: () => Promise<unknown>
  afterWork?: unknown
}

function fake(options: FakeOptions = {}) {
  const statements: string[] = []
  const kills: string[] = []
  const configs: unknown[] = []
  let released = 0
  const session = { connectionId: 42, maxExecutionTime: 0, lockWaitTimeout: 50, ...(options.session ?? {}) }
  const tx = {
    async execute(query: SQL) {
      const text = dialect.sqlToQuery(query).sql
      statements.push(text)
      const custom = options.handler?.(text, statements)
      if (custom !== undefined) return await custom
      if (text.startsWith("SELECT CONNECTION_ID()")) return "selectResult" in options ? options.selectResult : [[session], []]
      if (text.startsWith("SET SESSION")) return [{ affectedRows: 0 }, undefined]
      return [[], []]
    },
  }
  const connection = {
    threadId: options.threadId ?? 7,
    async query(text: string) { kills.push(text); return options.kill ? await options.kill(text, statements) : [{}, undefined] },
    release() { released += 1 },
  }
  const db = {
    async transaction(work: (scoped: unknown) => Promise<unknown>, config?: unknown) {
      configs.push(config)
      statements.push("begin")
      try {
        const result = await work(tx)
        if (options.afterWork !== undefined) throw options.afterWork
        statements.push("commit")
        return result
      } catch (error) { statements.push("rollback"); throw error }
    },
    ...(options.client !== undefined ? { $client: options.client } : options.pool === false ? {} : { $client: { getConnection: options.getConnection ?? (async () => connection) } }),
  }
  return { db: db as unknown as MySqlDatabaseLike, statements, kills, configs, released: () => released }
}

function providerOf(db: MySqlDatabaseLike): InteractiveTransactionProvider {
  return createDrizzleMySqlPersistenceProvider({ db, registry: registry() })
}
const settle = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error)

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe("MySQL registry validation messages", () => {
  const fresh = () => new DrizzleMySqlEntityRegistry()
  it("names the key in every rejection and checks each shape guard on its own", () => {
    expect(() => fresh().register(null as never, table, columns)).toThrow(new ConfigurationError('MySQL registry registration "undefined" requires a non-empty entity name'))
    expect(() => fresh().register({ name: 5, fields: { id: {} } } as never, table, columns)).toThrow(new ConfigurationError('MySQL registry registration "5" requires a non-empty entity name'))
    expect(() => fresh().register({ name: "e" } as never, table, columns)).toThrow(new ConfigurationError('Entity "e" must declare fields before registration'))
    expect(() => fresh().register({ name: "e", fields: null } as never, table, columns)).toThrow(new ConfigurationError('Entity "e" must declare fields before registration'))
    expect(() => fresh().register({ name: "e", fields: "abc" } as never, table, columns)).toThrow(new ConfigurationError('Entity "e" must declare fields before registration'))
    expect(() => fresh().register({ name: "e", fields: { id: {} } } as never, table, { id: undefined } as never)).toThrow(new ConfigurationError('Entity "e" column map is missing fields: id'))
    expect(() => fresh().register({ name: "e", fields: { id: {} } } as never, table, Object.create({ id: table.id }) as never)).toThrow(new ConfigurationError('Entity "e" column map is missing fields: id'))
  })

  it("names a missing entity under its namespace too", () => {
    expect(() => fresh().register(null as never, table, columns, "ns")).toThrow(new ConfigurationError('MySQL registry registration "ns:undefined" requires a non-empty entity name'))
  })

  it("accepts an entity without a version field", () => {
    const registered = fresh().register({ name: "plain", fields: { id: { type: "string" } } } as never, table, { id: table.id })
    expect(registered.get("plain")?.table).toBe(table)
  })
})

describe("MySQL cancellation pool resolution", () => {
  it("treats a null client, a null promise wrapper and a plain object as having no pool", () => {
    expect(providerOf(fake({ client: null }).db).capabilities.transactionTimeouts).toBe(false)
    expect(providerOf(fake({ client: { promise: () => null } }).db).capabilities.transactionTimeouts).toBe(false)
    expect(providerOf(fake({ client: { promise: () => "str" } }).db).capabilities.transactionTimeouts).toBe(false)
    expect(providerOf(fake({ client: {} }).db).capabilities.transactionTimeouts).toBe(false)
    expect(providerOf(fake({ client: "text" }).db).capabilities.transactionTimeouts).toBe(false)
  })

  it("uses the promise wrapper of a callback-style client", () => {
    const wrapped = { getConnection: async () => ({}) }
    expect(providerOf(fake({ client: { promise: () => wrapped } }).db).capabilities.transactionTimeouts).toBe(true)
    expect(providerOf(fake({ client: { getConnection: async () => ({}) } }).db).capabilities.transactionTimeouts).toBe(true)
  })
})

describe("MySQL provider capabilities", () => {
  it("declares the exact capability set and execution matrix", () => {
    const p = providerOf(fake().db)
    expect(p.dialect).toBe("mysql")
    expect(p.capabilities).toEqual({
      interactiveTransactions: true,
      atomicBatch: false,
      returningInsert: false,
      readSessions: false,
      jsonQueries: true,
      exactDecimal: false,
      persistentConnection: true,
      conditionalAbacUpdate: true,
      transactionTimeouts: true,
      maxPageSize: 100,
      execution: {
        "transaction.interactive": { status: "proven", evidence: "framework-conformance/release/mysql-guarantees.json" },
        "transaction.atomicBatch": { status: "unsupported" },
        "locking.pessimistic": { status: "unsupported" },
        "bulk.versioned.atomic": { status: "unsupported" },
        "bulk.versioned.partial": { status: "unsupported" },
        "read.streaming": { status: "unsupported" },
        "read.boundedPagedScan": { status: "proven", evidence: "framework-conformance/mysql1/mysql-guarantees.json" },
      },
    })
    expect(Object.isFrozen(p.capabilities.execution)).toBe(true)
    expect(createDrizzleMySqlPersistenceProvider({ db: fake().db, registry: registry(), maxPageSize: 7 }).capabilities.maxPageSize).toBe(7)
    expect(providerOf(fake({ pool: false }).db).capabilities.transactionTimeouts).toBe(false)
  })
})

describe("MySQL session limit parsing", () => {
  const fixedClock = () => { vi.spyOn(Date, "now").mockReturnValue(1_000_000) }

  it("accepts numeric strings, bigints and zero, and restores the previous values", async () => {
    fixedClock()
    const f = fake({ session: { connectionId: "42", maxExecutionTime: 9n, lockWaitTimeout: "50" } })
    await expect(providerOf(f.db).runInTransaction(async () => "ok", { timeoutMs: 5_000 })).resolves.toBe("ok")
    expect(f.statements.slice(2)).toEqual([
      "SET SESSION max_execution_time = 9, innodb_lock_wait_timeout = 5",
      "SET SESSION max_execution_time = 9, innodb_lock_wait_timeout = 50",
      "commit",
    ])
  })

  it("accepts connection id 1 and a max_execution_time of 0", async () => {
    fixedClock()
    const f = fake({ session: { connectionId: 1, maxExecutionTime: 0, lockWaitTimeout: 0 } })
    await providerOf(f.db).runInTransaction(async () => 1, { timeoutMs: 5_000 })
    expect(f.statements.slice(2)).toEqual([
      "SET SESSION max_execution_time = 5000, innodb_lock_wait_timeout = 5",
      "SET SESSION max_execution_time = 0, innodb_lock_wait_timeout = 0",
      "commit",
    ])
  })

  it("rounds the lock wait budget up to whole seconds and never below one", async () => {
    fixedClock()
    const a = fake({ session: { lockWaitTimeout: 50 } })
    await providerOf(a.db).runInTransaction(async () => 1, { timeoutMs: 1_001 })
    expect(a.statements[2]).toBe("SET SESSION max_execution_time = 1001, innodb_lock_wait_timeout = 2")
    const b = fake({ session: { lockWaitTimeout: 50 } })
    await providerOf(b.db).runInTransaction(async () => 1, { timeoutMs: 1 })
    expect(b.statements[2]).toBe("SET SESSION max_execution_time = 1, innodb_lock_wait_timeout = 1")
    const c = fake({ session: { maxExecutionTime: 9_000, lockWaitTimeout: 10 } })
    await providerOf(c.db).runInTransaction(async () => 1, { timeoutMs: 5_000 })
    expect(c.statements[2]).toBe("SET SESSION max_execution_time = 5000, innodb_lock_wait_timeout = 5")
    const d = fake({ session: { maxExecutionTime: 3_000, lockWaitTimeout: 3 } })
    await providerOf(d.db).runInTransaction(async () => 1, { timeoutMs: 5_000 })
    expect(d.statements[2]).toBe("SET SESSION max_execution_time = 3000, innodb_lock_wait_timeout = 3")
  })

  const invalid: unknown[] = [1.5, -1, "abc", Number.NaN, 2 ** 60, 2n ** 60n, true, null, undefined, {}]
  it.each([["connectionId", "connection_id"], ["maxExecutionTime", "max_execution_time"], ["lockWaitTimeout", "innodb_lock_wait_timeout"]] as const)("rejects an unreadable %s", async (key, variable) => {
    fixedClock()
    for (const value of invalid) {
      const f = fake({ session: { [key]: value } })
      const failure = await settle(providerOf(f.db).runInTransaction(async () => 1, { timeoutMs: 5_000 }))
      expect(failure).toBeInstanceOf(PersistenceError)
      expect((failure as PersistenceError).message).toBe("Could not read MySQL session limits")
      expect((failure as PersistenceError).details).toEqual({ dialect: "mysql", variable })
      expect(f.statements).toEqual(["begin", expect.stringMatching(/^SELECT CONNECTION_ID\(\)/), "rollback"])
    }
  })

  it("rejects connection id 0", async () => {
    fixedClock()
    const failure = await settle(providerOf(fake({ session: { connectionId: 0 } }).db).runInTransaction(async () => 1, { timeoutMs: 5_000 }))
    expect((failure as PersistenceError).message).toBe("Could not read MySQL session limits")
    expect((failure as PersistenceError).details).toEqual({ dialect: "mysql", variable: "connection_id" })
  })

  it("reads rows from a plain row array and treats other results as no row", async () => {
    fixedClock()
    const plain = fake({ selectResult: [{ connectionId: 42, maxExecutionTime: 0, lockWaitTimeout: 50 }] })
    await expect(providerOf(plain.db).runInTransaction(async () => "ok", { timeoutMs: 5_000 })).resolves.toBe("ok")
    for (const selectResult of [undefined, { connectionId: 42 }, [], [[]], "rows"]) {
      const f = fake({ selectResult, handler: (text) => (text.startsWith("SELECT CONNECTION_ID()") ? selectResult : undefined) })
      const failure = await settle(providerOf(f.db).runInTransaction(async () => 1, { timeoutMs: 5_000 }))
      expect((failure as PersistenceError).details).toEqual({ dialect: "mysql", variable: "connection_id" })
    }
  })
})

describe("MySQL deadline boundaries", () => {
  it("treats a deadline equal to now as already expired before any statement", async () => {
    let clock = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const f = fake()
    const original = f.db.transaction.bind(f.db)
    ;(f.db as unknown as { transaction: unknown }).transaction = (work: (tx: unknown) => Promise<unknown>) => original(async (tx) => { clock += 100; return work(tx) })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => 1, { timeoutMs: 100 }))
    expect(failure).toBeInstanceOf(TimeoutError)
    expect((failure as TimeoutError).details).toEqual({ dialect: "mysql", transactionOutcome: "rolled_back" })
    expect(f.statements).toEqual(["begin", "rollback"])
  })

  it("does not restore session limits that were never lowered when the budget runs out after reading them", async () => {
    let clock = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const f = fake({ handler: (text) => { if (text.startsWith("SELECT CONNECTION_ID()")) clock += 100; return undefined } })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => 1, { timeoutMs: 100 }))
    expect(failure).toBeInstanceOf(TimeoutError)
    expect((failure as TimeoutError).details).toEqual({ dialect: "mysql", transactionOutcome: "rolled_back" })
    expect(f.statements).toEqual(["begin", expect.stringMatching(/^SELECT CONNECTION_ID\(\)/), "rollback"])
  })
})

describe("MySQL deadline watchdog", () => {
  it("does not fire early: a transaction that finishes within its budget commits and sends no KILL", async () => {
    const f = fake()
    await expect(providerOf(f.db).runInTransaction(async () => { await sleep(40); return "ok" }, { timeoutMs: 3_000 })).resolves.toBe("ok")
    expect(f.statements.at(-1)).toBe("commit")
    expect(f.kills).toEqual([])
  })

  it("rejects a late result with a rolled-back TimeoutError even though no statement was interrupted", async () => {
    const f = fake()
    const failure = await settle(providerOf(f.db).runInTransaction(async () => { await sleep(150); return "late" }, { timeoutMs: 50 }))
    expect(failure).toBeInstanceOf(TimeoutError)
    expect((failure as TimeoutError).details).toEqual({ dialect: "mysql", transactionOutcome: "rolled_back" })
    expect(f.statements).not.toContain("commit")
    expect(f.statements.at(-1)).toBe("rollback")
    expect(f.kills[0]).toBe("KILL QUERY 42")
  })

  it("repeats KILL QUERY while the transaction is still running", async () => {
    const f = fake()
    await settle(providerOf(f.db).runInTransaction(async () => { await sleep(750) }, { timeoutMs: 40 }))
    expect(f.kills.length).toBeGreaterThanOrEqual(2)
    expect(new Set(f.kills)).toEqual(new Set(["KILL QUERY 42"]))
  })

  it("does not repeat a KILL that failed", async () => {
    const f = fake({ kill: async () => { throw driverError("ER_NO_SUCH_THREAD") } })
    await settle(providerOf(f.db).runInTransaction(async () => { await sleep(700) }, { timeoutMs: 40 }))
    expect(f.kills).toEqual(["KILL QUERY 42"])
    expect(f.released()).toBe(1)
  })

  it("never kills its own connection and gives the borrowed connection back", async () => {
    const f = fake({ threadId: 42 })
    await settle(providerOf(f.db).runInTransaction(async () => { await sleep(500) }, { timeoutMs: 40 }))
    expect(f.kills).toEqual([])
    expect(f.released()).toBe(1)
  })

  it("does not kill when the kill connection arrives after the transaction ended", async () => {
    let resolveConnection: (connection: unknown) => void = () => undefined
    let released = 0
    const kills: string[] = []
    const f = fake({ getConnection: () => new Promise((resolve) => { resolveConnection = resolve }) })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => { await sleep(150) }, { timeoutMs: 40 }))
    expect(failure).toBeInstanceOf(TimeoutError)
    resolveConnection({ threadId: 7, query: async (text: string) => { kills.push(text); return [{}] }, release: () => { released += 1 } })
    await sleep(30)
    expect(kills).toEqual([])
    expect(released).toBe(1)
  })

  it("waits for an in-flight KILL before restoring the session limits", async () => {
    const f = fake({
      kill: async (_text, statements) => { await sleep(250); statements.push("kill-done"); return [{}] },
    })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => { await sleep(120) }, { timeoutMs: 40 }))
    expect(failure).toBeInstanceOf(TimeoutError)
    const done = f.statements.indexOf("kill-done")
    const restore = f.statements.lastIndexOf("SET SESSION max_execution_time = 0, innodb_lock_wait_timeout = 50")
    expect(done).toBeGreaterThan(0)
    expect(restore).toBeGreaterThan(done)
    expect(f.kills).toEqual(["KILL QUERY 42"])
  })

  it("survives a deadline without any pool to send KILL from", async () => {
    const f = fake({ pool: false })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => { await sleep(120); return 1 }, { timeoutMs: 30 }))
    expect(failure).toBeInstanceOf(TimeoutError)
    expect(f.kills).toEqual([])
  })

  it("survives a kill pool that cannot hand out a connection", async () => {
    const f = fake({ getConnection: async () => { throw new Error("pool exhausted") } })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => { await sleep(120); return 1 }, { timeoutMs: 30 }))
    expect(failure).toBeInstanceOf(TimeoutError)
  })

  it("reports the interrupting code of the statement that was killed", async () => {
    for (const code of ["ER_QUERY_INTERRUPTED", "ER_QUERY_TIMEOUT", "ER_LOCK_WAIT_TIMEOUT"]) {
      const f = fake()
      const failure = await settle(providerOf(f.db).runInTransaction(async () => { await sleep(120); throw driverError(code) }, { timeoutMs: 30 }))
      expect((failure as TimeoutError).details).toEqual({ dialect: "mysql", providerCode: code, transactionOutcome: "rolled_back" })
    }
  })
})

describe("MySQL watchdog timers are always cleaned up", () => {
  it("leaves no timer after success", async () => {
    vi.useFakeTimers()
    const f = fake()
    await expect(providerOf(f.db).runInTransaction(async () => "ok", { timeoutMs: 5_000 })).resolves.toBe("ok")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("leaves no timer after a failing callback", async () => {
    vi.useFakeTimers()
    const f = fake()
    const failure = await settle(providerOf(f.db).runInTransaction(async () => { throw new ConfigurationError("work failed") }, { timeoutMs: 5_000 }))
    expect((failure as Error).message).toBe("work failed")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("leaves no repeat timer when a slow KILL completes after the transaction finished", async () => {
    vi.useFakeTimers()
    let finishKill: () => void = () => undefined
    const f = fake({ kill: () => new Promise((resolve) => { finishKill = () => resolve([{}]) }) })
    let openGate: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const running = settle(providerOf(f.db).runInTransaction(async () => { await gate }, { timeoutMs: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    expect(f.kills).toEqual(["KILL QUERY 42"])
    openGate()
    await vi.advanceTimersByTimeAsync(0)
    finishKill()
    const failure = await running
    expect(failure).toBeInstanceOf(TimeoutError)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("MySQL session restore", () => {
  const restoreFailure = () => driverError("ER_ACCESS_DENIED_ERROR")
  /** The first SET lowers the limits; every later SET is a restore. */
  const restoreHandler = (fail: () => unknown) => {
    let sets = 0
    return (text: string) => {
      if (!BASE_SET.test(text)) return undefined
      sets += 1
      if (sets > 1) throw fail()
      return undefined
    }
  }

  it("surfaces a failed restore after a successful callback and does not commit", async () => {
    const f = fake({ handler: restoreHandler(restoreFailure) })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => "ok", { timeoutMs: 5_000 }))
    expect(failure).toBeInstanceOf(FrameworkCoreError)
    expect(String((failure as Error).message)).not.toContain("secret")
    expect((failure as FrameworkCoreError).details).toMatchObject({ dialect: "mysql" })
    expect(f.statements.filter((s) => BASE_SET.test(s))).toHaveLength(2)
    expect(f.statements).not.toContain("commit")
    expect(f.statements.at(-1)).toBe("rollback")
  })

  it("lets the original error win over a failed restore", async () => {
    const f = fake({ handler: restoreHandler(restoreFailure) })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => { throw new ConfigurationError("work failed") }, { timeoutMs: 5_000 }))
    expect(failure).toBeInstanceOf(ConfigurationError)
    expect((failure as Error).message).toBe("work failed")
  })

  it("retries a restore that a late KILL interrupted", async () => {
    let sets = 0
    const f = fake({ handler: (text) => { if (BASE_SET.test(text)) { sets += 1; if (sets === 2) throw driverError("ER_QUERY_INTERRUPTED", 1317) } return undefined } })
    await expect(providerOf(f.db).runInTransaction(async () => "ok", { timeoutMs: 5_000 })).resolves.toBe("ok")
    expect(f.statements.filter((s) => BASE_SET.test(s))).toHaveLength(3)
    expect(f.statements.at(-1)).toBe("commit")
  })

  it("reports a restore that is interrupted twice on the success path only", async () => {
    const twice = () => restoreHandler(() => driverError("ER_QUERY_INTERRUPTED", 1317))
    const ok = fake({ handler: twice() })
    const failure = await settle(providerOf(ok.db).runInTransaction(async () => "ok", { timeoutMs: 5_000 }))
    expect(failure).toBeInstanceOf(FrameworkCoreError)
    expect((failure as FrameworkCoreError).details).toMatchObject({ dialect: "mysql" })
    expect(ok.statements.filter((s) => BASE_SET.test(s))).toHaveLength(3)
    expect(ok.statements).not.toContain("commit")
    const bad = fake({ handler: twice() })
    const original = await settle(providerOf(bad.db).runInTransaction(async () => { throw new ConfigurationError("work failed") }, { timeoutMs: 5_000 }))
    expect((original as Error).message).toBe("work failed")
    expect(bad.statements.filter((s) => BASE_SET.test(s))).toHaveLength(3)
  })
})

describe("MySQL transaction failure classification", () => {
  it("classifies a commit failure after the callback completed, with and without a deadline", async () => {
    for (const options of [undefined, { timeoutMs: 5_000 }]) {
      const f = fake({ afterWork: driverError("ER_LOCK_DEADLOCK", 1213) })
      const failure = await settle(providerOf(f.db).runInTransaction(async () => "ok", options))
      expect(failure).toBeInstanceOf(TransactionRolledBackError)
      expect((failure as TransactionRolledBackError).details).toEqual({ dialect: "mysql", providerCode: "ER_LOCK_DEADLOCK" })
    }
  })

  it("keeps an unknown commit failure out of the rolled-back classification", async () => {
    const f = fake({ afterWork: driverError("ER_UNKNOWN_COMMIT") })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => "ok", { timeoutMs: 5_000 }))
    expect(failure).toBeInstanceOf(FrameworkCoreError)
    expect(failure).not.toBeInstanceOf(TransactionRolledBackError)
  })

  it("maps a statement timeout to TIMEOUT with the symbolic code only under a deadline", async () => {
    const bounded = await settle(providerOf(fake().db).runInTransaction(async () => { throw driverError(undefined, 3024) }, { timeoutMs: 5_000 }))
    expect(bounded).toBeInstanceOf(TimeoutError)
    expect((bounded as TimeoutError).details).toEqual({ dialect: "mysql", providerCode: "ER_QUERY_TIMEOUT", transactionOutcome: "rolled_back" })
    const unbounded = await settle(providerOf(fake().db).runInTransaction(async () => { throw driverError(undefined, 3024) }))
    expect(unbounded).toBeInstanceOf(TimeoutError)
    expect((unbounded as TimeoutError).details).toEqual({ dialect: "mysql", providerCode: "3024", transactionOutcome: "rolled_back" })
  })

  it("maps a lock wait the transaction shortened to TIMEOUT, and only that", async () => {
    const shortened = await settle(providerOf(fake().db).runInTransaction(async () => { throw driverError(undefined, 1205) }, { timeoutMs: 2_000 }))
    expect(shortened).toBeInstanceOf(TimeoutError)
    expect((shortened as TimeoutError).details).toEqual({ dialect: "mysql", providerCode: "ER_LOCK_WAIT_TIMEOUT", transactionOutcome: "rolled_back" })
    const untouched = await settle(providerOf(fake({ session: { lockWaitTimeout: 1 } }).db).runInTransaction(async () => { throw driverError(undefined, 1205) }, { timeoutMs: 2_000 }))
    expect(untouched).not.toBeInstanceOf(TimeoutError)
  })

  it("keeps a lock wait timeout retryable when it strikes before the limits were lowered", async () => {
    const f = fake({ handler: (text) => { if (text.startsWith("SELECT CONNECTION_ID()")) throw driverError("ER_LOCK_WAIT_TIMEOUT", 1205); return undefined } })
    const failure = await settle(providerOf(f.db).runInTransaction(async () => 1, { timeoutMs: 2_000 }))
    expect(failure).not.toBeInstanceOf(TimeoutError)
    expect(failure).toMatchObject({ code: "RETRYABLE_PERSISTENCE_ERROR" })
  })

  it("rejects nested transactions with and without a deadline", async () => {
    for (const options of [undefined, { timeoutMs: 5_000 }]) {
      const failure = await settle(providerOf(fake().db).runInTransaction(async (scoped) => (scoped as InteractiveTransactionProvider).runInTransaction(async () => 1), options))
      expect(failure).toEqual(new ConfigurationError("Nested MySQL transactions are not supported"))
    }
  })
})
