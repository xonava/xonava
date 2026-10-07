import { describe, expect, it } from "vitest"
import pg from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import { createDrizzlePersistenceProvider } from "adapters/drizzle-pg"
import { Predicate, RetryablePersistenceError, TimeoutError, TransactionRolledBackError } from "core/domain"
import { createOperationContext, runOperation } from "core/operation"
import type { PersistenceProvider, UnversionedEntityDescriptor } from "core/persistence"
import { pgCertificationUrl } from "./database.js"

const items = pgTable("framework_tx_items", { id: text("id").primaryKey(), bucket: text("bucket").notNull(), amount: integer("amount").notNull() })
const slow = pgTable("framework_tx_slow", { id: text("id").primaryKey(), bucket: text("bucket").notNull(), amount: integer("amount").notNull() })
type Item = { id: string; bucket: string; amount: number }
const fields = { id: { type: "string" as const }, bucket: { type: "string" as const }, amount: { type: "integer" as const } }
const itemEntity: UnversionedEntityDescriptor<Item> = { name: "txItem", primaryKey: "id", fields }
const slowEntity: UnversionedEntityDescriptor<Item> = { name: "txSlow", primaryKey: "id", fields }

async function withProvider<T>(work: (provider: ReturnType<typeof createDrizzlePersistenceProvider>) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: pgCertificationUrl(), max: 4 })
  try {
    await pool.query("DROP VIEW IF EXISTS framework_tx_slow; DROP TABLE IF EXISTS framework_tx_items")
    await pool.query("CREATE TABLE framework_tx_items (id text PRIMARY KEY, bucket text NOT NULL, amount integer NOT NULL)")
    await pool.query("CREATE VIEW framework_tx_slow AS SELECT i.* FROM framework_tx_items i, pg_sleep(2)")
    await pool.query("INSERT INTO framework_tx_items VALUES ('seed','b',1)")
    const registry = { get: (name: string) => name === "txItem" ? { table: items, columnMap: { id: items.id, bucket: items.bucket, amount: items.amount } } : name === "txSlow" ? { table: slow, columnMap: { id: slow.id, bucket: slow.bucket, amount: slow.amount } } : undefined }
    return await work(createDrizzlePersistenceProvider({ db: drizzle(pool), registry: registry as never }))
  } finally {
    await pool.query("DROP VIEW IF EXISTS framework_tx_slow; DROP TABLE IF EXISTS framework_tx_items").catch(() => undefined)
    await pool.end()
  }
}

/** Two serializable transactions that each read the bucket and insert into it: classic write skew. */
function writeSkew(provider: ReturnType<typeof createDrizzlePersistenceProvider>, id: string, barrier: { arrive(): Promise<void> }) {
  return provider.runInTransaction(async (tx) => {
    const repository = tx.repository<Item>(itemEntity)
    const rows = await repository.findMany({ filter: Predicate.eq("bucket", "b") })
    await barrier.arrive()
    await repository.insert({ id, bucket: "b", amount: rows.rows.length })
    await barrier.arrive()
    return id
  }, { isolationLevel: "serializable" })
}

function barrier(parties: number) {
  let waiting: (() => void)[] = []
  return { arrive: () => new Promise<void>((resolve) => { waiting.push(resolve); if (waiting.length === parties) { const release = waiting; waiting = []; release.forEach((fn) => fn()) } }) }
}

describe("PostgreSQL transaction outcome classification", () => {
  it("reports a serialization failure at COMMIT as TransactionRolledBackError, never a raw driver error", async () => {
    await withProvider(async (provider) => {
      expect(provider.capabilities.transactionTimeouts).toBe(true)
      const sync = barrier(2)
      const outcomes = await Promise.allSettled([writeSkew(provider, "x", sync), writeSkew(provider, "y", sync)])
      const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
      expect(failures).toHaveLength(1)
      expect(failures[0]!.reason).toBeInstanceOf(RetryablePersistenceError)
      expect(failures[0]!.reason).toBeInstanceOf(TransactionRolledBackError)
      expect(String(failures[0]!.reason.message)).not.toMatch(/framework_tx_items|INSERT|select/i)
    })
  }, 30_000)

  it("lets the operation pipeline re-run the rolled-back transaction to success", async () => {
    await withProvider(async (provider) => {
      const sync = barrier(2)
      let attempts = 0
      const run = (id: string) => runOperation({
        operation: createOperationContext({ persistence: provider, runtimeCapabilities: { deferredExecution: true } as never }),
        definition: {
          key: `skew-${id}`, kind: "mutation", authorization: { authorize: async () => ({ allowed: true }) },
          atomicity: { kind: "standard", mode: "required", transactionOptions: { isolationLevel: "serializable" } },
          execution: { kind: "retryable-transaction", maxAttempts: 3, delay: 1, backoff: 2, maxDelay: 10 },
          execute: async ({ operation }: { operation: { persistence: PersistenceProvider } }) => {
            attempts++
            const repository = operation.persistence.repository<Item>(itemEntity)
            const rows = await repository.findMany({ filter: Predicate.eq("bucket", "b") })
            if (attempts <= 2) await sync.arrive()
            await repository.insert({ id, bucket: "b", amount: rows.rows.length })
            if (attempts <= 2) await sync.arrive()
            return id
          },
        },
        input: {},
      })
      await expect(Promise.all([run("p"), run("q")])).resolves.toEqual(["p", "q"])
      expect(attempts).toBe(3)
    })
  }, 30_000)

  it("bounds a hung statement by the transaction deadline and reports TIMEOUT", async () => {
    await withProvider(async (provider) => {
      const started = Date.now()
      await expect(provider.runInTransaction(async (tx) => tx.repository<Item>(slowEntity).findMany({}), { timeoutMs: 200 })).rejects.toBeInstanceOf(TimeoutError)
      expect(Date.now() - started).toBeLessThan(1_500)
      await expect(provider.runInTransaction(async (tx) => (await tx.repository<Item>(itemEntity).findMany({})).rows.length, { timeoutMs: 5_000 })).resolves.toBe(1)
    })
  }, 30_000)
})
