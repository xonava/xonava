import { describe, expect, it } from "vitest"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { drizzle } from "drizzle-orm/d1"
import { ConfigurationError, ConflictError, ImmutableFieldViolationError, Predicate, TenantScopeViolationError, encodeExecutionScopeId } from "@xonava/core/domain"
import {
  createDrizzleD1Adapter, createDrizzlePersistenceProvider, D1BatchLimitExceededError, DrizzleEntityRegistry, getDrizzleSession, mapAuditRecord,
} from "@xonava/adapters/drizzle-d1"
import { createFakeD1 } from "../../__tests__/support/fakeD1"
import {
  auditRecord, FENCE, items, outboxRecord, plainEntity, plainItems, SCHEMA, setup, tenantEntity,
  type AtomicProvider,
} from "./sqliteFixture"

describe("D1 provider atomic batches on a real SQLite engine", () => {
  it("a duplicate insert in an atomic batch is a sanitized ConflictError and rolls back the audit row", async () => {
    const { provider, count } = await setup()
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    const error = await provider.executeAtomicBatch({ items: [
      { kind: "audit", record: auditRecord("aud-dup") },
      { kind: "command", command: encoder.encode({ kind: "insert", entity: "DxItem", values: { id: "z", name: "A" } } as never) },
    ] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(String((error as Error).message)).not.toMatch(/dx_items|D1_ERROR|UNIQUE/)
    expect(count("dx_audit")).toBe(0)
  })

  it("a lost idempotency fence aborts the batch with ConflictError", async () => {
    const { d1, provider, count } = await setup()
    d1.sqlite.exec("INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','fp','tok','completed')")
    const error = await provider.executeAtomicBatch({ items: [
      { kind: "audit", record: auditRecord("aud-fence") },
      { kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } },
    ] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).details).toMatchObject({ reason: "idempotency-fence" })
    expect(count("dx_audit")).toBe(0)
  })

  it("commits an idempotency receipt with resource identity and pending invalidations", async () => {
    const { d1, provider, row } = await setup()
    d1.sqlite.exec("INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','fp','tok','in-progress')")
    const result = await provider.executeAtomicBatch({ items: [
      { kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok", resource: { entity: "DxItem", id: "a", version: 3 }, invalidations: [{ kind: "tag", tag: "dx" }] } as never },
    ] })
    expect(result).toHaveLength(1)
    expect(result[0]!.kind).toBe("idempotency")
    expect(row("SELECT status, resource_entity, resource_id, resource_version, typeof(completed_at) AS t FROM dx_idempotency")).toEqual({
      status: "business-committed", resource_entity: "DxItem", resource_id: "a", resource_version: JSON.stringify({ type: "number", value: 3 }), t: "integer",
    })
    expect(String(row("SELECT pending_invalidations AS p FROM dx_idempotency")!.p)).toContain("dx")
  })

  it("an explicit mutation-assertion failure is a ConflictError (stale write) and leaves nothing behind", async () => {
    const { provider, count, row } = await setup()
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    const error = await provider.executeAtomicBatch({ items: [
      { kind: "command", command: encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "A2" }, expectedVersion: 99, expectedAffectedRows: 1 } as never) },
      { kind: "audit", record: auditRecord("aud-assert") },
    ] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect((error as ConflictError).details).toMatchObject({ reason: "mutation-assertion" })
    expect(String((error as Error).message)).not.toMatch(/expected_affected_rows|D1_ERROR|CHECK/)
    expect(count("dx_audit")).toBe(0)
    expect(row("SELECT name FROM dx_items WHERE id = 'a'")).toEqual({ name: "A" })
  })

  it("a stale expectedVersion aborts every item, while the matching version commits and bumps the version", async () => {
    const { provider, count, row } = await setup()
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    await expect(provider.executeAtomicBatch({ items: [
      { kind: "command", command: encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "A2" }, expectedVersion: 99 } as never) },
      { kind: "audit", record: auditRecord("aud-stale") },
    ] })).rejects.toBeInstanceOf(ConflictError)
    const deletion = encoder.encode({ kind: "delete", entity: "DxItem", filter: Predicate.eq("id", "a"), expectedVersion: 42 } as never)
    await expect(provider.executeAtomicBatch({ items: [{ kind: "command", command: deletion }, { kind: "audit", record: auditRecord("aud-stale-del") }] })).rejects.toBeInstanceOf(ConflictError)
    expect(count("dx_audit")).toBe(0)
    await provider.executeAtomicBatch({ items: [
      { kind: "command", command: encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "A2" }, expectedVersion: 1 } as never) },
      { kind: "audit", record: auditRecord("aud-ok") },
    ] })
    expect(row("SELECT name, version FROM dx_items WHERE id = 'a'")).toEqual({ name: "A2", version: 2 })
    expect(count("dx_audit")).toBe(1)
  })

  it("a versioned command without a mutationAssertionTable fails closed with ConfigurationError", async () => {
    const { provider, count } = await setup({ mutationAssertions: false })
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    await expect(provider.executeAtomicBatch({ items: [
      { kind: "command", command: encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "A2" }, expectedVersion: 99 } as never) },
      { kind: "audit", record: auditRecord("aud-cfg") },
    ] })).rejects.toBeInstanceOf(ConfigurationError)
    expect(count("dx_audit")).toBe(0)
  })

  it("atomic outbox rows carry provenance and enforce scope identity", async () => {
    const { provider, row } = await setup()
    await provider.executeAtomicBatch({ items: [{ kind: "outbox", record: outboxRecord("o1", "key-1") }] })
    expect(JSON.parse(String(row("SELECT provenance FROM dx_outbox WHERE id = 'o1'")!.provenance))).toMatchObject({ marker: "prov" })
    const mismatched = { ...outboxRecord("o2", "key-2"), scopeId: encodeExecutionScopeId({ kind: "platform", platformKey: "other" }) }
    await expect(provider.executeAtomicBatch({ items: [{ kind: "outbox", record: mismatched }] })).rejects.toBeInstanceOf(ConfigurationError)
  })

  it("a failed fence verification is not cached: installing the trigger later makes the same plan succeed", async () => {
    const { d1, provider, row } = await setup({ fence: false })
    d1.sqlite.exec("INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','fp','tok','in-progress')")
    const plan = { items: [{ kind: "idempotency" as const, commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } }] }
    await expect(provider.executeAtomicBatch(plan)).rejects.toBeInstanceOf(ConfigurationError)
    d1.sqlite.exec(FENCE)
    await expect(provider.executeAtomicBatch(plan)).resolves.toHaveLength(1)
    expect(row("SELECT status FROM dx_idempotency WHERE id = 'i1'")).toEqual({ status: "business-committed" })
  })

  it("deduplicates identical outbox items in one plan and rejects a reused key with a different payload", async () => {
    const { provider, count } = await setup()
    const first = outboxRecord("o1", "same-key")
    const results = await provider.executeAtomicBatch({ items: [{ kind: "outbox", record: first }, { kind: "outbox", record: { ...first, id: "o1-dup" } }] })
    expect(results).toHaveLength(2)
    expect(count("dx_outbox")).toBe(1)
    await expect(provider.executeAtomicBatch({ items: [{ kind: "outbox", record: first }, { kind: "outbox", record: { ...first, id: "o3", payload: { n: 2 } } }] }))
      .rejects.toThrow("Outbox idempotency key was reused for a different event")
  })

  it("replaying an identical outbox identity is a no-op, and a different payload under the same key conflicts", async () => {
    const { provider, count } = await setup()
    const record = outboxRecord("o1", "replay-key")
    await provider.executeAtomicBatch({ items: [{ kind: "outbox", record }] })
    const replay = await provider.executeAtomicBatch({ items: [{ kind: "outbox", record: { ...record, id: "o9" } }] })
    expect(replay).toHaveLength(1)
    expect(count("dx_outbox")).toBe(1)
    await expect(provider.executeAtomicBatch({ items: [{ kind: "outbox", record: { ...record, id: "o8", payload: { n: 77 } } }] })).rejects.toBeInstanceOf(ConflictError)
  })

  it("does not replay commands when an existing outbox identity has no committed receipt", async () => {
    const { d1, provider, count } = await setup()
    const record = outboxRecord("o1", "cmd-key")
    await provider.executeAtomicBatch({ items: [{ kind: "outbox", record }] })
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    const command = encoder.encode({ kind: "insert", entity: "DxItem", values: { id: "new", name: "N" } } as never)
    const commit = { scope: "s", key: "k", fingerprint: "fp", token: "tok" }
    const replayPlan = { items: [{ kind: "command" as const, command }, { kind: "outbox" as const, record: { ...record, id: "o2" } }] }
    await expect(provider.executeAtomicBatch(replayPlan)).rejects.toThrow("requires a committed idempotency receipt")
    const withReceipt = { items: [...replayPlan.items, { kind: "idempotency" as const, commit }] }
    await expect(provider.executeAtomicBatch(withReceipt)).rejects.toThrow("no committed idempotency receipt")
    d1.sqlite.exec("INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','other','tok','completed')")
    await expect(provider.executeAtomicBatch(withReceipt)).rejects.toThrow("reused for a different mutation")
    d1.sqlite.exec("UPDATE dx_idempotency SET fingerprint = 'fp', status = 'in-progress'")
    await expect(provider.executeAtomicBatch(withReceipt)).rejects.toThrow("does not have a committed idempotency receipt")
    d1.sqlite.exec("UPDATE dx_idempotency SET status = 'business-committed'")
    const replayed = await provider.executeAtomicBatch(withReceipt)
    expect(replayed).toEqual([{ kind: "command", result: { replayed: true } }, { kind: "outbox", result: { replayed: true } }, { kind: "idempotency", result: { replayed: true } }])
    expect(count("dx_items")).toBe(1)
    const mixed = { items: [{ kind: "command" as const, command }, { kind: "outbox" as const, record: { ...record, id: "o4" } }, { kind: "outbox" as const, record: outboxRecord("o5", "fresh-key") }, { kind: "idempotency" as const, commit }] }
    await expect(provider.executeAtomicBatch(mixed)).rejects.toThrow("both existing and new outbox identities")
  })

  it("rejects outbox items when the outbox table or mapper is missing, and an outbox without the unique contract", async () => {
    const d1 = createFakeD1(SCHEMA)
    const registry = new DrizzleEntityRegistry()
    const noOutbox = createDrizzlePersistenceProvider({ db: drizzle(d1 as never), registry }) as AtomicProvider
    await expect(noOutbox.executeAtomicBatch({ items: [{ kind: "outbox", record: outboxRecord("o1", "k") }] })).rejects.toThrow("require outboxTable and mapOutboxRecord")
    const loose = sqliteTable("dx_outbox", { id: text("id").primaryKey(), idempotencyScope: text("idempotency_scope"), idempotencyKey: text("idempotency_key"), eventFingerprint: text("event_fingerprint") })
    const noUnique = createDrizzlePersistenceProvider({ db: drizzle(d1 as never), registry, outboxTable: loose, mapOutboxRecord: () => ({}) }) as AtomicProvider
    await expect(noUnique.executeAtomicBatch({ items: [{ kind: "outbox", record: outboxRecord("o1", "k") }] })).rejects.toThrow("unique (idempotencyScope,idempotencyKey)")
    const noAudit = createDrizzlePersistenceProvider({ db: drizzle(d1 as never), registry }) as AtomicProvider
    await expect(noAudit.executeAtomicBatch({ items: [{ kind: "audit", record: auditRecord("a1") }] })).rejects.toThrow("require auditTable")
    await expect(noAudit.executeAtomicBatch({ items: [{ kind: "cache-generation", tag: "t" }] })).rejects.toThrow("require tagGenerationTable")
    await expect(noAudit.executeAtomicBatch({ items: [{ kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "f", token: "t" } }] })).rejects.toThrow("ownership-fence-trigger assertion capability")
    expect(await noAudit.executeAtomicBatch({ items: [] })).toEqual([])
  })

  it("cache-generation items upsert and increment the tag generation", async () => {
    const { provider, row } = await setup({ tagGenerations: true })
    await provider.executeAtomicBatch({ items: [{ kind: "cache-generation", tag: "tenant:t1" }] })
    expect(row("SELECT generation FROM dx_tag_generations WHERE tag = 'tenant:t1'")).toEqual({ generation: 1 })
    await provider.executeAtomicBatch({ items: [{ kind: "cache-generation", tag: "tenant:t1" }, { kind: "cache-generation", tag: "other" }] })
    expect(row("SELECT generation FROM dx_tag_generations WHERE tag = 'tenant:t1'")).toEqual({ generation: 2 })
    expect(row("SELECT generation FROM dx_tag_generations WHERE tag = 'other'")).toEqual({ generation: 1 })
  })

  it("rejects a tag generation table without tag and generation columns", async () => {
    const d1 = createFakeD1(SCHEMA)
    const bad = sqliteTable("dx_tag_generations", { id: text("id") })
    const provider = createDrizzlePersistenceProvider({ db: drizzle(d1 as never), registry: new DrizzleEntityRegistry(), tagGenerationTable: bad }) as AtomicProvider
    await expect(provider.executeAtomicBatch({ items: [{ kind: "cache-generation", tag: "t" }] })).rejects.toThrow("tag and generation columns")
  })

  it("enforces configured batch limits before touching the database", async () => {
    const { provider, count } = await setup({ limits: { maxBatchItems: 2 } })
    await expect(provider.executeAtomicBatch({ items: [
      { kind: "audit", record: auditRecord("l1") }, { kind: "audit", record: auditRecord("l2") }, { kind: "audit", record: auditRecord("l3") },
    ] })).rejects.toBeInstanceOf(D1BatchLimitExceededError)
    expect(count("dx_audit")).toBe(0)
    expect(provider.capabilities.maxBatchItems).toBe(2)
  })

  it("validates configured limits", () => {
    const base = { db: drizzle(createFakeD1(SCHEMA) as never), registry: new DrizzleEntityRegistry() }
    for (const limit of ["maxPageSize", "maxBindParams", "maxStatementBytes", "maxBatchItems"] as const) {
      expect(() => createDrizzlePersistenceProvider({ ...base, limits: { [limit]: 0 } })).toThrow(`D1 ${limit} must be a finite positive integer`)
      expect(() => createDrizzlePersistenceProvider({ ...base, limits: { [limit]: 1.5 } })).toThrow(ConfigurationError)
    }
  })

  it("advertises capabilities from its configuration", async () => {
    const { provider } = await setup({ tagGenerations: true })
    expect(provider.dialect).toBe("cloudflare-d1")
    expect(provider.capabilities).toMatchObject({ atomicBatch: true, atomicBatchScope: "unscoped", atomicBatchIdempotency: true, atomicBatchCacheGeneration: true, interactiveTransactions: false })
    const plainSession = { select: () => ({}), insert: () => ({}), update: () => ({}), delete: () => ({}) } as never
    const bare = createDrizzlePersistenceProvider({ db: plainSession, registry: new DrizzleEntityRegistry() }) as AtomicProvider
    expect(bare.capabilities.atomicBatch).toBe(false)
    expect(bare.capabilities.atomicBatchIdempotency).toBeUndefined()
    expect(bare.executeAtomicBatch).toBeUndefined()
    expect(getDrizzleSession(bare)).toBe(plainSession)
    expect(() => getDrizzleSession({} as never)).toThrow("No Drizzle session found")
  })

  it("accepts a prebuilt adapter and exposes its session", async () => {
    const d1 = createFakeD1(SCHEMA)
    const adapter = createDrizzleD1Adapter(drizzle(d1 as never) as never)
    const provider = createDrizzlePersistenceProvider({ db: adapter, registry: new DrizzleEntityRegistry() })
    expect(getDrizzleSession(provider)).toBe(adapter.repository)
  })
})

