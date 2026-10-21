import { afterAll, beforeAll, describe } from "vitest"
import { DrizzleD1TemporalHistoryStore } from "@xonava/adapters/drizzle-d1"
import { openD1Fixture, type D1Fixture } from "./database.js"
import {
  defineConcurrentAppends, defineConcurrentLifecycle, defineSnapshotEquivalence, defineTemporalDifferential, type TemporalStoreDifferentialDriver,
} from "../shared/temporalStoreDifferential.js"
import type { Kind, State } from "../shared/temporalStoreDifferentialModel.js"

describe("D1 temporal store differential", () => {
  let fixture: D1Fixture
  const db = () => fixture.db
  const all = async (sql: string) => ((await db().prepare(sql).all()).results ?? []) as Record<string, unknown>[]
  const json = (value: unknown): State | null => (value == null ? null : (JSON.parse(String(value)) as State))
  const num = (value: unknown): number | null => (value == null ? null : Number(value))
  const id = (r: Record<string, unknown>) => ({ scopeId: r.scope_id as string, entityType: r.entity_type as string, entityId: r.entity_id as string })
  // The store is created lazily so the Miniflare database (with the migrated framework_temporal_* tables) exists by the time a property runs.
  const store = () => new DrizzleD1TemporalHistoryStore<State>(db() as never)
  const driver: TemporalStoreDifferentialDriver = {
    label: "d1",
    store: {
      append: (value) => store().append(value),
      saveSnapshot: (value) => store().saveSnapshot(value),
      latestSnapshot: (resource, asOf) => store().latestSnapshot(resource, asOf),
      revisions: (resource, options) => store().revisions(resource, options),
    },
    conflictErrors: false,
    lifecycleRuns: 50,
    concurrencyRuns: 50,
    light: true,
    maxWorkers: 6,
    reset: async () => {
      for (const table of ["framework_temporal_snapshots", "framework_temporal_revisions", "framework_temporal_heads"]) await db().prepare(`DELETE FROM ${table}`).run()
    },
    dump: async () => ({
      heads: (await all("SELECT scope_id, entity_type, entity_id, revision, occurred_at_ms, kind FROM framework_temporal_heads")).map((r) => ({ ...id(r), revision: Number(r.revision), at: Number(r.occurred_at_ms), kind: r.kind as Kind })),
      revisions: (await all("SELECT scope_id, entity_type, entity_id, revision, occurred_at_ms, kind, state, entity_version, event_id, audit_id FROM framework_temporal_revisions")).map((r) => ({ ...id(r), revision: Number(r.revision), at: Number(r.occurred_at_ms), kind: r.kind as Kind, state: json(r.state), version: num(r.entity_version), eventId: (r.event_id as string | null) ?? null, auditId: (r.audit_id as string | null) ?? null })),
      snapshots: (await all("SELECT scope_id, entity_type, entity_id, revision, occurred_at_ms, state FROM framework_temporal_snapshots")).map((r) => ({ ...id(r), revision: Number(r.revision), at: Number(r.occurred_at_ms), state: json(r.state) })),
    }),
  }

  beforeAll(async () => { fixture = await openD1Fixture() })
  afterAll(async () => { await fixture?.close() })

  defineTemporalDifferential(driver)
  defineSnapshotEquivalence(driver)
  defineConcurrentAppends(driver)
  defineConcurrentLifecycle(driver)
})
