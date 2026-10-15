import { bigint, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { ConfigurationError, ConflictError } from "@xonava/core/domain"
import type { VersionedEntityDescriptor } from "@xonava/core/persistence"
import { createDrizzleMySqlPersistenceProvider, createDrizzleMySqlRepository, DrizzleMySqlEntityRegistry } from "@xonava/adapters/drizzle-mysql"
import mysql from "mysql2/promise"
import { drizzle } from "drizzle-orm/mysql2"
import type { MySqlDatabaseLike } from "@xonava/adapters/drizzle-mysql"
import { mysqlCertificationUrl } from "./database.js"

const accounts = mysqlTable("constraint_map_accounts", { id: varchar("id", { length: 100 }).primaryKey(), email: varchar("email", { length: 255 }).notNull(), handle: varchar("handle", { length: 100 }).notNull(), version: bigint("version", { mode: "number" }).notNull().default(1) })
interface Account { id: string; email: string; handle: string; version: number }
const entity: VersionedEntityDescriptor<Account> = { name: "constraintMapAccount", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, email: { type: "string" }, handle: { type: "string" }, version: { type: "number" } } }
const columnMap = { id: accounts.id, email: accounts.email, handle: accounts.handle, version: accounts.version }
const SECRET = "secret-person@example.test"
const failureOf = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected failure") }, (error: unknown) => error)
function expectNoLeak(error: unknown, ...values: string[]) {
  const serialized = `${(error as Error).message} ${JSON.stringify((error as ConflictError).details)} ${JSON.stringify(error)} ${String((error as Error).stack)}`
  for (const value of [...values, "Duplicate entry", "constraint_map_accounts", "_uq"]) expect(serialized).not.toContain(value)
  expect((error as Error).cause).toBeUndefined()
}