describe("D1 provider repositories and registry", () => {
  it("returns repositories for registered entities and rejects unregistered ones", async () => {
    const { provider } = await setup()
    const repo = provider.repository(tenantEntity) as unknown as { findById(id: string): Promise<{ name: string } | null> }
    expect((await repo.findById("a"))?.name).toBe("A")
    expect(() => provider.repository({ name: "Ghost", fields: { id: {} }, primaryKey: "id" } as never)).toThrow('Entity "Ghost" is not registered')
  })

  it("registry rejects duplicates and malformed registrations", () => {
    const registry = new DrizzleEntityRegistry().register(plainEntity, plainItems, { id: plainItems.id, label: plainItems.label })
    expect(registry.get("DxPlain")?.table).toBe(plainItems)
    expect(registry.get("DxPlain", "ns")).toBeUndefined()
    expect(() => registry.register(plainEntity, plainItems, { id: plainItems.id, label: plainItems.label })).toThrow("already registered")
    const fresh = () => new DrizzleEntityRegistry()
    const column = { id: plainItems.id, label: plainItems.label }
    expect(() => fresh().register({ name: " ", fields: { id: {} } } as never, plainItems, column)).toThrow("non-empty entity name")
    expect(() => fresh().register({ name: "E", fields: {} } as never, plainItems, column)).toThrow("must declare fields")
    expect(() => fresh().register(plainEntity, plainItems, { ...column, "": plainItems.id })).toThrow("empty column map key")
    expect(() => fresh().register(plainEntity, plainItems, { id: plainItems.id })).toThrow("missing fields: label")
    expect(() => fresh().register({ name: "E", fields: { label: {} } } as never, plainItems, column)).toThrow('primary key "id" is not a declared field')
    expect(() => fresh().register({ name: "E", fields: { id: {} }, versionField: "v" } as never, plainItems, { id: plainItems.id })).toThrow('version field "v"')
    const namespaced = fresh().register(plainEntity, plainItems, column, "tenants")
    expect(namespaced.get("DxPlain", "tenants")?.table).toBe(plainItems)
    expect(namespaced.get("DxPlain")).toBeUndefined()
  })

  it("maps audit records to the default column shape", () => {
    const record = { ...auditRecord("a1"), oldValue: { n: 1 }, newValue: { n: 2 }, metadata: { m: true } } as never
    expect(mapAuditRecord(record)).toMatchObject({ id: "a1", tenantId: "t1", actorId: "actor", actorType: "human", oldValue: '{"n":1}', newValue: '{"n":2}', metadata: '{"m":true}', impersonatedByAdminId: null })
    expect(mapAuditRecord(auditRecord("a2"))).toMatchObject({ oldValue: null, newValue: null, metadata: null })
  })
})

