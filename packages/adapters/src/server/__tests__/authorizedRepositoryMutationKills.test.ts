import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, ForbiddenError, Predicate, bindAbacSecurityDigest, type AbacAuthorizer, type FieldReadOverride, type NormalizedAbacPolicy, type PredicateNode, type VerifiedAbacPolicyBundle } from "@xonava/core/domain"
import type { EntityDescriptor, VersionedRepository } from "@xonava/core/persistence"
import { createAuthorizedRepository } from "../authorizedRepository"

interface Row extends Record<string, unknown> {
  id: string
  tenantId: string
  name: string
  status: string
  version: number
}

const structural = Predicate.eq("tenantId", "t1")
const actionScope = Predicate.eq("owner", "me")
const page1 = { kind: "offset", page: 1, pageSize: 1 }

function entity(overrides: Record<string, unknown> = {}): EntityDescriptor<Row> {
  return {
    name: "widget",
    primaryKey: "id",
    tenantField: "tenantId",
    versionField: "version",
    immutableFields: ["createdAt"],
    fields: { id: { type: "string" }, tenantId: { type: "string" }, name: { type: "string" }, status: { type: "string" }, version: { type: "number" } },
    ...overrides,
  } as EntityDescriptor<Row>
}

function row(id: string, version = 1, extra: Record<string, unknown> = {}): Row {
  return { id, tenantId: "t1", name: `n-${id}`, status: "active", version, ...extra }
}

function result(rows: Row[]) {
  return { rows, rowCount: rows.length, page: 1, pageSize: 100 }
}

interface RepoHandle {
  repo: VersionedRepository<Row, string>
  findMany: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  updateOneWhereReturning: ReturnType<typeof vi.fn>
  deleteWhere: ReturnType<typeof vi.fn>
}

/** findMany answers come from the queue, in order; the last one repeats. */
function createRepo(findManyAnswers: Row[][], opts: { updated?: Row | null; deletedCount?: number; inserted?: Row } = {}): RepoHandle {
  let call = 0
  const findMany = vi.fn(async (_args: unknown) => result(findManyAnswers[Math.min(call++, findManyAnswers.length - 1)] ?? []))
  const insert = vi.fn(async (input: Record<string, unknown>) => (opts.inserted ?? input) as Row)
  const updateOneWhereReturning = vi.fn(async (_filter: unknown, _patch: unknown, _options: unknown) => (opts.updated === undefined ? row("1", 2) : opts.updated))
  const deleteWhere = vi.fn(async (_filter: unknown, _options: unknown) => ({ deletedCount: opts.deletedCount ?? 1 }))
  const repo = { findMany, insert, updateOneWhereReturning, deleteWhere } as unknown as VersionedRepository<Row, string>
  return { repo, findMany, insert, updateOneWhereReturning, deleteWhere }
}

interface AuthHandle {
  authorizer: AbacAuthorizer
  assertCollectionAction: ReturnType<typeof vi.fn>
  assertWrite: ReturnType<typeof vi.fn>
  fieldReadPlan: ReturnType<typeof vi.fn>
}

function createAuth(opts: { scope?: PredicateNode | undefined; plan?: (record: unknown) => Record<string, FieldReadOverride> } = {}): AuthHandle {
  const scope = "scope" in opts ? opts.scope : actionScope
  const assertCollectionAction = vi.fn((_action: string) => ({ allowed: true, scope, reasonCode: "ACTION_SCOPE_AVAILABLE", evidence: [] }))
  const assertWrite = vi.fn()
  const fieldReadPlan = vi.fn((record: unknown) => (opts.plan ? opts.plan(record) : {}))
  return { authorizer: { assertCollectionAction, assertWrite, fieldReadPlan } as unknown as AbacAuthorizer, assertCollectionAction, assertWrite, fieldReadPlan }
}

function build(handle: RepoHandle, auth: AuthHandle, extra: { entity?: EntityDescriptor<Row>; structuralInsertValues?: Partial<Row>; bundle?: VerifiedAbacPolicyBundle } = {}) {
  return createAuthorizedRepository<Row, string>({
    repository: handle.repo,
    entity: extra.entity ?? entity(),
    authorizer: auth.authorizer,
    structuralScope: structural,
    ...(extra.structuralInsertValues ? { structuralInsertValues: extra.structuralInsertValues } : {}),
    ...(extra.bundle ? { bundle: extra.bundle } : {}),
  })
}

