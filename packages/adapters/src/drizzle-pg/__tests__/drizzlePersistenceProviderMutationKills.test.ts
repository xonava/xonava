import { describe, expect, it, vi } from "vitest"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { ConfigurationError, RetryablePersistenceError, TimeoutError, TransactionRolledBackError } from "@xonava/core/domain"
import type { InteractiveTransactionProvider } from "@xonava/core/persistence"
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry, getDrizzleSession } from "../drizzlePersistenceProvider"
import { renderSql } from "../../__tests__/support/scriptedDb"

const table = pgTable("test_rows", { id: text("id").primaryKey(), name: text("name").notNull(), version: integer("version").notNull() })
const columnMap = { id: table.id, name: table.name, version: table.version }
const fields = { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } }
const entity = { name: "test", primaryKey: "id", versionField: "version", fields } as never

interface FakeDb {
  readonly db: never
  readonly configs: unknown[]
  readonly executed: unknown[]
}

/** A database whose transaction() hands the callback a transaction handle that records execute() calls. */
function fakeDb(options: { executeError?: unknown; transactionError?: unknown } = {}): FakeDb {
  const configs: unknown[] = []
  const executed: unknown[] = []
  const tx = { execute: vi.fn(async (query: unknown) => { executed.push(query); if (options.executeError !== undefined) throw options.executeError }) }
  const db = {
    transaction: async (callback: (handle: unknown) => Promise<unknown>, config: unknown) => {
      configs.push(config)
      const result = await callback(tx)
      if (options.transactionError !== undefined) throw options.transactionError
      return result
    },
  }
  return { db: db as never, configs, executed }
}

function provider(db: never, extra: Record<string, unknown> = {}): InteractiveTransactionProvider {
  const registry = new DrizzleEntityRegistry()
  registry.register(entity, table, columnMap)
  return createDrizzlePersistenceProvider({ db, registry, ...extra })
}
const providerError = (code: string) => Object.assign(new Error("provider text"), { code })

describe("provider capabilities", () => {
  it("declares the exact PostgreSQL capability set and a frozen execution matrix", () => {
    const p = provider(fakeDb().db)
    expect(p.dialect).toBe("postgresql")
    expect(p.capabilities).toEqual({
      interactiveTransactions: true,
      atomicBatch: false,
      returningInsert: true,
      readSessions: false,
      jsonQueries: true,
      exactDecimal: false,
      persistentConnection: true,
      conditionalAbacUpdate: true,
      transactionTimeouts: true,
      maxPageSize: 100,
      execution: {
        "transaction.interactive": { status: "proven", evidence: "framework-conformance/release/pg-guarantees.json" },
        "transaction.atomicBatch": { status: "unsupported" },
        "locking.pessimistic": { status: "unsupported" },
        "bulk.versioned.atomic": { status: "unsupported" },
        "bulk.versioned.partial": { status: "unsupported" },
        "read.streaming": { status: "unsupported" },
        "read.boundedPagedScan": { status: "proven", evidence: "framework-conformance/q1/query-envelope-conformance.json" },
      },
    })
    expect(Object.isFrozen(p.capabilities.execution)).toBe(true)
  })

  it("validates the configured page size limit with the exact message", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => provider(fakeDb().db, { limits: { maxPageSize: bad } })).toThrow(new ConfigurationError("PostgreSQL maxPageSize must be a finite positive integer"))
    }
    expect(provider(fakeDb().db, { limits: { maxPageSize: 1 } }).capabilities.maxPageSize).toBe(1)
  })
})

describe("provider sessions and repositories", () => {
  it("names the missing session and the unregistered entity precisely", () => {
    expect(() => getDrizzleSession({} as never)).toThrow(new ConfigurationError("No Drizzle session found for this persistence provider"))
    const p = provider(fakeDb().db)
    expect(() => p.repository({ name: "ghost", fields } as never)).toThrow(new ConfigurationError('Entity "ghost" is not registered in the Drizzle entity registry'))
    expect(() => p.repository({ name: "test", namespace: "other", fields } as never)).toThrow('Entity "test" is not registered')
    expect(p.repository(entity)).toBeTruthy()
  })
})

describe("entity registry validation", () => {
  const register = (input: unknown, map: Record<string, unknown> = columnMap, namespace?: string) =>
    new DrizzleEntityRegistry().register(input as never, table, map as never, namespace)

  it("requires a non-empty string entity name", () => {
    for (const name of ["", "   ", 123]) {
      expect(() => register({ name, fields })).toThrow(new ConfigurationError('Drizzle registry registration "' + String(name) + '" requires a non-empty entity name.'))
    }
    expect(() => register({ name: "  ", fields }, columnMap, "ns")).toThrow('Drizzle registry registration "ns:  " requires a non-empty entity name.')
  })

  it("requires declared fields", () => {
    for (const bad of [undefined, null, "text", {}]) {
      expect(() => register({ name: "e", fields: bad })).toThrow(new ConfigurationError('Entity "e" must declare fields before registration.'))
    }
  })

  it("reports the exact missing column-map fields, key and invalid keys", () => {
    expect(() => register({ name: "e", fields }, { id: table.id })).toThrow(new ConfigurationError('Entity "e" column map is missing fields: name, version.'))
    expect(() => register({ name: "e", fields }, { ...columnMap, "": table.id })).toThrow(new ConfigurationError('Entity "e" declares an empty column map key.'))
    expect(() => register({ name: "e", fields: { id: { type: "string" } }, primaryKey: "pk" }, { id: table.id })).toThrow(new ConfigurationError('Entity "e" primary key "pk" is not a declared field.'))
    expect(() => register({ name: "e", fields, versionField: "rev" }, columnMap, "ns")).toThrow(new ConfigurationError('Entity "ns:e" version field "rev" is not a declared field.'))
  })

  it("rejects a second registration of the same name and namespace", () => {
    const registry = new DrizzleEntityRegistry().register(entity, table, columnMap).register(entity, table, columnMap, "ns")
    expect(() => registry.register(entity, table, columnMap)).toThrow(new ConfigurationError('Entity "test" is already registered in the Drizzle entity registry.'))
    expect(() => registry.register(entity, table, columnMap, "ns")).toThrow('Entity "ns:test" is already registered')
    expect(registry.get("test")).toEqual({ table, columnMap })
    expect(registry.get("test", "ns")).toEqual({ table, columnMap })
    expect(registry.get("test", "missing")).toBeUndefined()
  })
})

