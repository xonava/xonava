import { afterAll, beforeAll, describe } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { createDrizzleD1IdempotencyStore, createDrizzlePersistenceProvider, D1_IDEMPOTENCY_ASSERTION_CAPABILITY, DrizzleEntityRegistry, type DrizzleD1Command } from "@xonava/adapters/drizzle-d1"
import type { AtomicBatchPlan, AtomicBatchResult } from "@xonava/core/persistence"
import { openD1Fixture, type D1Fixture } from "./database.js"
import { defineConcurrentAcquireRaces, defineConcurrentFinalizerClaims, defineConcurrentOwnershipRaces } from "../shared/idempotencyStoreDifferentialConcurrency.js"
import { canonicalJson } from "../shared/idempotencyStoreDifferentialModel.js"
import { defineIdempotencyDifferential, defineIdempotencyRegressions, printCoverage, type IdempotencyDifferentialDriver, type IdempotencyStore, type RawIdempotencyRow } from "../shared/idempotencyStoreDifferential.js"

const idempotency = sqliteTable("df_idempotency", {
  id: text("id").primaryKey(), scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"), status: text("status"),
  result: text("result"), resourceEntity: text("resource_entity"), resourceId: text("resource_id"), resourceVersion: text("resource_version"),
  pendingInvalidations: text("pending_invalidations"), finalizerClaimOwner: text("finalizer_claim_owner"), finalizerClaimToken: text("finalizer_claim_token"),
  finalizerClaimExpiresAt: integer("finalizer_claim_expires_at"), createdAt: integer("created_at"), completedAt: integer("completed_at"),
})
const assertions = Object.assign(sqliteTable("df_idempotency_assertions", {
  scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), token: text("token"),
  expectedAffectedRows: integer("expected_affected_rows"), actualAffectedRows: integer("actual_affected_rows"),
}), { idempotencyAssertionCapability: D1_IDEMPOTENCY_ASSERTION_CAPABILITY })

const SCHEMA = [
  "CREATE TABLE df_idempotency (id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL, result TEXT, resource_entity TEXT, resource_id TEXT, resource_version TEXT, pending_invalidations TEXT, finalizer_claim_owner TEXT, finalizer_claim_token TEXT, finalizer_claim_expires_at INTEGER, created_at INTEGER NOT NULL, completed_at INTEGER, UNIQUE (scope, key))",
  "CREATE TABLE df_idempotency_assertions (scope TEXT, key TEXT, fingerprint TEXT, token TEXT, expected_affected_rows INTEGER, actual_affected_rows INTEGER, CHECK (expected_affected_rows IS NULL OR expected_affected_rows = actual_affected_rows))",
  "CREATE TRIGGER df_idempotency_fence BEFORE INSERT ON df_idempotency_assertions WHEN NEW.expected_affected_rows IS NULL AND NOT EXISTS (SELECT 1 FROM df_idempotency WHERE scope = NEW.scope AND key = NEW.key AND fingerprint = NEW.fingerprint AND token = NEW.token AND status = 'in-progress') BEGIN SELECT RAISE(ABORT, 'idempotency ownership lost'); END",
]
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"

type AtomicProvider = { executeAtomicBatch(plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult> }

function canonicalOf(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  try { return canonicalJson(JSON.parse(raw as string)) } catch { return canonicalJson(raw) }
}

describe("D1 idempotency store differential", () => {
  let fixture: D1Fixture
  let realStore: ReturnType<typeof createDrizzleD1IdempotencyStore<unknown>>
  let provider: AtomicProvider
  // The store is created after the Miniflare database exists (beforeAll), so the driver delegates lazily.
  const store = new Proxy({} as IdempotencyStore, { get: (_target, property) => (...args: unknown[]) => ((realStore as never)[property as never] as (...a: unknown[]) => unknown)(...args) })
  const all = async (sql: string, ...params: unknown[]) => ((await fixture.db.prepare(sql).bind(...params).all()).results ?? []) as Record<string, unknown>[]
  const run = async (sql: string, ...params: unknown[]) => { await fixture.db.prepare(sql).bind(...params).run() }
  const driver: IdempotencyDifferentialDriver = {
    label: "d1",
    store,
    commit: async (item) => { await provider.executeAtomicBatch({ items: [realStore.createCommitBatchItem(item) as never] }) },
    reset: async () => { await run("DELETE FROM df_idempotency") },
    expireLease: async (scope, key) => { await run(`UPDATE df_idempotency SET created_at = ${NOW_MS} - 7200000 WHERE scope = ? AND key = ?`, scope, key) },
    expireClaim: async (scope, key) => { await run(`UPDATE df_idempotency SET finalizer_claim_expires_at = ${NOW_MS} - 3600000 WHERE scope = ? AND key = ? AND finalizer_claim_token IS NOT NULL`, scope, key) },
    corruptInvalidations: async (scope, key) => { await run("UPDATE df_idempotency SET pending_invalidations = 'not json' WHERE scope = ? AND key = ?", scope, key) },
    light: true,
    runs: 50,
    concurrencyRuns: 50,
    dump: async (): Promise<RawIdempotencyRow[]> => (await all("SELECT * FROM df_idempotency")).map((r) => ({
      scope: r.scope as string, key: r.key as string, fingerprint: r.fingerprint as string, token: r.token as string, status: r.status as string,
      result: canonicalOf(r.result), resourceEntity: r.resource_entity as string | null, resourceId: r.resource_id as string | null,
      resourceVersion: r.resource_version === null ? null : (JSON.parse(r.resource_version as string) as { value: number }).value,
      pendingInvalidations: canonicalOf(r.pending_invalidations), finalizerClaimOwner: r.finalizer_claim_owner as string | null,
      finalizerClaimToken: r.finalizer_claim_token as string | null, hasClaimExpiry: r.finalizer_claim_expires_at !== null, hasCompletedAt: r.completed_at !== null,
    })),
  }

  beforeAll(async () => {
    fixture = await openD1Fixture()
    for (const statement of SCHEMA) await fixture.db.exec(statement)
    const db = drizzle(fixture.db as never)
    realStore = createDrizzleD1IdempotencyStore<unknown>(db as never, idempotency) as never
    provider = createDrizzlePersistenceProvider({ db, registry: new DrizzleEntityRegistry(), idempotencyTable: idempotency, idempotencyAssertionTable: assertions } as never) as unknown as AtomicProvider
  })
  afterAll(async () => { printCoverage("d1"); await fixture?.close() })

  defineIdempotencyRegressions(driver)
  defineIdempotencyDifferential(driver)
  defineConcurrentAcquireRaces(driver)
  defineConcurrentOwnershipRaces(driver)
  defineConcurrentFinalizerClaims(driver)
})
