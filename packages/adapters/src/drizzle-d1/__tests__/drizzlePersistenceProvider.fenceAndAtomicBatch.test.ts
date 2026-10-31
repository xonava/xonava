import { describe, expect, it } from "vitest"
import { inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core"
import {
  ConfigurationError, ConflictError, ImmutableFieldViolationError, Predicate, TenantScopeViolationError, ValidationError,
} from "@xonava/core/domain"
import type { OutboxRecord } from "@xonava/core/events"
import type { AtomicBatchPlan } from "@xonava/core/persistence"
import {
  createDrizzleD1Adapter, createDrizzlePersistenceProvider, D1_IDEMPOTENCY_ASSERTION_CAPABILITY, DrizzleEntityRegistry, getDrizzleSession,
  type DrizzleD1Command,
} from "@xonava/adapters/drizzle-d1"
import { createFakeD1 } from "../../__tests__/support/fakeD1"
import { createScriptedDb } from "../../__tests__/support/scriptedDb"
import {
  assertions, audit, auditRecord, FENCE, globalEntity, globalItems, idempotency, items, outbox, outboxRecord, plainEntity, plainItems, SCHEMA,
  tagGenerations, tenantEntity, type AtomicProvider,
} from "./sqliteFixture"

const itemColumns = { id: items.id, tenantId: items.tenantId, name: items.name, version: items.version }
const tenantPlainEntity = { name: "DxTenantPlain", fields: { id: {}, tenantId: {}, name: {}, version: {} }, primaryKey: "id", tenantField: "tenantId" } as never
const immutableEntity = { name: "DxImmutable", fields: { id: {}, label: {} }, primaryKey: "id", immutableFields: ["label"] } as never
const noPkEntity = { name: "DxNoPk", fields: { id: {}, label: {} } } as never

function registry(): DrizzleEntityRegistry {
  return new DrizzleEntityRegistry()
    .register(tenantEntity, items, itemColumns)
    .register(globalEntity, globalItems, { id: globalItems.id, name: globalItems.name, version: globalItems.version })
    .register(plainEntity, plainItems, { id: plainItems.id, label: plainItems.label })
    .register(tenantPlainEntity, items, itemColumns)
    .register(immutableEntity, plainItems, { id: plainItems.id, label: plainItems.label })
    .register(noPkEntity, plainItems, { id: plainItems.id, label: plainItems.label })
}

interface Overrides { readonly [key: string]: unknown }
function build(options: { fence?: string | false; extraSchema?: readonly string[]; args?: Overrides; db?: (raw: ReturnType<typeof drizzle>) => unknown } = {}) {
  const d1 = createFakeD1([...SCHEMA, ...(options.extraSchema ?? [])])
  if (options.fence !== false) d1.sqlite.exec(options.fence ?? FENCE)
  const raw = drizzle(d1 as never)
  const provider = createDrizzlePersistenceProvider({
    db: (options.db ? options.db(raw) : raw) as never, registry: registry(), auditTable: audit, outboxTable: outbox, idempotencyTable: idempotency,
    idempotencyAssertionTable: assertions, mutationAssertionTable: assertions,
    mapOutboxRecord: (record: OutboxRecord) => ({ type: record.type, payload: JSON.stringify(record.payload) }),
    ...options.args,
  } as never) as AtomicProvider
  const count = (table: string): number => (d1.sqlite.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c
  const row = (query: string): Record<string, unknown> | undefined => d1.sqlite.prepare(query).get() as Record<string, unknown> | undefined
  return { d1, raw, provider, count, row }
}
const inProgress = "INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','fp','tok','in-progress')"
const idemPlan: AtomicBatchPlan<DrizzleD1Command> = { items: [{ kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } }] } as never
const FENCE_MISSING = new ConfigurationError("D1 atomic idempotency requires an ownership-fence trigger on dx_assertions")

describe("d1 idempotency ownership-fence trigger recognition", () => {
  const base = FENCE
  const variants: [string, string][] = [
    ["double-quoted assertion table", base.replace("ON dx_assertions", 'ON "dx_assertions"')],
    ["backtick-quoted assertion table", base.replace("ON dx_assertions", "ON `dx_assertions`")],
    ["irregular whitespace", base.replace("BEFORE INSERT ON", "BEFORE\n\n   INSERT\tON\n").replace("status = 'in-progress'", "status   =\n 'in-progress'")],
  ]
  it.each(variants)("accepts %s", async (_label, fence) => {
    const { d1, provider } = build({ fence })
    d1.sqlite.exec(inProgress)
    await expect(provider.executeAtomicBatch(idemPlan)).resolves.toHaveLength(1)
  })

  const rejected: [string, string][] = [
    ["a bracket-quoted assertion table", base.replace("ON dx_assertions", "ON [dx_assertions]")],
    ["an AFTER INSERT trigger", base.replace("BEFORE INSERT", "AFTER INSERT")],
    ["a trigger that does not compare the scope", base.replace("scope = NEW.scope AND ", "")],
    ["a trigger that does not compare the key", base.replace("AND key = NEW.key ", "")],
    ["a trigger that does not compare the fingerprint", base.replace("AND fingerprint = NEW.fingerprint ", "")],
    ["a trigger that does not compare the token", base.replace("AND token = NEW.token ", "")],
    ["a trigger that does not require an in-progress reservation", base.replace("status = 'in-progress'", "status = 'completed'")],
    ["a trigger that does not abort", base.replace("RAISE(ABORT, 'idempotency ownership lost')", "RAISE(IGNORE)")],
    ["a trigger that does not read the idempotency table", base.replace("FROM dx_idempotency", "FROM dx_items")],
  ]
  it.each(rejected)("rejects %s", async (_label, fence) => {
    const { d1, provider } = build({ fence })
    d1.sqlite.exec(inProgress)
    await expect(provider.executeAtomicBatch(idemPlan)).rejects.toThrow(FENCE_MISSING)
  })

  it("finds the fence among several triggers on the assertion table and ignores non-string trigger text", async () => {
    const { d1, provider } = build({ fence: false })
    d1.sqlite.exec("CREATE TRIGGER dx_other BEFORE INSERT ON dx_assertions BEGIN SELECT 1; END")
    d1.sqlite.exec(base)
    d1.sqlite.exec(inProgress)
    await expect(provider.executeAtomicBatch(idemPlan)).resolves.toHaveLength(1)
  })

  it("reports the assertion table name when no trigger exists at all", async () => {
    const { provider } = build({ fence: false })
    await expect(provider.executeAtomicBatch(idemPlan)).rejects.toThrow(FENCE_MISSING)
  })

  it("caches a successful verification but retries after a failed one", async () => {
    const { d1, provider } = build()
    d1.sqlite.exec(inProgress)
    const reads = () => d1.executed.filter((statement) => statement.includes("sqlite_master")).length
    await provider.executeAtomicBatch(idemPlan)
    expect(reads()).toBe(1)
    d1.sqlite.exec("UPDATE dx_idempotency SET status = 'in-progress', token = 'tok'")
    await provider.executeAtomicBatch(idemPlan)
    expect(reads()).toBe(1)
    const failing = build({ fence: false })
    await expect(failing.provider.executeAtomicBatch(idemPlan)).rejects.toThrow(FENCE_MISSING)
    await expect(failing.provider.executeAtomicBatch(idemPlan)).rejects.toThrow(FENCE_MISSING)
    expect(failing.d1.executed.filter((statement) => statement.includes("sqlite_master")).length).toBe(2)
  })
})

describe("d1 entity registry validation messages", () => {
  const ok = { name: "E", fields: { id: {}, label: {} }, primaryKey: "id" }
  const columns = { id: plainItems.id, label: plainItems.label }
  const register = (entity: unknown, columnMap: Record<string, unknown> = columns, namespace?: string) =>
    () => new DrizzleEntityRegistry().register(entity as never, plainItems, columnMap as never, namespace)

  it("rejects entities without a usable name, with the registry key in the message", () => {
    expect(register({ ...ok, name: "" })).toThrow(new ConfigurationError('Drizzle registry registration "" requires a non-empty entity name.'))
    expect(register({ ...ok, name: "   " })).toThrow('Drizzle registry registration "   " requires a non-empty entity name.')
    expect(register({ ...ok, name: "" }, columns, "ns")).toThrow('Drizzle registry registration "ns:" requires a non-empty entity name.')
    expect(register({ ...ok, name: 5 })).toThrow("requires a non-empty entity name.")
  })

  it("rejects entities without declared fields, using the namespaced key", () => {
    const expected = new ConfigurationError('Entity "E" must declare fields before registration.')
    expect(register({ ...ok, fields: undefined })).toThrow(expected)
    expect(register({ ...ok, fields: {} })).toThrow(expected)
    expect(register({ ...ok, fields: "id" })).toThrow(expected)
    expect(register({ ...ok, fields: 5 })).toThrow(expected)
    expect(register({ ...ok, fields: {} }, columns, "ns")).toThrow('Entity "ns:E" must declare fields before registration.')
  })

  it("rejects empty column map keys, missing fields, undeclared keys and versions", () => {
    expect(register(ok, { ...columns, "": plainItems.id })).toThrow(new ConfigurationError('Entity "E" declares an empty column map key.'))
    expect(register({ ...ok, fields: { id: {}, label: {}, extra: {}, more: {} } })).toThrow(new ConfigurationError('Entity "E" column map is missing fields: extra, more.'))
    expect(register({ ...ok, primaryKey: "label2" })).toThrow(new ConfigurationError('Entity "E" primary key "label2" is not a declared field.'))
    expect(register({ ...ok, primaryKey: undefined, fields: { label: {} } })).toThrow('primary key "id" is not a declared field.')
    expect(register({ ...ok, versionField: "version" })).toThrow(new ConfigurationError('Entity "E" version field "version" is not a declared field.'))
    expect(register({ ...ok, versionField: "label" })).not.toThrow()
  })

  it("rejects a duplicate registration with the namespaced key", () => {
    const reg = new DrizzleEntityRegistry().register(ok as never, plainItems, columns as never, "ns")
    expect(() => reg.register(ok as never, plainItems, columns as never, "ns")).toThrow(new ConfigurationError('Entity "ns:E" is already registered in the Drizzle entity registry.'))
    expect(reg.get("E", "ns")?.entity.name).toBe("E")
    expect(reg.get("E")).toBeUndefined()
  })
})

describe("d1 tenant-scoped command encoder", () => {
  const encoder = () => build().provider.createTenantScopedCommandEncoder("t1")
  const tenantFilter = Predicate.eq("id", "a")
  type Encoded = { kind: "statement"; statement: { toSQL(): { sql: string; params: unknown[] } }; expectedAffectedRows?: number }
  const encode = (command: Record<string, unknown>, enc = encoder()): Encoded => enc.encode(command as never) as unknown as Encoded

  it("rejects opaque queries, unregistered entities and entities that are not tenant-scoped", () => {
    const enc = encoder()
    const opaque = drizzle(createFakeD1(SCHEMA) as never).select().from(items)
    expect(() => enc.encode(opaque as never)).toThrow(new ConfigurationError("Tenant-scoped D1 batches reject opaque Drizzle queries"))
    expect(() => enc.encode(null as never)).toThrow("Tenant-scoped D1 batches reject opaque Drizzle queries")
    expect(() => enc.encode({ kind: "select", entity: "DxItem" } as never)).toThrow("Tenant-scoped D1 batches reject opaque Drizzle queries")
    expect(() => encode({ kind: "insert", entity: "Nope", values: {} }, enc)).toThrow(new ConfigurationError('Tenant-scoped command entity "Nope" is not tenant-scoped'))
    expect(() => encode({ kind: "insert", entity: "DxGlobal", values: {} }, enc)).toThrow(new ConfigurationError('Tenant-scoped command entity "DxGlobal" is not tenant-scoped'))
    expect(() => encode({ kind: "insert", entity: "DxItem", namespace: "other", values: {} }, enc)).toThrow('Tenant-scoped command entity "DxItem" is not tenant-scoped')
  })

  it("inserts force the tenant, stamp version 1 and reject another tenant or unmapped fields", () => {
    const enc = encoder()
    const insert = (values: Record<string, unknown>) => (enc.encode({ kind: "insert", entity: "DxItem", values } as never) as unknown as { toSQL(): { sql: string; params: unknown[] } }).toSQL()
    expect(insert({ id: "n1", name: "N" })).toEqual({ sql: 'insert into "dx_items" ("id", "tenant_id", "name", "version") values (?, ?, ?, ?)', params: ["n1", "t1", "N", 1] })
    expect(insert({ id: "n1", name: "N", tenantId: "t1", version: 9 }).params).toEqual(["n1", "t1", "N", 1])
    expect(() => insert({ id: "n1", name: "N", tenantId: "t2" })).toThrow(new ConfigurationError('Tenant-scoped insert for "DxItem" targets another tenant'))
    expect(() => insert({ id: "n1", ghost: 1 })).toThrow(new ConfigurationError('Entity "DxItem" does not map field "ghost"'))
    const plain = (enc.encode({ kind: "insert", entity: "DxTenantPlain", values: { id: "p1", name: "P", version: 7 } } as never) as unknown as { toSQL(): { params: unknown[] } }).toSQL()
    expect(plain.params).toEqual(["p1", "t1", "P", 7])
  })

  it("versioned updates are fenced on the tenant, version and ceiling, and imply one affected row", () => {
    const encoded = encode({ kind: "update", entity: "DxItem", filter: tenantFilter, values: { name: "X" }, expectedVersion: 3 })
    expect(encoded.kind).toBe("statement")
    expect(encoded.expectedAffectedRows).toBe(1)
    expect(encoded.statement.toSQL()).toEqual({
      sql: 'update "dx_items" set "name" = ?, "version" = "dx_items"."version" + 1 where ((("dx_items"."id" = ? and "dx_items"."tenant_id" = ?) and "dx_items"."version" = ? and "dx_items"."version" < ?))',
      params: ["X", "a", "t1", 3, Number.MAX_SAFE_INTEGER],
    })
    expect(encode({ kind: "update", entity: "DxItem", filter: tenantFilter, values: { name: "X" }, expectedVersion: 3, expectedAffectedRows: 0 }).expectedAffectedRows).toBe(0)
    expect(encode({ kind: "update", entity: "DxItem", filter: tenantFilter, values: { name: "X" }, expectedVersion: 3, expectedAffectedRows: 4 }).expectedAffectedRows).toBe(4)
  })

  it("unversioned updates carry no implied row-count assertion and no version bump", () => {
    const encoded = encode({ kind: "update", entity: "DxTenantPlain", filter: tenantFilter, values: { name: "X" } })
    expect(encoded).not.toHaveProperty("expectedAffectedRows")
    expect(encoded.statement.toSQL()).toEqual({ sql: 'update "dx_items" set "name" = ? where (("dx_items"."id" = ? and "dx_items"."tenant_id" = ?))', params: ["X", "a", "t1"] })
    expect(encode({ kind: "update", entity: "DxTenantPlain", filter: tenantFilter, values: { name: "X" }, expectedVersion: 5 })).not.toHaveProperty("expectedAffectedRows")
    expect(encode({ kind: "update", entity: "DxTenantPlain", filter: tenantFilter, values: { name: "X" }, expectedAffectedRows: 2 }).expectedAffectedRows).toBe(2)
  })

  it("updates enforce the version contract and protect framework-managed fields", () => {
    const update = (values: Record<string, unknown>, expectedVersion?: number, entity = "DxItem") => () => encode({ kind: "update", entity, filter: tenantFilter, values, ...(expectedVersion === undefined ? {} : { expectedVersion }) })
    expect(update({ name: "X" })).toThrow(new ConfigurationError('Atomic update for versioned entity "DxItem" requires expectedVersion'))
    expect(update({ name: "X" }, Number.MAX_SAFE_INTEGER)).toThrow("Entity version cannot be incremented beyond the maximum safe integer.")
    expect(update({ tenantId: "t2" }, 1)).toThrow(new TenantScopeViolationError('Cannot mutate tenant field "tenantId" on entity "DxItem" through update operations.'))
    expect(update({ id: "x", tenantId: "t2" }, 1)).toThrow(TenantScopeViolationError)
    expect(update({ version: 4, name: "X" }, 1)).toThrow(new ImmutableFieldViolationError('Cannot mutate protected fields on entity "DxItem": version'))
    expect(update({ id: "x", name: "X", version: 4 }, 1)).toThrow(new ImmutableFieldViolationError('Cannot mutate protected fields on entity "DxItem": id, version'))
    expect(update({ id: "x" }, undefined, "DxTenantPlain")).toThrow(new ImmutableFieldViolationError('Cannot mutate protected fields on entity "DxTenantPlain": id'))
    expect(update({ tenantId: "t2" }, undefined, "DxTenantPlain")).toThrow(TenantScopeViolationError)
    expect(update({ version: 4 }, undefined, "DxTenantPlain")).not.toThrow()
    expect(update({ name: "X" }, undefined, "DxTenantPlain")).not.toThrow()
  })

  it("deletes are fenced on the tenant and version and imply one affected row when versioned", () => {
    const encoded = encode({ kind: "delete", entity: "DxItem", filter: tenantFilter, expectedVersion: 2 })
    expect(encoded.expectedAffectedRows).toBe(1)
    expect(encoded.statement.toSQL()).toEqual({
      sql: 'delete from "dx_items" where ((("dx_items"."id" = ? and "dx_items"."tenant_id" = ?) and "dx_items"."version" = ?))',
      params: ["a", "t1", 2],
    })
    expect(encode({ kind: "delete", entity: "DxItem", filter: tenantFilter, expectedVersion: 2, expectedAffectedRows: 0 }).expectedAffectedRows).toBe(0)
    expect(() => encode({ kind: "delete", entity: "DxItem", filter: tenantFilter })).toThrow(new ConfigurationError('Atomic delete for versioned entity "DxItem" requires expectedVersion'))
    const plain = encode({ kind: "delete", entity: "DxTenantPlain", filter: tenantFilter })
    expect(plain).not.toHaveProperty("expectedAffectedRows")
    expect(plain.statement.toSQL()).toEqual({ sql: 'delete from "dx_items" where (("dx_items"."id" = ? and "dx_items"."tenant_id" = ?))', params: ["a", "t1"] })
  })
})

describe("d1 unscoped command encoding through executeAtomicBatch", () => {
  const cmd = (command: unknown): AtomicBatchPlan<DrizzleD1Command> => ({ items: [{ kind: "command", command }] }) as never
  const filter = Predicate.eq("id", "g1")
  const seedGlobal = (d1: ReturnType<typeof build>["d1"]) => d1.sqlite.exec("INSERT INTO dx_global_items (id, name, version) VALUES ('g1', 'G', 1)")

  it("rejects unregistered and tenant-scoped entities", async () => {
    const { provider } = build()
    await expect(provider.executeAtomicBatch(cmd({ kind: "insert", entity: "Nope", values: {} }))).rejects.toThrow(new ConfigurationError('Entity "Nope" is not registered in the Drizzle entity registry'))
    await expect(provider.executeAtomicBatch(cmd({ kind: "insert", entity: "DxItem", values: { id: "x" } }))).rejects.toThrow(new ConfigurationError('Global D1 command entity "DxItem" must not be tenant-scoped'))
    await expect(provider.executeAtomicBatch(cmd({ kind: "insert", entity: "DxGlobal", values: { id: "x", ghost: 1 } }))).rejects.toThrow(new ConfigurationError('Entity "DxGlobal" does not map field "ghost"'))
  })

  it("inserts stamp version 1 on versioned entities and leave unversioned values alone", async () => {
    const { provider, row } = build()
    await provider.executeAtomicBatch(cmd({ kind: "insert", entity: "DxGlobal", values: { id: "g9", name: "N", version: 7 } }))
    expect(row("SELECT version FROM dx_global_items WHERE id = 'g9'")).toEqual({ version: 1 })
    await provider.executeAtomicBatch(cmd({ kind: "insert", entity: "DxPlain", values: { id: "p1", label: "L" } }))
    expect(row("SELECT label FROM dx_plain_items WHERE id = 'p1'")).toEqual({ label: "L" })
  })

  it("versioned updates need an expected version, bump it and fence on it", async () => {
    const { d1, provider, row } = build()
    seedGlobal(d1)
    const update = (values: Record<string, unknown>, extra: Record<string, unknown> = {}) => cmd({ kind: "update", entity: "DxGlobal", filter, values, ...extra })
    await expect(provider.executeAtomicBatch(update({ name: "X" }))).rejects.toThrow(new ConfigurationError('Atomic update for versioned entity "DxGlobal" requires expectedVersion'))
    await expect(provider.executeAtomicBatch(update({ name: "X" }, { expectedVersion: Number.MAX_SAFE_INTEGER }))).rejects.toThrow("Entity version cannot be incremented beyond the maximum safe integer.")
    await expect(provider.executeAtomicBatch(update({ version: 4 }, { expectedVersion: 1 }))).rejects.toThrow(new ImmutableFieldViolationError('Cannot mutate protected fields on entity "DxGlobal": version'))
    await expect(provider.executeAtomicBatch(update({ id: "z", name: "X" }, { expectedVersion: 1 }))).rejects.toThrow(new ImmutableFieldViolationError('Cannot mutate protected fields on entity "DxGlobal": id'))
    const stale = await provider.executeAtomicBatch(update({ name: "X" }, { expectedVersion: 99 })).catch((e: unknown) => e)
    expect(stale).toBeInstanceOf(ConflictError)
    expect((stale as ConflictError).details).toMatchObject({ dialect: "d1", reason: "mutation-assertion" })
    expect(row("SELECT name, version FROM dx_global_items")).toEqual({ name: "G", version: 1 })
    await provider.executeAtomicBatch(update({ name: "X" }, { expectedVersion: 1 }))
    expect(row("SELECT name, version FROM dx_global_items")).toEqual({ name: "X", version: 2 })
  })

  it("an explicit expectedAffectedRows overrides the implied one", async () => {
    const { d1, provider, row } = build()
    seedGlobal(d1)
    const update = (extra: Record<string, unknown>) => cmd({ kind: "update", entity: "DxGlobal", filter, values: { name: "Y" }, expectedVersion: 1, ...extra })
    await expect(provider.executeAtomicBatch(update({ expectedAffectedRows: 2 }))).rejects.toBeInstanceOf(ConflictError)
    await expect(provider.executeAtomicBatch(update({ expectedAffectedRows: 0 }))).rejects.toBeInstanceOf(ConflictError)
    expect(row("SELECT name, version FROM dx_global_items")).toEqual({ name: "G", version: 1 })
    await provider.executeAtomicBatch(update({ expectedAffectedRows: 1 }))
    expect(row("SELECT name, version FROM dx_global_items")).toEqual({ name: "Y", version: 2 })
    const noMatch = cmd({ kind: "update", entity: "DxGlobal", filter: Predicate.eq("id", "missing"), values: { name: "Z" }, expectedVersion: 2, expectedAffectedRows: 0 })
    await expect(provider.executeAtomicBatch(noMatch)).resolves.toHaveLength(1)
  })

  it("unversioned commands imply no row-count assertion, so no assertion table is needed", async () => {
    const { d1, provider, row } = build({ args: { mutationAssertionTable: undefined } })
    d1.sqlite.exec("INSERT INTO dx_plain_items (id, label) VALUES ('p1', 'L'), ('p2', 'L')")
    await provider.executeAtomicBatch(cmd({ kind: "update", entity: "DxPlain", filter: Predicate.eq("label", "L"), values: { label: "M" } }))
    expect(row("SELECT count(*) AS c FROM dx_plain_items WHERE label = 'M'")).toEqual({ c: 2 })
    await provider.executeAtomicBatch(cmd({ kind: "delete", entity: "DxPlain", filter: Predicate.eq("id", "p1") }))
    expect(row("SELECT count(*) AS c FROM dx_plain_items")).toEqual({ c: 1 })
    await expect(provider.executeAtomicBatch(cmd({ kind: "update", entity: "DxGlobal", filter, values: { name: "Q" }, expectedVersion: 1 })))
      .rejects.toThrow(new ConfigurationError("D1 conditional atomic mutations require mutationAssertionTable"))
    const counted = await provider.executeAtomicBatch(cmd({ kind: "update", entity: "DxPlain", filter: Predicate.eq("id", "p2"), values: { label: "N" }, expectedAffectedRows: 1 })).catch((e: unknown) => e)
    expect(counted).toEqual(new ConfigurationError("D1 conditional atomic mutations require mutationAssertionTable"))
  })

  it("protects the primary key (default id) and declared immutable fields", async () => {
    const { d1, provider } = build()
    d1.sqlite.exec("INSERT INTO dx_plain_items (id, label) VALUES ('p1', 'L')")
    const upd = (entity: string, values: Record<string, unknown>) => provider.executeAtomicBatch(cmd({ kind: "update", entity, filter: Predicate.eq("id", "p1"), values }))
    await expect(upd("DxNoPk", { id: "q" })).rejects.toThrow(new ImmutableFieldViolationError('Cannot mutate protected fields on entity "DxNoPk": id'))
    await expect(upd("DxImmutable", { label: "z" })).rejects.toThrow(new ImmutableFieldViolationError('Cannot mutate protected fields on entity "DxImmutable": label'))
    await expect(upd("DxImmutable", { id: "q", label: "z" })).rejects.toThrow('entity "DxImmutable": id, label')
    await expect(upd("DxPlain", { id: "q" })).rejects.toThrow('entity "DxPlain": id')
    await expect(upd("DxNoPk", { label: "ok" })).resolves.toHaveLength(1)
    await expect(upd("DxPlain", { label: "ok2" })).resolves.toHaveLength(1)
  })

  it("versioned deletes need an expected version and fence on it", async () => {
    const { d1, provider, row } = build()
    seedGlobal(d1)
    const del = (extra: Record<string, unknown> = {}) => cmd({ kind: "delete", entity: "DxGlobal", filter, ...extra })
    await expect(provider.executeAtomicBatch(del())).rejects.toThrow(new ConfigurationError('Atomic delete for versioned entity "DxGlobal" requires expectedVersion'))
    const stale = await provider.executeAtomicBatch(del({ expectedVersion: 5 })).catch((e: unknown) => e)
    expect(stale).toBeInstanceOf(ConflictError)
    expect(row("SELECT count(*) AS c FROM dx_global_items")).toEqual({ c: 1 })
    await provider.executeAtomicBatch(del({ expectedVersion: 1 }))
    expect(row("SELECT count(*) AS c FROM dx_global_items")).toEqual({ c: 0 })
  })

  it("accepts opaque Drizzle statements and pre-encoded statements, and rejects a failed row-count assertion", async () => {
    const { raw, provider, row } = build()
    await provider.executeAtomicBatch(cmd(raw.insert(plainItems).values({ id: "o1", label: "opaque" })))
    expect(row("SELECT label FROM dx_plain_items WHERE id = 'o1'")).toEqual({ label: "opaque" })
    const encoded = { kind: "statement", statement: raw.insert(plainItems).values({ id: "o2", label: "encoded" }), expectedAffectedRows: 1 }
    await provider.executeAtomicBatch(cmd(encoded))
    expect(row("SELECT label FROM dx_plain_items WHERE id = 'o2'")).toEqual({ label: "encoded" })
    const wrong = { kind: "statement", statement: raw.insert(plainItems).values({ id: "o3", label: "wrong" }), expectedAffectedRows: 0 }
    await expect(provider.executeAtomicBatch(cmd(wrong))).rejects.toBeInstanceOf(ConflictError)
    expect(row("SELECT count(*) AS c FROM dx_plain_items WHERE id = 'o3'")).toEqual({ c: 0 })
    await expect(provider.executeAtomicBatch({ items: [] })).resolves.toEqual([])
  })

  it("aligns results with plan items when a command expands to a statement plus an assertion", async () => {
    const { d1, raw, provider } = build()
    d1.sqlite.exec("INSERT INTO dx_plain_items (id, label) VALUES ('p1', 'L'), ('p2', 'L'), ('p3', 'M'), ('p4', 'M'), ('p5', 'M')")
    const first = { kind: "statement", statement: raw.update(plainItems).set({ label: "A" }).where(undefined), expectedAffectedRows: 5 }
    const results = await provider.executeAtomicBatch({
      items: [
        { kind: "command", command: first },
        { kind: "command", command: raw.update(plainItems).set({ label: "B" }).where(inArray(plainItems.id, ["p1", "p2", "p3"])) },
        { kind: "audit", record: auditRecord("aud-1") },
      ],
    } as never)
    expect(results.map((entry) => entry.kind)).toEqual(["command", "command", "audit"])
    const changes = (value: unknown) => (value as { meta: { changes: number } }).meta.changes
    expect(changes(results[0]!.result)).toBe(5)
    expect(changes(results[1]!.result)).toBe(3)
    expect(changes(results[2]!.result)).toBe(1)
  })
})

describe("d1 provider construction, adapter resolution and capabilities", () => {
  const lax = (name: string) => sqliteTable(name, { scope: text("scope"), key: text("key") })

  it("validates configured limits with the limit name in the message", () => {
    for (const name of ["maxPageSize", "maxBindParams", "maxStatementBytes", "maxBatchItems"]) {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => build({ args: { limits: { [name]: bad } } })).toThrow(new ConfigurationError(`D1 ${name} must be a finite positive integer`))
      }
      expect(() => build({ args: { limits: { [name]: 1 } } })).not.toThrow()
    }
    expect(() => build({ args: { limits: { maxPageSize: undefined } } })).not.toThrow()
  })

  it("advertises the exact capability set of a fully configured batch-capable provider", () => {
    const { provider } = build({ args: { tagGenerationTable: tagGenerations } })
    expect(provider.dialect).toBe("cloudflare-d1")
    expect(provider.capabilities).toEqual({
      interactiveTransactions: false, atomicBatch: true, atomicBatchScope: "unscoped", atomicBatchIdempotency: true, atomicBatchCacheGeneration: true,
      returningInsert: false, readSessions: false, jsonQueries: false, exactDecimal: false, persistentConnection: false, conditionalAbacUpdate: false,
      maxPageSize: 100, maxBindParams: 100, maxStatementBytes: 100_000, maxBatchItems: 100,
      execution: {
        "transaction.interactive": { status: "unsupported" },
        "transaction.atomicBatch": { status: "proven", evidence: "framework-conformance/release/d1-guarantees.json" },
        "locking.pessimistic": { status: "unsupported" },
        "bulk.versioned.atomic": { status: "unsupported" },
        "bulk.versioned.partial": { status: "unsupported" },
        "read.streaming": { status: "unsupported" },
        "read.boundedPagedScan": { status: "proven", evidence: "framework-conformance/q1/query-envelope-conformance.json" },
      },
    })
    expect(Object.isFrozen(provider.capabilities.execution)).toBe(true)
  })

  it("reflects configured limits and omits optional batch capabilities that are not configured", () => {
    const { provider } = build({ args: { limits: { maxPageSize: 5, maxBindParams: 7, maxStatementBytes: 9000, maxBatchItems: 3 }, idempotencyTable: undefined } })
    expect(provider.capabilities).toMatchObject({ maxPageSize: 5, maxBindParams: 7, maxStatementBytes: 9000, maxBatchItems: 3, atomicBatch: true })
    expect(provider.capabilities).not.toHaveProperty("atomicBatchIdempotency")
    expect(provider.capabilities).not.toHaveProperty("atomicBatchCacheGeneration")
    expect(build({ args: { idempotencyAssertionTable: undefined } }).provider.capabilities).not.toHaveProperty("atomicBatchIdempotency")
    expect(build({ args: { idempotencyAssertionTable: lax("dx_assertions") } }).provider.capabilities).not.toHaveProperty("atomicBatchIdempotency")
    expect(build({ args: { idempotencyAssertionTable: Object.assign(lax("dx_assertions"), { idempotencyAssertionCapability: D1_IDEMPOTENCY_ASSERTION_CAPABILITY }) } }).provider.capabilities).toHaveProperty("atomicBatchIdempotency", true)
  })

  it("a session without batch support is a plain repository provider", () => {
    const scripted = createScriptedDb("sqlite", () => []).db
    const plain = createDrizzlePersistenceProvider({ db: scripted as never, registry: registry() }) as AtomicProvider
    expect(plain.capabilities.atomicBatch).toBe(false)
    expect(plain.capabilities).not.toHaveProperty("atomicBatchScope")
    expect(plain.capabilities.execution).toMatchObject({ "transaction.atomicBatch": { status: "unsupported" } })
    expect(plain.executeAtomicBatch).toBeUndefined()
    expect(plain.createTenantScopedCommandEncoder).toBeUndefined()
    expect(getDrizzleSession(plain)).toBe(scripted)
    const notAFunction = createDrizzlePersistenceProvider({ db: { ...scripted, batch: "no" } as never, registry: registry() }) as AtomicProvider
    expect(notAFunction.capabilities.atomicBatch).toBe(false)
  })

  it("wraps a drizzle database and accepts a ready-made adapter, exposing the repository session", () => {
    const { raw, provider } = build()
    expect(provider.executeAtomicBatch).toBeTypeOf("function")
    expect(provider.createTenantScopedCommandEncoder).toBeTypeOf("function")
    expect(getDrizzleSession(provider)).not.toBe(raw)
    const adapter = createDrizzleD1Adapter(raw)
    const adapted = createDrizzlePersistenceProvider({ db: adapter, registry: registry() })
    expect(getDrizzleSession(adapted)).toBe(adapter.repository)
    const rawOnly = createDrizzlePersistenceProvider({ db: { raw, batch: raw.batch.bind(raw) } as never, registry: registry() })
    expect(getDrizzleSession(rawOnly)).not.toBe(raw)
    expect(rawOnly.capabilities.atomicBatch).toBe(true)
    const repositoryOnly = createDrizzlePersistenceProvider({ db: { repository: adapter.repository, batch: raw.batch.bind(raw) } as never, registry: registry() })
    expect(repositoryOnly.capabilities.atomicBatch).toBe(true)
    expect(getDrizzleSession(repositoryOnly)).not.toBe(adapter.repository)
  })

  it("builds repositories for registered entities with the configured page size", async () => {
    const { provider, d1 } = build({ args: { limits: { maxPageSize: 5 } } })
    expect(() => provider.repository({ name: "Nope", fields: {} } as never)).toThrow(new ConfigurationError('Entity "Nope" is not registered in the Drizzle entity registry'))
    d1.sqlite.exec("INSERT INTO dx_plain_items (id, label) VALUES ('p1', 'L')")
    const repo = provider.repository(plainEntity) as unknown as { findMany(options: unknown): Promise<{ pageSize: number }> }
    expect((await repo.findMany({ pagination: { kind: "offset", page: 1, pageSize: 5 } })).pageSize).toBe(5)
    expect((await repo.findMany({ pagination: { kind: "offset", page: 1, pageSize: 6 } })).pageSize).toBe(5)
    const defaults = build().provider.repository(plainEntity) as unknown as { findMany(options: unknown): Promise<{ pageSize: number }> }
    expect((await defaults.findMany({ pagination: { kind: "offset", page: 1, pageSize: 101 } })).pageSize).toBe(100)
    expect((await defaults.findMany({ pagination: { kind: "offset", page: 1, pageSize: 100 } })).pageSize).toBe(100)
  })
})

