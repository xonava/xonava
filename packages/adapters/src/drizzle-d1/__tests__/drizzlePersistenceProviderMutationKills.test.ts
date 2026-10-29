import { describe, expect, it } from "vitest"
import { inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
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