async function errorOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected rejection")
}

describe("createAuthorizedRepository construction", () => {
  it("rejects a forged bundle and accepts none", () => {
    const forged = { defaultEffect: "deny", securityDigest: "x", policies: [], moduleKey: "m", fieldCatalog: {} } as never
    expect(() => build(createRepo([[]]), createAuth(), { bundle: forged })).toThrow("ABAC bundle is not a verified production bundle")
    expect(() => build(createRepo([[]]), createAuth())).not.toThrow()
  })

  it("requires updateOneWhereReturning, deleteWhere and versionField with exact messages", () => {
    const noUpdate = createRepo([[]])
    delete (noUpdate.repo as unknown as Record<string, unknown>).updateOneWhereReturning
    expect(() => build(noUpdate, createAuth())).toThrow(new ConfigurationError('Authorized repository for "widget" requires updateOneWhereReturning support'))
    const noDelete = createRepo([[]])
    delete (noDelete.repo as unknown as Record<string, unknown>).deleteWhere
    expect(() => build(noDelete, createAuth())).toThrow(new ConfigurationError('Authorized repository for "widget" requires deleteWhere support'))
    expect(() => build(createRepo([[]]), createAuth(), { entity: entity({ versionField: undefined }) })).toThrow(new ConfigurationError('Authorized repository for "widget" requires a versionField for optimistic concurrency'))
  })
})

