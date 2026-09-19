import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { getTableName } from "drizzle-orm"
import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry, D1_IDEMPOTENCY_ASSERTION_CAPABILITY, type DrizzleD1Command } from "../index"
import type { AtomicBatchPlan, AtomicBatchResult } from "core/persistence"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"

type Statement = { toSQL: () => { sql: string; params: readonly unknown[] }; run: (db: DatabaseSync) => unknown }
const sqliteValue = (value: unknown): unknown => value instanceof Date ? value.toISOString() : (typeof value === "object" && value !== null ? null : value)

const table = (name: string, columns: Record<string, unknown> = {}) => ({ name, ...columns }) as unknown as AnySQLiteTable
const generationTable = table("tag_generations", { tag: {}, generation: {} })
const auditTable = table("audit")
const outboxTable = sqliteTable("outbox", {
  id: text("id").primaryKey(),
  idempotencyScope: text("idempotency_scope"),
  idempotencyKey: text("idempotency_key"),
  eventFingerprint: text("event_fingerprint"),
}, (columns) => [uniqueIndex("outbox_scope_key").on(columns.idempotencyScope, columns.idempotencyKey)])
const idempotencyTable = table("idempotency_records")
const assertionTable = table("idempotency_assertions", { idempotencyAssertionCapability: D1_IDEMPOTENCY_ASSERTION_CAPABILITY })

function insertStatement(target: AnySQLiteTable, values: Record<string, unknown>): Statement {
  const name = (target as unknown as { name?: string }).name ?? getTableName(target)
  const keys = Object.keys(values)
  return {
    toSQL: () => ({ sql: `INSERT INTO ${name} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, params: keys.map((key) => values[key]) }),
    run: (db) => db.prepare(`INSERT INTO ${name} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => sqliteValue(values[key])) as never[]),
  }
}