describe("D1 provider command encoders", () => {
  it("tenant encoder scopes inserts, injects the initial version and rejects cross-tenant or protected writes", async () => {
    const { provider, row } = await setup()
    const encoder = provider.createTenantScopedCommandEncoder("t1")
    await provider.executeAtomicBatch({ items: [{ kind: "command", command: encoder.encode({ kind: "insert", entity: "DxItem", values: { id: "n1", name: "N1" } } as never) }] })
    expect(row("SELECT tenant_id, version FROM dx_items WHERE id = 'n1'")).toEqual({ tenant_id: "t1", version: 1 })
    expect(() => encoder.encode({ kind: "insert", entity: "DxItem", values: { id: "n2", name: "N2", tenantId: "t2" } } as never)).toThrow("targets another tenant")
    expect(() => encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { tenantId: "t2" }, expectedVersion: 1 } as never)).toThrow(TenantScopeViolationError)
    expect(() => encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { version: 7 }, expectedVersion: 1 } as never)).toThrow(ImmutableFieldViolationError)
    expect(() => encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "x" } } as never)).toThrow("requires expectedVersion")
    expect(() => encoder.encode({ kind: "delete", entity: "DxItem", filter: Predicate.eq("id", "a") } as never)).toThrow("requires expectedVersion")
    expect(() => encoder.encode({ kind: "insert", entity: "DxGlobal", values: { id: "g", name: "G" } } as never)).toThrow("is not tenant-scoped")
    expect(() => encoder.encode({ select: true } as never)).toThrow("reject opaque Drizzle queries")
  })

  it("tenant encoder cannot touch another tenant's rows", async () => {
    const { provider, row } = await setup()
    const encoder = provider.createTenantScopedCommandEncoder("t2")
    const error = await provider.executeAtomicBatch({ items: [
      { kind: "command", command: encoder.encode({ kind: "update", entity: "DxItem", filter: Predicate.eq("id", "a"), values: { name: "stolen" }, expectedVersion: 1 } as never) },
    ] }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConflictError)
    expect(row("SELECT name FROM dx_items WHERE id = 'a'")).toEqual({ name: "A" })
  })

  it("unscoped batches encode global entities for insert, versioned update/delete and unversioned update/delete", async () => {
    const { provider, row, count } = await setup()
    const run = (command: Record<string, unknown>) => provider.executeAtomicBatch({ items: [{ kind: "command", command: command as never }] })
    await run({ kind: "insert", entity: "DxGlobal", values: { id: "g1", name: "G1" } })
    expect(row("SELECT version FROM dx_global_items WHERE id = 'g1'")).toEqual({ version: 1 })
    await run({ kind: "update", entity: "DxGlobal", filter: Predicate.eq("id", "g1"), values: { name: "G1b" }, expectedVersion: 1 })
    expect(row("SELECT name, version FROM dx_global_items WHERE id = 'g1'")).toEqual({ name: "G1b", version: 2 })
    await expect(run({ kind: "update", entity: "DxGlobal", filter: Predicate.eq("id", "g1"), values: { name: "x" }, expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictError)
    await expect(run({ kind: "update", entity: "DxGlobal", filter: Predicate.eq("id", "g1"), values: { name: "x" } })).rejects.toThrow("requires expectedVersion")
    await expect(run({ kind: "delete", entity: "DxGlobal", filter: Predicate.eq("id", "g1") })).rejects.toThrow("requires expectedVersion")
    await expect(run({ kind: "delete", entity: "DxGlobal", filter: Predicate.eq("id", "g1"), expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictError)
    await run({ kind: "delete", entity: "DxGlobal", filter: Predicate.eq("id", "g1"), expectedVersion: 2 })
    expect(count("dx_global_items")).toBe(0)
    await run({ kind: "insert", entity: "DxPlain", values: { id: "p1", label: "L" } })
    await run({ kind: "update", entity: "DxPlain", filter: Predicate.eq("id", "p1"), values: { label: "L2" } })
    expect(row("SELECT label FROM dx_plain_items WHERE id = 'p1'")).toEqual({ label: "L2" })
    await run({ kind: "delete", entity: "DxPlain", filter: Predicate.eq("id", "p1") })
    expect(count("dx_plain_items")).toBe(0)
    await expect(run({ kind: "insert", entity: "Nope", values: {} })).rejects.toThrow("is not registered")
    await expect(run({ kind: "insert", entity: "DxItem", values: { id: "q", name: "Q", tenantId: "t1" } })).rejects.toThrow("must not be tenant-scoped")
    await expect(run({ kind: "insert", entity: "DxGlobal", values: { id: "g2", name: "G2", bogus: 1 } })).rejects.toThrow('does not map field "bogus"')
  })

  it("passes opaque drizzle statements and encoded statements straight through", async () => {
    const { db, provider, count } = await setup()
    const statement = db.insert(items).values({ id: "raw1", tenantId: "t1", name: "Raw", version: 1 })
    const results = await provider.executeAtomicBatch({ items: [{ kind: "command", command: statement as never }] })
    expect(results).toHaveLength(1)
    expect(count("dx_items")).toBe(2)
    const encoded = { kind: "statement", statement: db.insert(items).values({ id: "raw2", tenantId: "t1", name: "Raw2", version: 1 }) }
    await provider.executeAtomicBatch({ items: [{ kind: "command", command: encoded as never }] })
    expect(count("dx_items")).toBe(3)
    const withoutTable = { kind: "statement", statement: db.insert(items).values({ id: "raw3", tenantId: "t1", name: "Raw3", version: 1 }), expectedAffectedRows: 1 }
    await provider.executeAtomicBatch({ items: [{ kind: "command", command: withoutTable as never }] })
    expect(count("dx_items")).toBe(4)
  })

  it("an idempotent batch fails with ConfigurationError when the receipt update matches no row", async () => {
    const { d1, provider, count } = await setup()
    d1.sqlite.exec("INSERT INTO dx_idempotency (id, scope, key, fingerprint, token, status) VALUES ('i1','s','k','fp','tok','in-progress')")
    // The assertion trigger sees an in-progress row, so only the receipt mismatch (wrong status afterwards) can fail the result check.
    d1.sqlite.exec("CREATE TRIGGER dx_noop_receipt BEFORE UPDATE ON dx_idempotency BEGIN SELECT RAISE(IGNORE); END")
    await expect(provider.executeAtomicBatch({ items: [
      { kind: "audit", record: auditRecord("aud-r") },
      { kind: "idempotency", commit: { scope: "s", key: "k", fingerprint: "fp", token: "tok" } },
    ] })).rejects.toThrow("receipt update affected exactly one row")
    // The batch itself committed (the receipt ran but changed nothing); the guard reports the inconsistency.
    expect(count("dx_audit")).toBe(1)
  })
})