describe("findMany", () => {
  it("builds the access filter from structural scope, action scope and caller filter and forwards pagination and sort", async () => {
    const handle = createRepo([[row("1")]])
    const auth = createAuth()
    const caller = Predicate.eq("name", "x")
    const sort = [{ field: "name", direction: "asc" as const }]
    const pagination = { kind: "offset" as const, page: 2, pageSize: 5 }
    const out = await build(handle, auth).findMany({ filter: caller, pagination, sort })
    expect(auth.assertCollectionAction.mock.calls).toEqual([["read"]])
    expect(handle.findMany.mock.calls).toStrictEqual([[{ filter: Predicate.and(structural, actionScope, caller), pagination, sort }]])
    expect(out).toEqual({ rows: [row("1")], rowCount: 1, page: 1, pageSize: 100 })
  })

  it("omits pagination and sort keys when not given and leaves out a missing action scope and caller filter", async () => {
    const handle = createRepo([[]])
    await build(handle, createAuth({ scope: undefined })).findMany()
    const call = handle.findMany.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.keys(call)).toEqual(["filter"])
    expect(call.filter).toEqual(Predicate.and(structural))
    await build(handle, createAuth({ scope: undefined })).findMany({ sort: [] })
    expect(Object.keys(handle.findMany.mock.calls[1]?.[0] as object).sort()).toEqual(["filter", "sort"])
  })

  it("redacts every returned row through the field read plan", async () => {
    const handle = createRepo([[row("1"), row("2")]])
    const auth = createAuth({ plan: () => ({ status: "omit" }) })
    const out = await build(handle, auth).findMany()
    expect(out.rows).toEqual([{ id: "1", tenantId: "t1", name: "n-1", version: 1 }, { id: "2", tenantId: "t1", name: "n-2", version: 1 }])
    expect(auth.fieldReadPlan.mock.calls).toEqual([[row("1")], [row("2")]])
  })

  it("does not consult the read plan up front without caller filter or sort", async () => {
    const handle = createRepo([[]])
    const auth = createAuth({ plan: () => ({ "*": "omit" }) })
    await build(handle, auth).findMany()
    await build(handle, auth).findMany({ filter: Predicate.literal(true) })
    await build(handle, auth).findMany({ sort: [] })
    expect(auth.fieldReadPlan).not.toHaveBeenCalled()
  })

  it("checks the base plan once and every returned row again when filtering or sorting", async () => {
    const handle = createRepo([[row("1"), row("2")]])
    const auth = createAuth()
    await build(handle, auth).findMany({ filter: Predicate.eq("status", "active") })
    expect(auth.fieldReadPlan.mock.calls).toEqual([[{}], [row("1")], [row("2")], [row("1")], [row("2")]])
    auth.fieldReadPlan.mockClear()
    await build(handle, auth).findMany({ sort: [{ field: "name", direction: "asc" }] })
    expect(auth.fieldReadPlan.mock.calls).toHaveLength(5)
  })

  it("rejects filter fields that the base plan masks or omits, with the exact error", async () => {
    const handle = createRepo([[]])
    const auth = createAuth({ plan: () => ({ status: "mask" }) })
    const error = await errorOf(build(handle, auth).findMany({ filter: Predicate.eq("status", "a") }))
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.message).toBe("Querying field(s) status via filter is not permitted by policy")
    expect(handle.findMany).not.toHaveBeenCalled()
    const sortError = await errorOf(build(handle, auth).findMany({ sort: [{ field: "status", direction: "desc" }] }))
    expect(sortError.message).toBe("Querying field(s) status via sort is not permitted by policy")
    expect(handle.findMany).not.toHaveBeenCalled()
  })

  it("walks and, or, not and condition nodes but ignores literals when collecting filter fields", async () => {
    const auth = createAuth({ plan: () => ({ "*": "omit", name: "allow" }) })
    const deny = async (filter: PredicateNode) => (await errorOf(build(createRepo([[]]), auth).findMany({ filter }))).message
    expect(await deny(Predicate.and(Predicate.eq("name", "a"), Predicate.or(Predicate.eq("name", "b"), Predicate.not(Predicate.eq("status", "c")))))).toBe("Querying field(s) status via filter is not permitted by policy")
    expect(await deny(Predicate.not(Predicate.eq("status", "c")))).toBe("Querying field(s) status via filter is not permitted by policy")
    expect(await deny(Predicate.or(Predicate.eq("name", "a"), Predicate.eq("status", "c")))).toBe("Querying field(s) status via filter is not permitted by policy")
    expect(await deny(Predicate.and(Predicate.eq("tenantId", "a"), Predicate.eq("status", "b")))).toBe("Querying field(s) tenantId, status via filter is not permitted by policy")
    const handle = createRepo([[]])
    await expect(build(handle, auth).findMany({ filter: Predicate.and(Predicate.literal(false), Predicate.eq("name", "a")) })).resolves.toBeDefined()
    await expect(build(handle, auth).findMany({ filter: Predicate.and(Predicate.eq("name", "a"), Predicate.literal(true), Predicate.not(Predicate.literal(false))) })).resolves.toBeDefined()
  })

  it("applies per-field and default read plan semantics", async () => {
    const check = async (plan: Record<string, FieldReadOverride>, field: string) => {
      const auth = createAuth({ plan: () => plan })
      return build(createRepo([[]]), auth).findMany({ filter: Predicate.eq(field, "v") }).then(() => true, () => false)
    }
    expect(await check({}, "status")).toBe(true)
    expect(await check({ status: "allow" }, "status")).toBe(true)
    expect(await check({ status: "mask" }, "status")).toBe(false)
    expect(await check({ status: "omit" }, "status")).toBe(false)
    expect(await check({ "*": "allow" }, "status")).toBe(true)
    expect(await check({ "*": "mask" }, "status")).toBe(false)
    expect(await check({ "*": "omit" }, "status")).toBe(false)
    expect(await check({ "*": "omit", status: "allow" }, "status")).toBe(true)
    expect(await check({ "*": "allow", status: "omit" }, "status")).toBe(false)
    expect(await check({ "*": "omit" }, "*")).toBe(false)
    expect(await check({ name: "omit" }, "status")).toBe(true)
  })

  it("re-checks row-conditional plans on every returned row", async () => {
    const handle = createRepo([[row("1"), row("2", 1, { status: "secret" })]])
    const auth = createAuth({ plan: (record) => ((record as Partial<Row>).status === "secret" ? { name: "mask" } : {}) })
    const error = await errorOf(build(handle, auth).findMany({ filter: Predicate.eq("name", "x") }))
    expect(error.message).toBe("Querying field(s) name via filter is not permitted by policy")
    const sortError = await errorOf(build(handle, auth).findMany({ sort: [{ field: "name", direction: "asc" }] }))
    expect(sortError.message).toBe("Querying field(s) name via sort is not permitted by policy")
  })

  async function maskedBundle(): Promise<VerifiedAbacPolicyBundle> {
    const policy: NormalizedAbacPolicy = {
      source: { policyId: "p", scopeType: "tenant_default" },
      moduleKey: "mod",
      effect: "allow",
      priority: 1,
      payload: { actions: ["read"], capabilities: [], conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } }, fieldAccess: { read: { status: "mask", name: "allow" } } },
      compiledConditions: Predicate.alwaysTrue(),
    }
    return bindAbacSecurityDigest({ mode: "tenant", moduleKey: "mod", policies: [policy], context: { tenantId: "t1" }, defaultEffect: "deny", fieldCatalog: {} })
  }

  it("uses static bundle denials with the right mode and skips the dynamic plan checks", async () => {
    const bundle = await maskedBundle()
    const auth = createAuth()
    const handle = createRepo([[row("1")]])
    const repo = build(handle, auth, { bundle })
    expect((await errorOf(repo.findMany({ filter: Predicate.eq("status", "a") }))).message).toBe("Querying field(s) status via filter is not permitted by policy")
    expect((await errorOf(repo.findMany({ sort: [{ field: "status", direction: "asc" }] }))).message).toBe("Querying field(s) status via sort is not permitted by policy")
    expect(handle.findMany).not.toHaveBeenCalled()
    await repo.findMany({ filter: Predicate.eq("name", "a"), sort: [{ field: "name", direction: "asc" }] })
    // Only redaction reads the plan when a bundle decides query access.
    expect(auth.fieldReadPlan.mock.calls).toEqual([[row("1")]])
  })
})