describe("MYSQL constraintMap", () => {
  let fixture: { pool: mysql.Pool; db: MySqlDatabaseLike }
  beforeAll(async () => {
    const pool = mysql.createPool({ uri: mysqlCertificationUrl(), connectionLimit: 4 })
    fixture = { pool, db: drizzle(pool) as unknown as MySqlDatabaseLike }
    await fixture.pool.query("DROP TABLE IF EXISTS constraint_map_accounts")
    await fixture.pool.query("CREATE TABLE constraint_map_accounts (id VARCHAR(100) PRIMARY KEY, email VARCHAR(255) NOT NULL, handle VARCHAR(100) NOT NULL, version BIGINT NOT NULL DEFAULT 1, UNIQUE KEY constraint_map_accounts_email_uq(email), UNIQUE KEY constraint_map_accounts_handle_uq(handle)) ENGINE=InnoDB")
  })
  afterAll(async () => { await fixture.pool.query("DROP TABLE IF EXISTS constraint_map_accounts"); await fixture.pool.end() })
  beforeEach(async () => {
    await fixture.pool.query("DELETE FROM constraint_map_accounts")
    await fixture.pool.query("INSERT INTO constraint_map_accounts VALUES ('a1',?,'alice',1),('a2','bob@example.test','bob',1)", [SECRET])
  })
  const provider = (constraintMap?: Record<string, string>) => createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry: new DrizzleMySqlEntityRegistry().register(entity, accounts, columnMap), ...(constraintMap ? { constraintMap } : {}) })

  it("maps a duplicate on a unique index named as table.index to the field", async () => {
    const repository = provider({ "constraint_map_accounts.constraint_map_accounts_email_uq": "email" }).repository(entity)
    const failure = await failureOf(repository.insert({ id: "a3", email: SECRET, handle: "carol" }))
    expect(failure).toBeInstanceOf(ConflictError)
    expect((failure as ConflictError).details).toMatchObject({ dialect: "mysql", field: "email" })
    expectNoLeak(failure, SECRET)
  })

  it("maps a duplicate on a unique index named by its bare index name, on insert and update", async () => {
    const repository = provider({ constraint_map_accounts_handle_uq: "handle", constraint_map_accounts_email_uq: "email" }).repository(entity)
    const inserted = await failureOf(repository.insert({ id: "a3", email: "carol@example.test", handle: "alice" }))
    expect(inserted).toBeInstanceOf(ConflictError)
    expect((inserted as ConflictError).details).toMatchObject({ field: "handle" })
    expectNoLeak(inserted, "alice")
    const updated = await failureOf(repository.update("a2", { email: SECRET }, { optimisticConcurrency: { expectedVersion: 1 } }))
    expect(updated).toBeInstanceOf(ConflictError)
    expect((updated as ConflictError).details).toMatchObject({ field: "email" })
    expectNoLeak(updated, SECRET)
  })

  it("maps inside an interactive transaction", async () => {
    const failure = await failureOf(provider({ constraint_map_accounts_email_uq: "email" }).runInTransaction(async (tx) => tx.repository(entity).insert({ id: "a3", email: SECRET, handle: "carol" })))
    expect(failure).toBeInstanceOf(ConflictError)
    expect((failure as ConflictError).details).toMatchObject({ field: "email" })
    expectNoLeak(failure, SECRET)
  })

  it("an unmapped unique index or primary key yields ConflictError without a field", async () => {
    const repository = provider({ some_other_index: "other" }).repository(entity)
    for (const attempt of [() => repository.insert({ id: "a3", email: SECRET, handle: "carol" }), () => repository.insert({ id: "a1", email: "new@example.test", handle: "new" })]) {
      const failure = await failureOf(attempt())
      expect(failure).toBeInstanceOf(ConflictError)
      expect((failure as ConflictError).details).not.toHaveProperty("field")
      expectNoLeak(failure, SECRET)
    }
    const unmappedProvider = await failureOf(provider().repository(entity).insert({ id: "a3", email: SECRET, handle: "carol" }))
    expect(unmappedProvider).toBeInstanceOf(ConflictError)
    expect((unmappedProvider as ConflictError).details).not.toHaveProperty("field")
  })

  it("a value that imitates the key suffix cannot spoof the mapped index", async () => {
    const spoof = "x' for key 'constraint_map_accounts_email_uq"
    await fixture.pool.query("INSERT INTO constraint_map_accounts VALUES ('a4','spoof@example.test',?,1)", [spoof])
    const repository = createDrizzleMySqlRepository({ db: fixture.db, table: accounts, entity, columnMap, constraintMap: { constraint_map_accounts_email_uq: "email", constraint_map_accounts_handle_uq: "handle" } })
    const failure = await failureOf(repository.insert({ id: "a5", email: "fresh@example.test", handle: spoof }))
    expect((failure as ConflictError).details).toMatchObject({ field: "handle" })
  })

  it("validates constraintMap keys and values and ignores inherited entries", async () => {
    const create = (constraintMap: unknown) => createDrizzleMySqlPersistenceProvider({ db: fixture.db, registry: new DrizzleMySqlEntityRegistry().register(entity, accounts, columnMap), constraintMap: constraintMap as never })
    for (const invalid of [{ "": "email" }, { " ": "email" }, { idx: "" }, { idx: 1 }, null, [], "idx", { [Symbol("idx")]: "email" }]) expect(() => create(invalid)).toThrow(ConfigurationError)
    expect(() => createDrizzleMySqlRepository({ db: fixture.db, table: accounts, entity, columnMap, constraintMap: { idx: "" } })).toThrow(ConfigurationError)
    const inherited = create(Object.create({ constraint_map_accounts_email_uq: "email" }))
    const failure = await failureOf(inherited.repository(entity).insert({ id: "a3", email: SECRET, handle: "carol" }))
    expect(failure).toBeInstanceOf(ConflictError)
    expect((failure as ConflictError).details).not.toHaveProperty("field")
  })
})