const stubBatch = (impl: (statements: readonly unknown[]) => Promise<unknown[]>) => (raw: ReturnType<typeof drizzle>) =>
  new Proxy(raw, { get: (target, prop) => (prop === "batch" ? impl : Reflect.get(target, prop)) })
const rejecting = (error: unknown) => stubBatch(() => Promise.reject(error))
const auditPlan = (): AtomicBatchPlan<DrizzleD1Command> => ({ items: [{ kind: "audit", record: auditRecord("aud-stub") }] }) as never
const withAssertion = (raw: ReturnType<typeof drizzle>): AtomicBatchPlan<DrizzleD1Command> => ({
  items: [{ kind: "command", command: { kind: "statement", statement: raw.insert(plainItems).values({ id: "x", label: "l" }), expectedAffectedRows: 1 } }],
}) as never
const chained = (depth: number, message: string): Error => {
  let error = new Error(message)
  for (let level = 0; level < depth; level++) error = new Error(`wrapper ${level}`, { cause: error })
  return error
}
const CHECK = "D1_ERROR: CHECK constraint failed: expected_affected_rows = actual_affected_rows: SQLITE_CONSTRAINT"
const STALE = "Optimistic concurrency conflict: a conditional write in the atomic batch affected an unexpected number of rows (stale write)"