describe("findById", () => {
  it("looks the id up under the scope with a one-row page and redacts the row", async () => {
    const handle = createRepo([[row("7")]])
    const auth = createAuth({ plan: () => ({ status: "omit" }) })
    const out = await build(handle, auth).findById("7")
    expect(auth.assertCollectionAction.mock.calls).toEqual([["read"]])
    expect(handle.findMany.mock.calls).toEqual([[{ filter: Predicate.and(structural, actionScope, Predicate.eq("id", "7")), pagination: page1 }]])
    expect(out).toEqual({ id: "7", tenantId: "t1", name: "n-7", version: 1 })
  })

  it("returns null when nothing matches and honours a custom or default primary key", async () => {
    expect(await build(createRepo([[]]), createAuth()).findById("x")).toBeNull()
    const custom = createRepo([[]])
    await build(custom, createAuth(), { entity: entity({ primaryKey: "uuid" }) }).findById("u")
    expect((custom.findMany.mock.calls[0]?.[0] as { filter: PredicateNode }).filter).toEqual(Predicate.and(structural, actionScope, Predicate.eq("uuid", "u")))
    const dflt = createRepo([[]])
    await build(dflt, createAuth(), { entity: entity({ primaryKey: undefined }) }).findById("d")
    expect((dflt.findMany.mock.calls[0]?.[0] as { filter: PredicateNode }).filter).toEqual(Predicate.and(structural, actionScope, Predicate.eq("id", "d")))
  })
})

