import { describe, expect, it } from "vitest"
import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core"
import { ConfigurationError, ConflictError, TimeoutError, TransactionRolledBackError } from "@xonava/core/domain"
import type { AuditRecord, OutboxRecord } from "@xonava/core/events"
import type { InteractiveTransactionProvider } from "@xonava/core/persistence"
import { createDrizzleMySqlPersistenceProvider, DrizzleMySqlEntityRegistry, getDrizzleMySqlSession } from "../drizzlePersistenceProvider"
import { createDrizzleMySqlAuditSinkFactory, DrizzleMySqlAuditSink } from "../drizzleAuditSink"
import { createDrizzleMySqlOutboxSinkFactory, DrizzleMySqlOutboxSink } from "../drizzleOutboxSink"
import { createScriptedDb, type ScriptedHandler } from "../../__tests__/support/scriptedDb"

const things = mysqlTable("things", { id: varchar("id", { length: 36 }).primaryKey(), name: varchar("name", { length: 64 }).notNull(), version: int("version").notNull() })
const outbox = mysqlTable("outbox", {
  id: varchar("id", { length: 36 }).primaryKey(), idempotencyScope: varchar("idempotency_scope", { length: 255 }), idempotencyKey: varchar("idempotency_key", { length: 255 }), eventFingerprint: varchar("event_fingerprint", { length: 128 }),
  tenantId: varchar("tenant_id", { length: 64 }), provenance: varchar("provenance", { length: 255 }), type: varchar("type", { length: 64 }),
})
const audit = mysqlTable("audit", { id: varchar("id", { length: 36 }).primaryKey(), action: varchar("action", { length: 32 }) })
const entity = { name: "thing", primaryKey: "id", versionField: "version", fields: { id: { type: "string" }, name: { type: "string" }, version: { type: "number" } } } as const
const columns = { id: things.id, name: things.name, version: things.version }
const row = { id: "t1", name: "n", version: 1 }

function database(handler: ScriptedHandler = () => []) {
  const scripted = createScriptedDb("mysql", handler)
  const transactions: unknown[] = []
  const db = {
    ...scripted.db,
    transaction: async (work: (tx: unknown) => Promise<unknown>, config?: unknown) => { transactions.push(config); return work(scripted.db) },
    execute: async () => [[], undefined],
  }
  return { db, ops: scripted.ops, transactions }
}
const registry = () => new DrizzleMySqlEntityRegistry().register(entity, things, columns)

describe("MySQL entity registry", () => {
  it("rejects malformed registrations and duplicates", () => {
    const fresh = () => new DrizzleMySqlEntityRegistry()
    expect(fresh().register(entity, things, columns).get("thing")?.table).toBe(things)
    expect(() => registry().register(entity, things, columns)).toThrow("Invalid or duplicate MySQL entity registration")
    expect(() => fresh().register({ name: " ", fields: { id: {} } } as never, things, columns)).toThrow("non-empty entity name")
    expect(() => fresh().register({ name: "e", fields: {} } as never, things, columns)).toThrow("must declare fields")
    expect(() => fresh().register(entity, things, { ...columns, "": things.id })).toThrow("empty column map key")
    expect(() => fresh().register(entity, things, { id: things.id })).toThrow("column map is missing fields: name, version")
    expect(() => fresh().register({ name: "e", fields: { name: {} } } as never, things, { name: things.name })).toThrow('primary key "id" is not a declared field')
    expect(() => fresh().register({ name: "e", fields: { id: {} }, versionField: "v" } as never, things, { id: things.id })).toThrow('version field "v"')
    const namespaced = fresh().register(entity, things, columns, "ns")
    expect(namespaced.get("thing", "ns")?.table).toBe(things)
    expect(namespaced.get("thing")).toBeUndefined()
  })
})

