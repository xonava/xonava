import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgSchema, text } from "drizzle-orm/pg-core"
import { createDrizzlePersistenceProvider, createDrizzleRepository, createPgSession } from "adapters/drizzle-pg"
import { ConflictError, FrameworkCoreError, Predicate, TimeoutError } from "core/domain"
import type { UnversionedEntityDescriptor } from "core/persistence"
import { pgCertificationUrl } from "./database.js"

const SCHEMA = "adapter_errors_it"
const items = pgSchema(SCHEMA).table("items", { id: text("id").primaryKey(), bucket: text("bucket").notNull(), amount: integer("amount").notNull() })
type Item = { id: string; bucket: string; amount: number }
const entity: UnversionedEntityDescriptor<Item> = { name: "errItem", primaryKey: "id", fields: { id: { type: "string" }, bucket: { type: "string" }, amount: { type: "integer" } } }
const columnMap = { id: items.id, bucket: items.bucket, amount: items.amount }

describe("PostgreSQL adapter error normalization against a real database", () => {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 4 })
  const db = drizzle(pool)
  const provider = createDrizzlePersistenceProvider({ db, registry: { get: () => ({ table: items, columnMap }) } as never })

  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}; CREATE TABLE ${SCHEMA}.items(id text primary key, bucket text not null, amount int not null, CONSTRAINT items_bucket_unique UNIQUE (bucket)); INSERT INTO ${SCHEMA}.items VALUES ('a','b',1)`)
  })
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); await pool.end() })

  it("a lock wait that exceeds the transaction deadline surfaces as TimeoutError", async () => {
    const locker = await pool.connect()
    try {
      await locker.query("BEGIN")
      await locker.query(`SELECT * FROM ${SCHEMA}.items WHERE id='a' FOR UPDATE`)
      const failure = await provider.runInTransaction(async (tx) => tx.repository<Item>(entity).update("a", { amount: 2 }), { timeoutMs: 300 }).then(() => null, (error: unknown) => error)
      expect(failure).toBeInstanceOf(TimeoutError)
    } finally {
      await locker.query("ROLLBACK")
      locker.release()
    }
  })

  it("repository reads never leak raw driver errors", async () => {
    const repository = provider.repository<Item>(entity)
    await pool.query(`ALTER TABLE ${SCHEMA}.items RENAME COLUMN amount TO amt`)
    try {
      for (const read of [() => repository.findById("a"), () => repository.findMany({}), () => repository.findOneWhere!(Predicate.eq("id", "a"))]) {
        const failure = await read().then(() => null, (error: unknown) => error)
        expect(failure).toBeInstanceOf(FrameworkCoreError)
        expect(String((failure as Error).message)).not.toMatch(/select|amount|items/i)
      }
    } finally {
      await pool.query(`ALTER TABLE ${SCHEMA}.items RENAME COLUMN amt TO amount`)
    }
  })

  it("constraintMap attaches the mapped field to unique violations", async () => {
    const repository = createDrizzleRepository<Item>({ db: createPgSession(db as never), table: items, entity, columnMap, constraintMap: { items_bucket_unique: "bucket" } })
    const failure = await repository.insert({ id: "z", bucket: "b", amount: 1 }).then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(ConflictError)
    expect((failure as ConflictError).details).toMatchObject({ field: "bucket" })
  })
})