describe("insert", () => {
  it("rejects primary key, tenant, version and immutable fields with the exact error", async () => {
    const repo = build(createRepo([[]]), createAuth())
    const error = await errorOf(repo.insert({ id: "1", tenantId: "t", version: 1, createdAt: "x", name: "n" } as never))
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.message).toBe("Cannot set immutable fields on widget: id, tenantId, version, createdAt")
    expect((error as ForbiddenError).details).toEqual({ fields: ["id", "tenantId", "version", "createdAt"] })
    expect((await errorOf(repo.insert({ createdAt: "x" } as never))).message).toBe("Cannot set immutable fields on widget: createdAt")
  })

  it("writes structural values over the input, authorizes create and verifies the committed row under read scope", async () => {
    const inserted = row("9", 3)
    const handle = createRepo([[row("9", 3)]], { inserted })
    const auth = createAuth({ plan: () => ({ status: "omit" }) })
    const repo = build(handle, auth, { structuralInsertValues: { tenantId: "t1", name: "forced" } })
    const out = await repo.insert({ name: "caller", status: "new" })
    const safeInput = { name: "forced", status: "new", tenantId: "t1" }
    expect(auth.assertWrite.mock.calls).toEqual([[{ action: "create", record: safeInput, changedFields: ["name", "status", "tenantId"] }]])
    expect(handle.insert.mock.calls).toEqual([[safeInput]])
    expect(handle.findMany.mock.calls).toEqual([[{ filter: Predicate.and(Predicate.and(structural, actionScope, Predicate.eq("id", "9")), Predicate.eq("version", 3)), pagination: page1 }]])
    expect(out).toEqual({ applied: true, row: { id: "9", tenantId: "t1", name: "n-9", version: 3 } })
    expect(auth.assertCollectionAction.mock.calls).toEqual([["read"]])
  })

  it("skips the version fence when the inserted row carries no version and rejects an invalid one", async () => {
    const noVersion = { id: "5", tenantId: "t1", name: "n", status: "s" } as unknown as Row
    const handle = createRepo([[row("5")]], { inserted: noVersion })
    await build(handle, createAuth()).insert({ name: "n" })
    expect((handle.findMany.mock.calls[0]?.[0] as { filter: PredicateNode }).filter).toEqual(Predicate.and(structural, actionScope, Predicate.eq("id", "5")))
    const bad = createRepo([[row("5")]], { inserted: row("5", -1) })
    expect((await errorOf(build(bad, createAuth()).insert({ name: "n" }))).message).toBe("Entity version must be a non-negative safe integer.")
    expect(bad.findMany).not.toHaveBeenCalled()
    const zero = createRepo([[row("5", 0)]], { inserted: row("5", 0) })
    await build(zero, createAuth()).insert({ name: "n" })
    expect((zero.findMany.mock.calls[0]?.[0] as { filter: PredicateNode }).filter).toEqual(Predicate.and(Predicate.and(structural, actionScope, Predicate.eq("id", "5")), Predicate.eq("version", 0)))
  })

  it("reports CREATED_OUTSIDE_READ_SCOPE without exposing the row", async () => {
    const handle = createRepo([[]], { inserted: row("9") })
    const out = await build(handle, createAuth()).insert({ name: "n" })
    expect(out).toStrictEqual({ applied: true, reason: "CREATED_OUTSIDE_READ_SCOPE" })
  })

  it("does not insert when the write is denied", async () => {
    const handle = createRepo([[]])
    const auth = createAuth()
    auth.assertWrite.mockImplementation(() => { throw new ForbiddenError("no") })
    await expect(build(handle, auth).insert({ name: "n" })).rejects.toThrow("no")
    expect(handle.insert).not.toHaveBeenCalled()
  })
})