function createRealD1() {
  const sqlite = new DatabaseSync(":memory:")
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE business (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tag_generations (tag TEXT PRIMARY KEY, generation INTEGER NOT NULL);
    CREATE TABLE cache_payload (tag TEXT NOT NULL, generation INTEGER NOT NULL, cacheKey TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE audit (id TEXT PRIMARY KEY, createdAt TEXT, tenantId TEXT, action TEXT NOT NULL, resourceType TEXT, resourceId TEXT, actorId TEXT, actorType TEXT, impersonatedByAdminId TEXT, oldValue TEXT, newValue TEXT, metadata TEXT);
     CREATE TABLE outbox (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT, idempotencyScope TEXT NOT NULL, idempotencyKey TEXT NOT NULL UNIQUE, eventFingerprint TEXT NOT NULL);
    CREATE TABLE idempotency_records (id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL, result TEXT, resourceEntity TEXT, resourceId TEXT, resourceVersion TEXT, pendingInvalidations TEXT, completedAt INTEGER, UNIQUE(scope, key));
    CREATE TABLE idempotency_assertions (scope TEXT, key TEXT, fingerprint TEXT, token TEXT);
    CREATE TRIGGER assert_idempotency_owner BEFORE INSERT ON idempotency_assertions
      WHEN NOT EXISTS (SELECT 1 FROM idempotency_records WHERE scope = NEW.scope AND key = NEW.key AND fingerprint = NEW.fingerprint AND token = NEW.token AND status = 'in-progress')
      BEGIN SELECT RAISE(ABORT, 'lost idempotency ownership'); END;
  `)

  const raw = {
    batch: async (statements: readonly Statement[]) => {
      sqlite.exec("BEGIN")
      try {
        const results = statements.map((statement) => statement.run(sqlite))
        sqlite.exec("COMMIT")
        return results.map((result) => ({ meta: { changes: Number((result as { changes?: number }).changes ?? 0) } }))
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
    insert: (target: AnySQLiteTable) => ({
      values: (values: Record<string, unknown>) => {
        const base = insertStatement(target, values)
        return {
          ...base,
          onConflictDoUpdate: ({ set: _set }: { set: { generation: unknown } }) => ({
            toSQL: () => ({ sql: "INSERT INTO tag_generations (tag,generation) VALUES (?,1) ON CONFLICT(tag) DO UPDATE SET generation = generation + 1", params: [values.tag] }),
            run: (db: DatabaseSync) => db.prepare("INSERT INTO tag_generations (tag,generation) VALUES (?,1) ON CONFLICT(tag) DO UPDATE SET generation = generation + 1").run(values.tag as string),
          }),
        }
      },
    }),
    update: (target: AnySQLiteTable) => ({
      set: (values: Record<string, unknown>) => ({
        where: (_filter: unknown) => {
          const name = (target as unknown as { name: string }).name
          const keys = Object.keys(values)
          return {
            toSQL: () => ({ sql: `UPDATE ${name} SET ${keys.map((key) => `${key} = ?`).join(",")}`, params: keys.map((key) => values[key]) }),
            run: (db: DatabaseSync) => db.prepare(`UPDATE ${name} SET ${keys.map((key) => `${key} = ?`).join(",")}`).run(...keys.map((key) => sqliteValue(values[key])) as never[]),
          }
        },
      }),
    }),
    select: () => ({ from: (target: AnySQLiteTable) => ({ where: () => ({ limit: async () =>
      getTableName(target) === "sqlite_master"
        ? [{ triggerSql: "CREATE TRIGGER idempotency_commit_ownership_fence BEFORE INSERT ON idempotency_assertions WHEN NEW.expected_affected_rows IS NULL AND NOT EXISTS (SELECT 1 FROM idempotency_records WHERE scope = NEW.scope AND key = NEW.key AND fingerprint = NEW.fingerprint AND token = NEW.token AND status = 'in-progress') BEGIN SELECT RAISE(ABORT, 'idempotency ownership lost'); END" }]
        : [] }) }) }),
  }
  return { sqlite, raw }
}

function command(sql: string, params: readonly unknown[] = []): DrizzleD1Command {
  return { toSQL: () => ({ sql, params }), run: (db: DatabaseSync) => db.prepare(sql).run(...params as never[]) } as unknown as DrizzleD1Command
}

function execute(provider: ReturnType<typeof createDrizzlePersistenceProvider>, plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult> {
  return (provider as typeof provider & { executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult> }).executeAtomicBatch(plan)
}

describe("D1 cache-generation atomicity proof", () => {
  it("commits business, generation, audit, outbox, and receipt together; rollback preserves both business and generation", async () => {
    const { sqlite, raw } = createRealD1()
    sqlite.prepare("INSERT INTO business VALUES (?, ?)").run("row-1", "old")
    sqlite.prepare("INSERT INTO tag_generations VALUES (?, ?)").run("rows", 7)
    sqlite.prepare("INSERT INTO cache_payload VALUES (?, ?, ?, ?)").run("rows", 7, "row-1", "old-cache")
    sqlite.prepare("INSERT INTO idempotency_records (id,scope,key,fingerprint,token,status) VALUES (?,?,?,?,?,?)").run("idem-1", "scope", "key-1", "fp-1", "token-1", "in-progress")
    const provider = createDrizzlePersistenceProvider({
      db: raw as never,
      registry: new DrizzleEntityRegistry(),
      tagGenerationTable: generationTable,
      auditTable,
      outboxTable,
      mapOutboxRecord: (record) => ({ type: record.type, idempotencyKey: record.idempotencyKey, payload: "{}" }),
      idempotencyTable,
      idempotencyAssertionTable: assertionTable,
    })

    await execute(provider, { items: [
      { kind: "command", command: command("UPDATE business SET value = ? WHERE id = ?", ["new", "row-1"]) },
      { kind: "cache-generation", tag: "rows" },
      { kind: "audit", record: { id: "audit-1", occurredAt: new Date(), action: "update", resourceType: "business", resourceId: "row-1", actor: { id: "actor", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }, tenantId: null, oldValue: null, newValue: null } },
      { kind: "outbox", record: { id: "outbox-1", type: "business.updated", version: 1, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never, aggregateType: "business", aggregateId: "row-1", payload: {}, idempotencyKey: "event-1", occurredAt: new Date() } },
      { kind: "idempotency", commit: { scope: "scope", key: "key-1", fingerprint: "fp-1", token: "token-1", invalidations: ["rows"] } },
    ] })

    expect(sqlite.prepare("SELECT value FROM business WHERE id = ?").get("row-1")).toMatchObject({ value: "new" })
    expect(sqlite.prepare("SELECT generation FROM tag_generations WHERE tag = ?").get("rows")).toMatchObject({ generation: 8 })
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache_payload WHERE tag = ? AND generation = (SELECT generation FROM tag_generations WHERE tag = ?)").get("rows", "rows")).toMatchObject({ count: 0 })
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM audit").get()).toMatchObject({ count: 1 })
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM outbox").get()).toMatchObject({ count: 1 })
    expect(sqlite.prepare("SELECT status, pendingInvalidations FROM idempotency_records WHERE key = ?").get("key-1")).toMatchObject({ status: "business-committed", pendingInvalidations: '["rows"]' })

    sqlite.prepare("INSERT INTO idempotency_records (id,scope,key,fingerprint,token,status) VALUES (?,?,?,?,?,?)").run("idem-2", "scope", "key-2", "fp-2", "token-2", "in-progress")
    await expect(execute(provider, { items: [
      { kind: "command", command: command("UPDATE business SET value = ? WHERE id = ?", ["must-rollback", "row-1"]) },
      { kind: "cache-generation", tag: "rows" },
      { kind: "audit", record: { id: "audit-1", occurredAt: new Date(), action: "duplicate", resourceType: "business", resourceId: "row-1", actor: { id: "actor", kind: "human", authentication: { kind: "authenticated", method: "test", authenticatedAt: "2026-09-10T00:00:00.000Z" } }, tenantId: null, oldValue: null, newValue: null } },
      { kind: "idempotency", commit: { scope: "scope", key: "key-2", fingerprint: "fp-2", token: "token-2" } },
    ] })).rejects.toThrow()
    expect(sqlite.prepare("SELECT value FROM business WHERE id = ?").get("row-1")).toMatchObject({ value: "new" })
    expect(sqlite.prepare("SELECT generation FROM tag_generations WHERE tag = ?").get("rows")).toMatchObject({ generation: 8 })
  })
})
