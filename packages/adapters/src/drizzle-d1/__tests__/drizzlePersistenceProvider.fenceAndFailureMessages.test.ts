import { describe, expect, it } from "vitest"
import { drizzle } from "drizzle-orm/d1"
import { ConfigurationError, ConflictError } from "@xonava/core/domain"
import type { OutboxRecord } from "@xonava/core/events"
import type { AtomicBatchPlan } from "@xonava/core/persistence"
import { createDrizzlePersistenceProvider, DrizzleEntityRegistry, type DrizzleD1Command } from "@xonava/adapters/drizzle-d1"
import { createFakeD1 } from "../../__tests__/support/fakeD1"
import { assertions, audit, auditRecord, FENCE, idempotency, outbox, plainItems, SCHEMA, type AtomicProvider } from "./sqliteFixture"

const STALE = "Optimistic concurrency conflict: a conditional write in the atomic batch affected an unexpected number of rows (stale write)"
const LOST = "Idempotency ownership was lost before the mutation committed"
const CHECK = "D1_ERROR: CHECK constraint failed: expected_affected_rows = actual_affected_rows: SQLITE_CONSTRAINT"
const inProgress = "INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','fp','tok','in-progress')"
const idemPlan = { items: [{ kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } }] } as unknown as AtomicBatchPlan<DrizzleD1Command>
const mixedPlan = { items: [{ kind: "audit", record: auditRecord("aud-x") }, { kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } }] } as unknown as AtomicBatchPlan<DrizzleD1Command>
const auditPlan = { items: [{ kind: "audit", record: auditRecord("aud-y") }] } as unknown as AtomicBatchPlan<DrizzleD1Command>

function build(override: (raw: ReturnType<typeof drizzle>) => unknown) {
  const d1 = createFakeD1([...SCHEMA])
  d1.sqlite.exec(FENCE)
  const raw = drizzle(d1 as never)
  const provider = createDrizzlePersistenceProvider({
    db: override(raw) as never, registry: new DrizzleEntityRegistry(), auditTable: audit, outboxTable: outbox, idempotencyTable: idempotency,
    idempotencyAssertionTable: assertions, mutationAssertionTable: assertions,
    mapOutboxRecord: (record: OutboxRecord) => ({ type: record.type }),
  }) as AtomicProvider
  return { d1, raw, provider }
}
const withBatch = (impl: () => Promise<unknown[]>) => (raw: ReturnType<typeof drizzle>) => new Proxy(raw, { get: (target, prop) => (prop === "batch" ? impl : Reflect.get(target, prop)) })
const withTriggerRows = (rows: unknown[]) => (raw: ReturnType<typeof drizzle>) => new Proxy(raw, {
  get: (target, prop) => (prop === "select" ? () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) : Reflect.get(target, prop)),
})
const stubBatchPlan = (raw: ReturnType<typeof drizzle>): AtomicBatchPlan<DrizzleD1Command> => ({
  items: [{ kind: "command", command: { kind: "statement", statement: raw.insert(plainItems).values({ id: "x", label: "l" }), expectedAffectedRows: 1 } }],
}) as never

describe("d1 ownership-fence verification ignores trigger rows without SQL text", () => {
  const trigger = FENCE

  it("treats null, numeric and missing trigger text as not a fence", async () => {
    const f = build(withTriggerRows([{ triggerSql: null }, { triggerSql: 42 }, {}, { triggerSql: undefined }]))
    await expect(f.provider.executeAtomicBatch(idemPlan)).rejects.toThrow(new ConfigurationError("D1 atomic idempotency requires an ownership-fence trigger on dx_assertions"))
  })

  it("still finds a real fence among unusable rows", async () => {
    const f = build(withTriggerRows([{ triggerSql: null }, { triggerSql: trigger }]))
    f.d1.sqlite.exec(inProgress)
    await expect(f.provider.executeAtomicBatch(idemPlan)).resolves.toHaveLength(1)
  })
})

describe("d1 batch failure message inspection", () => {
  it("terminates on a cyclic cause chain", async () => {
    const cyclic = new Error("outer")
    cyclic.cause = cyclic
    const f = build(withBatch(() => Promise.reject(cyclic)))
    const error = await f.provider.executeAtomicBatch(auditPlan).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
  })

  it("reads messages from causes of plain-object errors that carry no message of their own", async () => {
    const f = build(withBatch(() => Promise.reject({ cause: new Error(CHECK) })))
    const error = (await f.provider.executeAtomicBatch(stubBatchPlan(f.raw)).catch((e: unknown) => e)) as ConflictError
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.message).toBe(STALE)
  })

  it("recognises a lost ownership fence when the constraint text sits on a wrapped cause", async () => {
    const wrapped = new Error("Failed query: insert into dx_assertions", { cause: new Error("D1_ERROR: idempotency ownership lost: SQLITE_CONSTRAINT") })
    const f = build(withBatch(() => Promise.reject(wrapped)))
    f.d1.sqlite.exec(inProgress)
    const error = (await f.provider.executeAtomicBatch(mixedPlan).catch((e: unknown) => e)) as ConflictError
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.message).toBe(LOST)
    expect(error.details).toEqual({ dialect: "d1", reason: "idempotency-fence" })
  })

  it("does not call a failure lost ownership unless some message names a constraint", async () => {
    for (const failure of [new Error("D1_ERROR: connection reset"), new Error("wrapper", { cause: new Error("D1_ERROR: connection reset") })]) {
      const f = build(withBatch(() => Promise.reject(failure)))
      f.d1.sqlite.exec(inProgress)
      const error = (await f.provider.executeAtomicBatch(mixedPlan).catch((e: unknown) => e)) as Error
      expect(error.message).not.toBe(LOST)
      expect(error).not.toBeInstanceOf(ConflictError)
    }
  })

  it("treats a constraint failure as lost ownership only for plans that carry an idempotency commit", async () => {
    const failure = new Error("D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT")
    const f = build(withBatch(() => Promise.reject(failure)))
    const error = (await f.provider.executeAtomicBatch(auditPlan).catch((e: unknown) => e)) as Error
    expect(error.message).not.toBe(LOST)
  })
})
