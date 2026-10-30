import { describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core"
import { ConfigurationError, ConflictError } from "@xonava/core/domain"
import type { OutboxRecord } from "@xonava/core/events"
import type { AtomicBatchPlan } from "@xonava/core/persistence"
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry, type DrizzleD1Command } from "@xonava/adapters/drizzle-d1"
import { createFakeD1 } from "../../__tests__/support/fakeD1"
import { assertions, audit, auditRecord, FENCE, idempotency, outbox, plainItems, SCHEMA, type AtomicProvider } from "./sqliteFixture"
import { validateD1AtomicOutboxColumns } from "../d1OutboxSchema"

const LOST = "Idempotency ownership was lost before the mutation committed"
const inProgress = "INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','fp','tok','in-progress')"
const mixedPlan = { items: [{ kind: "audit", record: auditRecord("aud-z") }, { kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } }] } as unknown as AtomicBatchPlan<DrizzleD1Command>
const auditPlan = { items: [{ kind: "audit", record: auditRecord("aud-w") }] } as unknown as AtomicBatchPlan<DrizzleD1Command>

function build(options: { db?: (raw: ReturnType<typeof drizzle>) => unknown; args?: Record<string, unknown> } = {}) {
  const d1 = createFakeD1([...SCHEMA])
  d1.sqlite.exec(FENCE)
  const raw = drizzle(d1 as never)
  const provider = createDrizzlePersistenceProvider({
    db: (options.db ? options.db(raw) : raw) as never, registry: new DrizzleEntityRegistry(), auditTable: audit, outboxTable: outbox, idempotencyTable: idempotency,
    idempotencyAssertionTable: assertions, mutationAssertionTable: assertions,
    mapOutboxRecord: (record: OutboxRecord) => ({ type: record.type }),
    ...options.args,
  }) as AtomicProvider
  return { d1, raw, provider }
}
const rejecting = (error: unknown) => (raw: ReturnType<typeof drizzle>) => new Proxy(raw, { get: (target, prop) => (prop === "batch" ? () => Promise.reject(error) : Reflect.get(target, prop)) })
const statementPlan = (raw: ReturnType<typeof drizzle>, expectedAffectedRows: number): AtomicBatchPlan<DrizzleD1Command> => ({
  items: [{ kind: "command", command: { kind: "statement", statement: raw.insert(plainItems).values({ id: "p1", label: "l" }), expectedAffectedRows } }],
}) as never

describe("d1 batch plan commands that are not executable queries", () => {
  it("rejects primitive and method-less commands with the executable-query message and ignores an absent one", async () => {
    const { provider } = build()
    const expected = new ConfigurationError("D1 atomic batches require executable Drizzle queries with a toSQL method")
    await expect(provider.executeAtomicBatch({ items: [{ kind: "command", command: null }] } as never)).resolves.toEqual([])
    for (const command of ["select 1", 5, {}, { kind: "select" }]) {
      await expect(provider.executeAtomicBatch({ items: [{ kind: "command", command }] } as never)).rejects.toThrow(expected)
    }
  })
})

describe("d1 batch failure inspection edge cases", () => {
  it("tolerates a null cause at the end of the chain", async () => {
    const f = build({ db: rejecting(new Error("outer failure", { cause: null })) })
    const error = await f.provider.executeAtomicBatch(auditPlan).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).not.toBe("TypeError")
  })

  it("does not treat a unique violation in an idempotency plan as lost ownership", async () => {
    const f = build({ db: rejecting(new Error("D1_ERROR: UNIQUE constraint failed: dx_audit.id: SQLITE_CONSTRAINT")) })
    f.d1.sqlite.exec(inProgress)
    const error = (await f.provider.executeAtomicBatch(mixedPlan).catch((e: unknown) => e)) as ConflictError
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.message).not.toBe(LOST)
    expect(error.details).not.toMatchObject({ reason: "idempotency-fence" })
  })
})

describe("d1 write assertion rows", () => {
  it("require a table that exposes both row-count columns", async () => {
    const expected = new ConfigurationError("mutationAssertionTable must expose expectedAffectedRows and actualAffectedRows columns")
    const noActual = sqliteTable("dx_assertions", { scope: text("scope"), key: text("key"), expectedAffectedRows: integer("expected_affected_rows") })
    const noExpected = sqliteTable("dx_assertions", { scope: text("scope"), key: text("key"), actualAffectedRows: integer("actual_affected_rows") })
    const neither = sqliteTable("dx_assertions", { scope: text("scope"), key: text("key") })
    for (const table of [noActual, noExpected, neither]) {
      const f = build({ args: { mutationAssertionTable: table } })
      await expect(f.provider.executeAtomicBatch(statementPlan(f.raw, 1))).rejects.toThrow(expected)
    }
  })

  it("record a unique marker row per assertion with the expected and actual row counts", async () => {
    const f = build()
    await f.provider.executeAtomicBatch(statementPlan(f.raw, 1))
    await f.provider.executeAtomicBatch({ items: [{ kind: "command", command: { kind: "statement", statement: f.raw.insert(plainItems).values({ id: "p2", label: "l" }), expectedAffectedRows: 1 } }] } as never)
    const rows = f.d1.sqlite.prepare("SELECT scope, key, fingerprint, token, expected_affected_rows AS e, actual_affected_rows AS a FROM dx_assertions ORDER BY key").all() as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row).toMatchObject({ scope: "__mutation__", fingerprint: "", token: "", e: 1, a: 1 })
      expect(String(row.key)).toMatch(/^mutation-[0-9a-f-]{36}$/)
    }
    expect(rows[0]!.key).not.toBe(rows[1]!.key)
  })
})

describe("d1 outbox identity constraint width", () => {
  it("rejects a unique constraint that covers more than (scope, key)", () => {
    const wide = sqliteTable("wide_outbox", {
      id: text("id").primaryKey(), idempotencyScope: text("idempotency_scope"), idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint"),
    }, (t) => [unique("wide_outbox_uq").on(t.idempotencyScope, t.idempotencyKey, t.eventFingerprint)])
    expect(() => validateD1AtomicOutboxColumns(wide)).toThrow(new ConfigurationError("D1 outbox requires a unique (idempotencyScope,idempotencyKey) constraint"))
  })
})