describe("d1 atomic batch error classification", () => {
  it("passes framework errors through untouched", async () => {
    const failure = new ValidationError("already framework")
    const { provider } = build({ db: rejecting(failure) })
    expect(await provider.executeAtomicBatch(auditPlan()).catch((e: unknown) => e)).toBe(failure)
  })

  it("classifies a failed row-count CHECK as a stale write, looking through up to six levels of causes", async () => {
    for (const depth of [0, 1, 5]) {
      const { raw, provider } = build({ db: rejecting(chained(depth, CHECK)) })
      const error = (await provider.executeAtomicBatch(withAssertion(raw)).catch((e: unknown) => e)) as ConflictError
      expect(error).toBeInstanceOf(ConflictError)
      expect(error.message).toBe(STALE)
      expect(error.details).toEqual({ dialect: "d1", reason: "mutation-assertion" })
    }
    const { raw, provider } = build({ db: rejecting(chained(6, CHECK)) })
    const deep = (await provider.executeAtomicBatch(withAssertion(raw)).catch((e: unknown) => e)) as Error
    expect(deep.message).not.toBe(STALE)
    const actual = build({ db: rejecting(new Error("CHECK constraint failed: actual_affected_rows")) })
    expect(((await actual.provider.executeAtomicBatch(withAssertion(actual.raw)).catch((e: unknown) => e)) as Error).message).toBe(STALE)
  })

  it("does not call a failure a stale write unless it is a CHECK failure on an assertion column of a plan that asserts", async () => {
    const make = (message: string) => build({ db: rejecting(new Error(message)) })
    for (const message of ["D1_ERROR: expected_affected_rows exploded", "D1_ERROR: CHECK constraint failed: some_other_column", "D1_ERROR: something else entirely"]) {
      const f = make(message)
      const error = (await f.provider.executeAtomicBatch(withAssertion(f.raw)).catch((e: unknown) => e)) as Error
      expect(error.message).not.toBe(STALE)
    }
    const noAssertion = make(CHECK)
    const error = (await noAssertion.provider.executeAtomicBatch(auditPlan()).catch((e: unknown) => e)) as Error
    expect(error.message).not.toBe(STALE)
    const noTable = build({ db: rejecting(new Error(CHECK)), args: { mutationAssertionTable: undefined } })
    expect(((await noTable.provider.executeAtomicBatch(auditPlan()).catch((e: unknown) => e)) as Error).message).not.toBe(STALE)
    const columnless = build({ db: rejecting(new Error(CHECK)), args: { mutationAssertionTable: sqliteTable("dx_assertions", { scope: text("scope") }) } })
    expect(((await columnless.provider.executeAtomicBatch(auditPlan()).catch((e: unknown) => e)) as Error).message).not.toBe(STALE)
    const nonObjectCause = new Error("outer", { cause: "CHECK constraint failed: expected_affected_rows" })
    const f = build({ db: rejecting(nonObjectCause) })
    expect(((await f.provider.executeAtomicBatch(withAssertion(f.raw)).catch((e: unknown) => e)) as Error).message).not.toBe(STALE)
  })

  it("classifies an unclassified constraint failure of a plan with an idempotency commit as lost ownership", async () => {
    const plan = { items: [{ kind: "audit", record: auditRecord("aud-own") }, { kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } }] } as never
    const make = (message: string) => {
      const f = build({ db: rejecting(new Error(message)) })
      f.d1.sqlite.exec(inProgress)
      return f
    }
    const lost = make("D1_ERROR: idempotency ownership lost: SQLITE_CONSTRAINT")
    const error = (await lost.provider.executeAtomicBatch(plan).catch((e: unknown) => e)) as ConflictError
    expect(error).toBeInstanceOf(ConflictError)
    expect(error.message).toBe("Idempotency ownership was lost before the mutation committed")
    expect(error.details).toEqual({ dialect: "d1", reason: "idempotency-fence" })
    const other = make("D1_ERROR: network down")
    const generic = (await other.provider.executeAtomicBatch(plan).catch((e: unknown) => e)) as Error
    expect(generic.message).not.toBe("Idempotency ownership was lost before the mutation committed")
    const withoutCommit = build({ db: rejecting(new Error("D1_ERROR: boom: SQLITE_CONSTRAINT")) })
    const unrelated = (await withoutCommit.provider.executeAtomicBatch(auditPlan()).catch((e: unknown) => e)) as Error
    expect(unrelated.message).not.toBe("Idempotency ownership was lost before the mutation committed")
  })

  it("maps results back to items and reports missing results", async () => {
    const done = (changes: number) => ({ success: true, results: [], meta: { changes } })
    const plan = {
      items: [
        { kind: "audit", record: auditRecord("aud-r1") },
        { kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } },
        { kind: "audit", record: auditRecord("aud-r2") },
      ],
    } as never
    const results = [done(1), done(2), done(1), done(3)]
    const f = build({ db: stubBatch(async () => results) })
    f.d1.sqlite.exec(inProgress)
    const mapped = await f.provider.executeAtomicBatch(plan)
    expect(mapped.map((entry) => entry.kind)).toEqual(["audit", "idempotency", "audit"])
    expect(mapped[0]!.result).toBe(results[0])
    expect(mapped[1]!.result).toEqual({ assertion: results[1], receipt: results[2] })
    expect(mapped[2]!.result).toBe(results[3])
  })

  it("rejects a batch that returns no result for an item or an idempotency receipt that did not change exactly one row", async () => {
    const short = build({ db: stubBatch(async () => []) })
    await expect(short.provider.executeAtomicBatch(auditPlan())).rejects.toThrow(new ConfigurationError("D1 atomic batch returned an unaddressable result."))
    const idem = { items: [{ kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } }] } as never
    const done = (changes: number) => ({ success: true, results: [], meta: { changes } })
    for (const results of [[done(1)], [done(1), done(0)], [done(1), done(2)]]) {
      const f = build({ db: stubBatch(async () => results) })
      f.d1.sqlite.exec(inProgress)
      await expect(f.provider.executeAtomicBatch(idem)).rejects.toThrow(new ConfigurationError("D1 idempotency receipt update affected exactly one row"))
    }
    const f = build({ db: stubBatch(async () => [done(1), done(1)]) })
    f.d1.sqlite.exec(inProgress)
    await expect(f.provider.executeAtomicBatch(idem)).resolves.toHaveLength(1)
  })

  it("a trigger that passes verification but never fires leaves the receipt update touching zero rows", async () => {
    const lax = FENCE.replace("WHEN NEW.expected_affected_rows IS NULL AND", "WHEN 0 AND NEW.expected_affected_rows IS NULL AND")
    const f = build({ fence: lax })
    await expect(f.provider.executeAtomicBatch(idemPlan)).rejects.toThrow(new ConfigurationError("D1 idempotency receipt update affected exactly one row"))
  })
})