describe("update", () => {
  it("rejects protected fields in the patch with the exact error and details", async () => {
    const repo = build(createRepo([[row("1")]]), createAuth())
    const error = await errorOf(repo.update("1", { id: "2", tenantId: "t", version: 9, createdAt: "x", name: "n" } as never, { expectedVersion: 1 }))
    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.message).toBe("Cannot modify immutable or protected fields on widget: id, tenantId, version, createdAt")
    expect((error as ForbiddenError).details).toEqual({ fields: ["id", "tenantId", "version", "createdAt"] })
  })

  it("fences the lookup, authorizes both images, updates conditionally and verifies the committed version", async () => {
    const existing = row("1", 4)
    const committed = row("1", 5, { name: "new" })
    const handle = createRepo([[existing], [committed]], { updated: committed })
    const auth = createAuth({ plan: () => ({ status: "omit" }) })
    const out = await build(handle, auth).update("1", { name: "new" }, { expectedVersion: 4 })
    const fence = Predicate.and(Predicate.eq("id", "1"), Predicate.eq("version", 4))
    const filter = Predicate.and(structural, actionScope, fence)
    expect(auth.assertCollectionAction.mock.calls).toEqual([["update"], ["read"]])
    expect(handle.findMany.mock.calls[0]).toEqual([{ filter, pagination: page1 }])
    expect(auth.assertWrite.mock.calls).toEqual([[{ action: "update", record: { ...existing, name: "new" }, existing, changedFields: ["name"] }]])
    expect(handle.updateOneWhereReturning.mock.calls).toEqual([[filter, { name: "new" }, { optimisticConcurrency: { expectedVersion: 4 } }]])
    expect(handle.findMany.mock.calls[1]).toEqual([{ filter: Predicate.and(Predicate.and(structural, actionScope, Predicate.eq("id", "1")), Predicate.eq("version", 5)), pagination: page1 }])
    expect(out).toEqual({ applied: true, row: { id: "1", tenantId: "t1", name: "new", version: 5 } })
  })

  it("does not mutate the caller's patch object", async () => {
    const patch = { name: "new" }
    await build(createRepo([[row("1")], [row("1", 2)]]), createAuth()).update("1", patch, { expectedVersion: 1 })
    expect(patch).toStrictEqual({ name: "new" })
  })

  it("returns CONFLICT when the fenced lookup or the conditional update finds nothing", async () => {
    const none = createRepo([[]])
    const auth = createAuth()
    expect(await build(none, auth).update("1", { name: "n" }, { expectedVersion: 1 })).toStrictEqual({ applied: false, reason: "CONFLICT" })
    expect(none.updateOneWhereReturning).not.toHaveBeenCalled()
    expect(auth.assertWrite).not.toHaveBeenCalled()
    const lost = createRepo([[row("1")]], { updated: null })
    expect(await build(lost, createAuth()).update("1", { name: "n" }, { expectedVersion: 1 })).toStrictEqual({ applied: false, reason: "CONFLICT" })
    expect(lost.findMany).toHaveBeenCalledTimes(1)
  })

  it("reports UPDATED_OUTSIDE_READ_SCOPE when the committed row leaves the read scope", async () => {
    const handle = createRepo([[row("1")], []], { updated: row("1", 2) })
    expect(await build(handle, createAuth()).update("1", { name: "n" }, { expectedVersion: 1 })).toStrictEqual({ applied: true, reason: "UPDATED_OUTSIDE_READ_SCOPE" })
  })

  it("rejects missing or malformed expected and stored versions before touching the repository", async () => {
    const message = "Entity version must be a non-negative safe integer."
    const handle = createRepo([[row("1")]])
    const repo = build(handle, createAuth())
    expect((await errorOf(repo.update("1", { name: "n" }, { expectedVersion: undefined } as never))).message).toBe(message)
    expect((await errorOf(repo.update("1", { name: "n" }, { expectedVersion: -1 } as never))).message).toBe(message)
    expect((await errorOf(repo.update("1", { name: "n" }, { expectedVersion: "1" } as never))).message).toBe(message)
    expect(handle.findMany).not.toHaveBeenCalled()
    const corrupt = createRepo([[{ ...row("1"), version: "x" } as unknown as Row]])
    expect((await errorOf(build(corrupt, createAuth()).update("1", { name: "n" }, { expectedVersion: 1 }))).message).toBe(message)
    expect(corrupt.updateOneWhereReturning).not.toHaveBeenCalled()
    const badCommit = createRepo([[row("1")]], { updated: { ...row("1"), version: -3 } })
    expect((await errorOf(build(badCommit, createAuth()).update("1", { name: "n" }, { expectedVersion: 1 }))).message).toBe(message)
    expect(badCommit.findMany).toHaveBeenCalledTimes(1)
    const zero = createRepo([[row("1", 0)], [row("1", 1)]], { updated: row("1", 1) })
    expect(await build(zero, createAuth()).update("1", { name: "n" }, { expectedVersion: 0 })).toMatchObject({ applied: true })
  })

  it("fails closed when the entity loses its versionField after construction", async () => {
    const mutable = entity()
    const handle = createRepo([[row("1")]])
    const repo = build(handle, createAuth(), { entity: mutable })
    delete (mutable as { versionField?: string }).versionField
    const withVersion = await errorOf(repo.update("1", { name: "n" }, { expectedVersion: 1 }))
    expect(withVersion).toBeInstanceOf(ConfigurationError)
    expect(withVersion.message).toBe('Entity "widget" has no versionField declared. Add versionField to the entity descriptor to use expectedVersion.')
    const withoutVersion = await errorOf(repo.update("1", { name: "n" }, { expectedVersion: undefined } as never))
    expect(withoutVersion).toBeInstanceOf(ConfigurationError)
    expect(withoutVersion.message).toBe('Authorized update for "widget" requires versionField optimistic concurrency')
    expect(handle.findMany).not.toHaveBeenCalled()
  })

  it("fails closed when updateOneWhereReturning disappears after construction", async () => {
    const handle = createRepo([[row("1")]])
    const repo = build(handle, createAuth())
    delete (handle.repo as unknown as Record<string, unknown>).updateOneWhereReturning
    const error = await errorOf(repo.update("1", { name: "n" }, { expectedVersion: 1 }))
    expect(error).toBeInstanceOf(ConfigurationError)
    expect(error.message).toBe("Authorized repository requires updateOneWhereReturning support")
  })

  it("does not update when the write is denied", async () => {
    const handle = createRepo([[row("1")]])
    const auth = createAuth()
    auth.assertWrite.mockImplementation(() => { throw new ForbiddenError("denied") })
    await expect(build(handle, auth).update("1", { name: "n" }, { expectedVersion: 1 })).rejects.toThrow("denied")
    expect(handle.updateOneWhereReturning).not.toHaveBeenCalled()
  })
})