describe("MySQL persistence provider", () => {
  it("exposes repositories for registered entities only and remembers its session", async () => {
    const { db, ops } = database(() => [row])
    const provider = createDrizzleMySqlPersistenceProvider({ db: db as never, registry: registry() })
    expect(provider.dialect).toBe("mysql")
    expect(getDrizzleMySqlSession(provider)).toBe(db)
    expect(() => getDrizzleMySqlSession({} as never)).toThrow("No Drizzle MySQL session found")
    const repo = provider.repository(entity as never) as unknown as { findById(id: string): Promise<unknown> }
    expect(await repo.findById("t1")).toEqual(row)
    expect(ops[0]).toMatchObject({ kind: "select", limit: 1 })
    expect(() => provider.repository({ name: "ghost", fields: { id: {} } } as never)).toThrow("not registered in the MySQL registry")
  })

  it("validates page size and constraint map and passes them to repositories", async () => {
    const { db } = database(() => [])
    expect(() => createDrizzleMySqlPersistenceProvider({ db: db as never, registry: registry(), maxPageSize: 0 })).toThrow("maxPageSize")
    expect(() => createDrizzleMySqlPersistenceProvider({ db: db as never, registry: registry(), maxPageSize: 1.5 })).toThrow(ConfigurationError)
    expect(() => createDrizzleMySqlPersistenceProvider({ db: db as never, registry: registry(), constraintMap: [] as never })).toThrow("constraintMap")
    const duplicate = database(() => { throw Object.assign(new Error("dup"), { errno: 1062, sqlMessage: "Duplicate entry 'x' for key 'things.things_name_uq'" }) })
    const provider = createDrizzleMySqlPersistenceProvider({ db: duplicate.db as never, registry: registry(), maxPageSize: 5, constraintMap: { things_name_uq: "name" } })
    expect(provider.capabilities.maxPageSize).toBe(5)
    const repo = provider.repository(entity as never) as unknown as { insert(row: unknown): Promise<unknown> }
    const error = await repo.insert({ id: "t2", name: "n", version: 1 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).details).toMatchObject({ field: "name" })
  })

  it("advertises transaction timeouts only when a pool is reachable", () => {
    const withoutPool = createDrizzleMySqlPersistenceProvider({ db: database().db as never, registry: registry() })
    expect(withoutPool.capabilities.transactionTimeouts).toBe(false)
    const pool = { getConnection: async () => ({ query: async () => undefined, release: () => undefined }) }
    const direct = createDrizzleMySqlPersistenceProvider({ db: { ...database().db, $client: pool } as never, registry: registry() })
    expect(direct.capabilities.transactionTimeouts).toBe(true)
    const callbackStyle = createDrizzleMySqlPersistenceProvider({ db: { ...database().db, $client: { promise: () => pool } } as never, registry: registry() })
    expect(callbackStyle.capabilities.transactionTimeouts).toBe(true)
    const notAPool = createDrizzleMySqlPersistenceProvider({ db: { ...database().db, $client: { promise: () => ({}) } } as never, registry: registry() })
    expect(notAPool.capabilities.transactionTimeouts).toBe(false)
    const primitive = createDrizzleMySqlPersistenceProvider({ db: { ...database().db, $client: "x" } as never, registry: registry() })
    expect(primitive.capabilities.transactionTimeouts).toBe(false)
  })

  it("runs work in a transaction with isolation and access options, scoping repositories to it", async () => {
    const { db, ops, transactions } = database(() => [row])
    const provider = createDrizzleMySqlPersistenceProvider({ db: db as never, registry: registry() })
    const result = await provider.runInTransaction(async (scoped) => {
      const repo = scoped.repository(entity as never) as unknown as { findById(id: string): Promise<unknown> }
      return repo.findById("t1")
    }, { isolationLevel: "serializable", accessMode: "read only" })
    expect(result).toEqual(row)
    expect(transactions).toEqual([{ isolationLevel: "serializable", accessMode: "read only" }])
    expect(ops).toHaveLength(1)
    await provider.runInTransaction(async () => undefined)
    expect(transactions[1]).toBeUndefined()
  })

  it("refuses nested transactions and invalid timeouts", async () => {
    const { db } = database()
    const provider = createDrizzleMySqlPersistenceProvider({ db: db as never, registry: registry() })
    await expect(provider.runInTransaction(async (scoped) => (scoped as InteractiveTransactionProvider).runInTransaction(async () => 1))).rejects.toThrow("Nested MySQL transactions are not supported")
    await expect(provider.runInTransaction(async () => 1, { timeoutMs: 0 })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("classifies failures: deadlock at commit is a safe rollback, statement timeouts are TimeoutError", async () => {
    const commitFailure = createDrizzleMySqlPersistenceProvider({
      db: { ...database().db, transaction: async (work: (tx: unknown) => Promise<unknown>) => { await work({}); throw Object.assign(new Error("deadlock"), { errno: 1213 }) } } as never, registry: registry(),
    })
    await expect(commitFailure.runInTransaction(async () => 1)).rejects.toBeInstanceOf(TransactionRolledBackError)
    const timeout = createDrizzleMySqlPersistenceProvider({
      db: { ...database().db, transaction: async () => { throw Object.assign(new Error("slow"), { errno: 3024, code: "ER_QUERY_TIMEOUT" }) } } as never, registry: registry(),
    })
    await expect(timeout.runInTransaction(async () => 1)).rejects.toBeInstanceOf(TimeoutError)
  })
})

describe("MySQL audit and outbox sinks", () => {
  const actor = { id: "u", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }
  const auditRecord = { id: "a1", occurredAt: new Date("2026-01-01T00:00:00.000Z"), action: "update", resourceType: "thing", resourceId: "t1", actor, tenantId: "t1", oldValue: { a: 1 }, newValue: null } as unknown as AuditRecord
  const scopeId = "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never
  const outboxRecord = { id: "o1", type: "thing.updated", version: 1, scope: { kind: "platform", platformKey: "test" }, scopeId, aggregateType: "thing", aggregateId: "t1", payload: { n: 1 }, idempotencyKey: "k1", occurredAt: new Date(), tenantId: null } as unknown as OutboxRecord

  it("writes audit rows through the provider's session", async () => {
    const { db, ops } = database(() => ({ affectedRows: 1 }))
    const provider = createDrizzleMySqlPersistenceProvider({ db: db as never, registry: registry() })
    await createDrizzleMySqlAuditSinkFactory(audit).create(provider).write(auditRecord)
    expect(ops[0]!.values).toMatchObject({ id: "a1", tenantId: "t1", action: "update", actorId: "u", actorType: "human", resourceId: "t1", oldValue: { a: 1 }, newValue: null, metadata: null })
    await new DrizzleMySqlAuditSink(db as never, audit).write({ ...auditRecord, metadata: { m: 1 } } as never)
    expect(ops[1]!.values).toMatchObject({ metadata: { m: 1 } })
  })

  it("appends outbox rows with a deterministic fingerprint and checks replays against the stored one", async () => {
    let stored: string | undefined
    const { db, ops } = database((op) => {
      if (op.kind === "insert") { stored ??= (op.values as { eventFingerprint: string }).eventFingerprint; return { affectedRows: 1 } }
      return stored === undefined ? [] : [{ eventFingerprint: stored }]
    })
    const sink = new DrizzleMySqlOutboxSink(db as never, outbox, (record) => ({ type: record.type }))
    await sink.append(outboxRecord)
    expect(ops[0]!.values).toMatchObject({ id: "o1", idempotencyScope: scopeId, idempotencyKey: "k1", type: "thing.updated", tenantId: null, provenance: null })
    expect(String((ops[0]!.values as { eventFingerprint: string }).eventFingerprint)).toMatch(/^v3:/)
    await expect(sink.append({ ...outboxRecord, id: "o2" } as OutboxRecord)).resolves.toBeUndefined()
    await expect(sink.append({ ...outboxRecord, payload: { n: 2 } } as OutboxRecord)).rejects.toBeInstanceOf(ConflictError)
    const provider = createDrizzleMySqlPersistenceProvider({ db: db as never, registry: registry() })
    expect(createDrizzleMySqlOutboxSinkFactory(outbox, () => ({})).create(provider)).toBeInstanceOf(DrizzleMySqlOutboxSink)
  })

  it("rejects mappers that override framework-owned columns, bad tables and vanished conflict rows", async () => {
    const { db } = database(() => [])
    await expect(new DrizzleMySqlOutboxSink(db as never, outbox, () => ({ idempotencyKey: "other" })).append(outboxRecord)).rejects.toThrow("cannot override the framework-owned idempotencyKey")
    await expect(new DrizzleMySqlOutboxSink(db as never, audit, () => ({})).append(outboxRecord)).rejects.toThrow("MySQL outbox requires id")
    await expect(new DrizzleMySqlOutboxSink(db as never, outbox, () => ({})).append(outboxRecord)).rejects.toThrow("conflict row disappeared")
    const tenantScoped = mysqlTable("outbox2", { id: varchar("id", { length: 36 }), tenantId: varchar("tenant_id", { length: 64 }), idempotencyKey: varchar("idempotency_key", { length: 64 }), eventFingerprint: varchar("event_fingerprint", { length: 128 }) })
    let fingerprint = ""
    const scripted = database((op) => { if (op.kind === "insert") { fingerprint = (op.values as { eventFingerprint: string }).eventFingerprint; return { affectedRows: 1 } } return [{ eventFingerprint: fingerprint }] })
    await new DrizzleMySqlOutboxSink(scripted.db as never, tenantScoped, () => ({})).append({ ...outboxRecord, tenantId: "t1" } as OutboxRecord)
    expect(scripted.ops[0]!.values).toMatchObject({ tenantId: "t1" })
    expect(scripted.ops[0]!.values).not.toHaveProperty("idempotencyScope")
  })
})