describe("provider transactions", () => {
  it("passes only the supplied transaction options to the driver", async () => {
    const none = fakeDb()
    await provider(none.db).runInTransaction(async () => "ok")
    expect(none.configs).toEqual([{}])
    expect(Object.keys(none.configs[0] as object)).toEqual([])
    const iso = fakeDb()
    await provider(iso.db).runInTransaction(async () => "ok", { isolationLevel: "serializable" })
    expect(iso.configs).toEqual([{ isolationLevel: "serializable" }])
    const access = fakeDb()
    await provider(access.db).runInTransaction(async () => "ok", { accessMode: "read only" })
    expect(access.configs).toEqual([{ accessMode: "read only" }])
  })

  it("returns the callback result and gives the callback a distinct provider with its own session", async () => {
    const f = fakeDb()
    const root = provider(f.db)
    let scopedSession: unknown
    const result = await root.runInTransaction(async (scoped) => { scopedSession = getDrizzleSession(scoped); return { done: true } })
    expect(result).toEqual({ done: true })
    expect(scopedSession).not.toBe(getDrizzleSession(root))
    expect(scopedSession).toBeTruthy()
  })

  it("sets a transaction-local statement timeout only when a timeout is requested", async () => {
    const withTimeout = fakeDb()
    await provider(withTimeout.db).runInTransaction(async () => "ok", { timeoutMs: 1500.9 })
    expect(withTimeout.executed).toHaveLength(1)
    expect(renderSql("pg", withTimeout.executed[0])).toEqual({ sql: "SET LOCAL statement_timeout = 1500", params: [] })
    const floor = fakeDb()
    await provider(floor.db).runInTransaction(async () => "ok", { timeoutMs: 0 })
    expect(renderSql("pg", floor.executed[0])?.sql).toBe("SET LOCAL statement_timeout = 1")
    const without = fakeDb()
    await provider(without.db).runInTransaction(async () => "ok")
    expect(without.executed).toEqual([])
  })

  it("classifies failures inside the callback as ordinary persistence errors, never as a commit rollback", async () => {
    const f = fakeDb()
    const error = await provider(f.db).runInTransaction(async () => { throw providerError("40001") }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryablePersistenceError)
    expect(error).not.toBeInstanceOf(TransactionRolledBackError)
  })

  it("classifies a definite rollback after the callback completed as a rolled-back commit", async () => {
    const f = fakeDb({ transactionError: providerError("40001") })
    const error = (await provider(f.db).runInTransaction(async () => "done").catch((e: unknown) => e)) as TransactionRolledBackError
    expect(error).toBeInstanceOf(TransactionRolledBackError)
    expect(error.details).toMatchObject({ dialect: "postgresql", providerCode: "40001" })
  })

  it("reports a timeout before commit as rolled back and a timeout at commit as unknown", async () => {
    const before = fakeDb({ executeError: providerError("57014") })
    const early = (await provider(before.db).runInTransaction(async () => "done", { timeoutMs: 5 }).catch((e: unknown) => e)) as TimeoutError
    expect(early).toBeInstanceOf(TimeoutError)
    expect(early.details).toMatchObject({ dialect: "postgresql", providerCode: "57014", transactionOutcome: "rolled_back" })
    const late = fakeDb({ transactionError: providerError("57014") })
    const atCommit = (await provider(late.db).runInTransaction(async () => "done").catch((e: unknown) => e)) as TimeoutError
    expect(atCommit).toBeInstanceOf(TimeoutError)
    expect(atCommit.details).toMatchObject({ transactionOutcome: "unknown" })
    const inCallback = fakeDb()
    const during = (await provider(inCallback.db).runInTransaction(async () => { throw providerError("57014") }).catch((e: unknown) => e)) as TimeoutError
    expect(during.details).toMatchObject({ transactionOutcome: "rolled_back" })
  })

  it("refuses nested transactions with the exact message", async () => {
    const f = fakeDb()
    await expect(provider(f.db).runInTransaction(async (scoped) => (scoped as InteractiveTransactionProvider).runInTransaction(async () => "nested")))
      .rejects.toThrow(new ConfigurationError("Nested PostgreSQL transactions are not supported by this adapter"))
  })
})