describe("delete", () => {
  it("fences the lookup and delete on id and version under the delete scope", async () => {
    const existing = row("1", 3)
    const handle = createRepo([[existing]], { deletedCount: 1 })
    const auth = createAuth()
    const out = await build(handle, auth).delete("1", { expectedVersion: 3 })
    const filter = Predicate.and(structural, actionScope, Predicate.and(Predicate.eq("id", "1"), Predicate.eq("version", 3)))
    expect(auth.assertCollectionAction.mock.calls).toEqual([["delete"]])
    expect(handle.findMany.mock.calls).toEqual([[{ filter, pagination: page1 }]])
    expect(auth.assertWrite.mock.calls).toEqual([[{ action: "delete", record: existing }]])
    expect(handle.deleteWhere.mock.calls).toEqual([[filter, { optimisticConcurrency: { expectedVersion: 3 } }]])
    expect(out).toStrictEqual({ applied: true })
  })

  it("returns NOT_FOUND without deleting and CONFLICT when the delete removes nothing", async () => {
    const none = createRepo([[]])
    const auth = createAuth()
    expect(await build(none, auth).delete("1", { expectedVersion: 1 })).toStrictEqual({ applied: false, reason: "NOT_FOUND" })
    expect(auth.assertWrite).not.toHaveBeenCalled()
    expect(none.deleteWhere).not.toHaveBeenCalled()
    const lost = createRepo([[row("1")]], { deletedCount: 0 })
    expect(await build(lost, createAuth()).delete("1", { expectedVersion: 1 })).toStrictEqual({ applied: false, reason: "CONFLICT" })
  })

  it("rejects an invalid expected version and a missing versionField or deleteWhere after construction", async () => {
    const handle = createRepo([[row("1")]])
    const repo = build(handle, createAuth())
    expect((await errorOf(repo.delete("1", { expectedVersion: undefined } as never))).message).toBe("Entity version must be a non-negative safe integer.")
    expect(handle.findMany).not.toHaveBeenCalled()
    delete (handle.repo as unknown as Record<string, unknown>).deleteWhere
    const noDelete = await errorOf(repo.delete("1", { expectedVersion: 1 }))
    expect(noDelete).toBeInstanceOf(ConfigurationError)
    expect(noDelete.message).toBe("Authorized repository requires deleteWhere support")
    const mutable = entity()
    const other = build(createRepo([[row("1")]]), createAuth(), { entity: mutable })
    delete (mutable as { versionField?: string }).versionField
    const noVersion = await errorOf(other.delete("1", { expectedVersion: 1 }))
    expect(noVersion).toBeInstanceOf(ConfigurationError)
    expect(noVersion.message).toBe('Authorized delete for "widget" requires versionField optimistic concurrency')
  })

  it("does not delete when the write is denied", async () => {
    const handle = createRepo([[row("1")]])
    const auth = createAuth()
    auth.assertWrite.mockImplementation(() => { throw new ForbiddenError("denied") })
    await expect(build(handle, auth).delete("1", { expectedVersion: 1 })).rejects.toThrow("denied")
    expect(handle.deleteWhere).not.toHaveBeenCalled()
  })
})