describe("d1 atomic batch item configuration errors", () => {
  const plan = (item: Record<string, unknown>) => ({ items: [item] }) as never
  const outboxPlan = plan({ kind: "outbox", record: outboxRecord("o1", "cfg-key") })

  it("outbox items need both the outbox table and the mapper", async () => {
    const expected = new ConfigurationError("D1 atomic batches require outboxTable and mapOutboxRecord for outbox items")
    await expect(build({ args: { outboxTable: undefined } }).provider.executeAtomicBatch(outboxPlan)).rejects.toThrow(expected)
    await expect(build({ args: { mapOutboxRecord: undefined } }).provider.executeAtomicBatch(outboxPlan)).rejects.toThrow(expected)
    await expect(build().provider.executeAtomicBatch(outboxPlan)).resolves.toHaveLength(1)
  })

  it("outbox items validate the scope identity before writing", async () => {
    const { provider, count } = build()
    const mismatched = { ...outboxRecord("o2", "scope-key"), scopeId: "platform:other" }
    await expect(provider.executeAtomicBatch(plan({ kind: "outbox", record: mismatched }))).rejects.toThrow(new ConfigurationError("outbox scope identity mismatch"))
    expect(count("dx_outbox")).toBe(0)
  })

  it("outbox items carry the tenant when the table has a tenant column and still honour protected fields", async () => {
    const tenantOutbox = sqliteTable("dx_outbox_t", {
      id: text("id").primaryKey(), tenantId: text("tenant_id"), type: text("type"), payload: text("payload"), idempotencyScope: text("idempotency_scope"),
      idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint"),
    }, (t) => [unique("dx_outbox_t_identity").on(t.idempotencyScope, t.idempotencyKey)])
    const extraSchema = ["CREATE TABLE dx_outbox_t (id TEXT PRIMARY KEY, tenant_id TEXT, type TEXT, payload TEXT, idempotency_scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, event_fingerprint TEXT NOT NULL, UNIQUE (idempotency_scope, idempotency_key))"]
    const { provider, row } = build({ extraSchema, args: { outboxTable: tenantOutbox } })
    await provider.executeAtomicBatch(plan({ kind: "outbox", record: { ...outboxRecord("o5", "tenant-key"), tenantId: "t9" } }))
    expect(row("SELECT id, tenant_id FROM dx_outbox_t")).toEqual({ id: "o5", tenant_id: "t9" })
    const { provider: plainProvider, row: plainRow } = build()
    await plainProvider.executeAtomicBatch(plan({ kind: "outbox", record: { ...outboxRecord("o6", "plain-key"), tenantId: "t9" } }))
    expect(plainRow("SELECT id FROM dx_outbox")).toEqual({ id: "o6" })
  })

  it("audit items need an audit table", async () => {
    await expect(build({ args: { auditTable: undefined } }).provider.executeAtomicBatch(plan({ kind: "audit", record: auditRecord("a1") })))
      .rejects.toThrow(new ConfigurationError("D1 atomic batches require auditTable for audit items"))
  })

  it("cache-generation items need a tag table with tag and generation columns and increment per tag", async () => {
    const item = plan({ kind: "cache-generation", tag: "t1" })
    await expect(build().provider.executeAtomicBatch(item)).rejects.toThrow(new ConfigurationError("D1 atomic batches require tagGenerationTable for cache-generation items"))
    const noGeneration = sqliteTable("dx_tag_generations", { tag: text("tag").primaryKey() })
    const noTag = sqliteTable("dx_tag_generations", { generation: integer("generation") })
    const both = new ConfigurationError("tagGenerationTable must expose tag and generation columns")
    await expect(build({ args: { tagGenerationTable: noGeneration } }).provider.executeAtomicBatch(item)).rejects.toThrow(both)
    await expect(build({ args: { tagGenerationTable: noTag } }).provider.executeAtomicBatch(item)).rejects.toThrow(both)
    const { provider, row } = build({ args: { tagGenerationTable: tagGenerations } })
    await provider.executeAtomicBatch(item)
    await provider.executeAtomicBatch(item)
    await provider.executeAtomicBatch(plan({ kind: "cache-generation", tag: "t2" }))
    expect(row("SELECT generation FROM dx_tag_generations WHERE tag = 't1'")).toEqual({ generation: 2 })
    expect(row("SELECT generation FROM dx_tag_generations WHERE tag = 't2'")).toEqual({ generation: 1 })
  })

  it("idempotency items need the idempotency table, the assertion table and the fence capability", async () => {
    const expected = new ConfigurationError("D1 atomic batches require idempotencyTable, idempotencyAssertionTable, and the ownership-fence-trigger assertion capability for idempotency commit receipts")
    const plainAssertion = sqliteTable("dx_assertions", { scope: text("scope"), key: text("key") })
    for (const args of [{ idempotencyTable: undefined }, { idempotencyAssertionTable: undefined }, { idempotencyAssertionTable: plainAssertion }]) {
      await expect(build({ args }).provider.executeAtomicBatch(idemPlan)).rejects.toThrow(expected)
    }
  })

  it("commits an idempotency receipt with null resource defaults and a serialized resource version", async () => {
    const { d1, provider, row } = build()
    d1.sqlite.exec(inProgress)
    await provider.executeAtomicBatch(idemPlan)
    expect(row("SELECT status, result, resource_entity, resource_id, resource_version FROM dx_idempotency")).toEqual({
      status: "business-committed", result: null, resource_entity: null, resource_id: null, resource_version: null,
    })
    const zero = build()
    zero.d1.sqlite.exec(inProgress)
    await zero.provider.executeAtomicBatch({ items: [{ kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok", resource: { entity: "E", id: "r", version: 0 } } }] } as never)
    expect(zero.row("SELECT resource_version FROM dx_idempotency")).toEqual({ resource_version: JSON.stringify({ type: "number", value: 0 }) })
  })
})

describe("d1 atomic batch replay of an existing outbox identity", () => {
  const record = outboxRecord("o1", "replay-key")
  const commit = { scope: "s", key: "k", fingerprint: "fp", token: "tok" }
  const replay = (commits: unknown[] = [commit]) => ({
    items: [
      { kind: "command", command: { kind: "insert", entity: "DxPlain", values: { id: "never", label: "N" } } },
      { kind: "outbox", record: { ...record, id: "o-again" } },
      ...commits.map((entry) => ({ kind: "idempotency", commit: entry })),
    ],
  }) as never
  const seeded = async (args: Overrides = {}) => {
    const f = build({ args })
    await f.provider.executeAtomicBatch({ items: [{ kind: "outbox", record }] })
    return f
  }
  const receipt = (f: Awaited<ReturnType<typeof seeded>>, fingerprint: string, status: string) =>
    f.d1.sqlite.exec(`INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('r1','s','k','${fingerprint}','tok','${status}')`)

  it("requires exactly one committed idempotency receipt in the plan", async () => {
    const f = await seeded()
    const expected = new ConflictError("Existing outbox identity requires a committed idempotency receipt before replay")
    await expect(f.provider.executeAtomicBatch(replay([]))).rejects.toThrow(expected)
    await expect(f.provider.executeAtomicBatch(replay([commit, { ...commit, key: "k2" }]))).rejects.toThrow(expected)
    await expect(f.provider.executeAtomicBatch(replay())).rejects.toThrow(new ConflictError("Existing outbox identity has no committed idempotency receipt"))
  })

  it("requires the receipt table to expose scope, key, fingerprint and status", async () => {
    const full = { scope: text("scope"), key: text("key"), fingerprint: text("fingerprint"), status: text("status") }
    for (const omit of ["scope", "key", "fingerprint", "status"] as const) {
      const { [omit]: _omitted, ...rest } = full
      const f = await seeded({ idempotencyTable: sqliteTable("dx_idempotency", rest) })
      await expect(f.provider.executeAtomicBatch(replay())).rejects.toThrow(new ConfigurationError("D1 idempotency replay requires scope, key, fingerprint, and status columns"))
    }
  })

  it("rejects a receipt for a different mutation or one that is not committed", async () => {
    const other = await seeded()
    receipt(other, "different", "business-committed")
    await expect(other.provider.executeAtomicBatch(replay())).rejects.toThrow(new ConflictError("Idempotency key was reused for a different mutation"))
    const pending = await seeded()
    receipt(pending, "fp", "in-progress")
    await expect(pending.provider.executeAtomicBatch(replay())).rejects.toThrow(new ConflictError("Existing outbox identity does not have a committed idempotency receipt"))
  })

  it.each(["business-committed", "completed"])("replays nothing when the receipt is %s", async (status) => {
    const f = await seeded()
    receipt(f, "fp", status)
    const results = await f.provider.executeAtomicBatch(replay())
    expect(results).toEqual([{ kind: "command", result: { replayed: true } }, { kind: "outbox", result: { replayed: true } }, { kind: "idempotency", result: { replayed: true } }])
    expect(f.count("dx_plain_items")).toBe(0)
    expect(f.count("dx_outbox")).toBe(1)
  })

  it("refuses to replay when only some outbox identities already exist", async () => {
    const f = await seeded()
    receipt(f, "fp", "business-committed")
    const mixed = { items: [
      { kind: "command", command: { kind: "insert", entity: "DxPlain", values: { id: "never", label: "N" } } },
      { kind: "outbox", record: { ...record, id: "o-again" } },
      { kind: "outbox", record: outboxRecord("o-new", "brand-new-key") },
      { kind: "idempotency", commit },
    ] } as never
    await expect(f.provider.executeAtomicBatch(mixed)).rejects.toThrow(new ConflictError("Atomic batch replay has both existing and new outbox identities"))
    expect(f.count("dx_plain_items")).toBe(0)
  })
})
