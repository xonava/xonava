import { beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigurationError, ConflictError, ForbiddenError, NotFoundError, OptimisticConcurrencyError, Predicate, PreconditionRequiredError } from "@xonava/core/domain"
import { createDeleteHandler } from "../delete"
import {
  ALLOW_ALL_SCOPE,
  MODULE_KEY,
  asAnonymous,
  baseOptions,
  contextFor,
  fakeRepo,
  keylessEntity,
  lastCapture,
  mutationOperation,
  persistenceOf,
  plainEntity,
  sharedOf,
  unscopedEntity,
  widgetEntity,
  type Row,
} from "./crudUnitHarness"

const captured = vi.hoisted(() => ({ calls: [] as unknown[] }))

vi.mock("../../createFrameworkWriteHandler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../createFrameworkWriteHandler")>()
  return { ...actual, createFrameworkWriteHandler: (args: unknown) => { captured.calls.push(args); return vi.fn() } }
})

beforeEach(() => { captured.calls.length = 0 })

const row = (over: Partial<Row> = {}): Row => ({ id: "w1", tenantId: "tenant-1", version: 3, name: "n", ...over })
const base = Predicate.eq("id", "w1")
const tenant = Predicate.eq("tenantId", "tenant-1")

function build(options = baseOptions(), shared: Record<string, unknown> = {}) {
  createDeleteHandler(sharedOf(options, shared))
  return lastCapture(captured.calls)
}

async function ready(over: Record<string, unknown> = {}, repoOver: Record<string, unknown> = {}, kind: "tenant" | "platform" = "tenant") {
  const repo = fakeRepo({ findOneWhere: vi.fn(async () => row()), deleteWhere: vi.fn(async () => ({ deletedCount: 1 })), ...repoOver })
  const persistence = persistenceOf(repo)
  const options = baseOptions({ createPersistence: () => persistence, ...over })
  const capture = build(options)
  const context = await contextFor(kind, "delete")
  return { repo, persistence, options, capture, context, operation: mutationOperation(context, persistence) }
}

const input = (over: Record<string, unknown> = {}) => ({ id: "w1", existing: row(), expectedVersion: 3, ...over })
const run = (h: Awaited<ReturnType<typeof ready>>, over: Record<string, unknown> = {}) => h.capture.definition.execute({ operation: h.operation, input: input(over) } as never)

describe("delete handler wiring", () => {
  it("passes the configured pieces to the write handler", () => {
    const options = baseOptions({ getRateLimitStore: async () => ({}) as never, auditSinkFactory: () => ({ write: vi.fn() }), outboxSinkFactory: () => ({ append: vi.fn() }), audit: { enabled: true, resource: "Widget" } })
    const capture = build(options, { invalidateTags: () => ["t"] })
    expect(capture.adapterDeps).toBe(options.adapterDeps)
    expect(capture.requestNormalization).toBe(options.requestNormalization)
    expect(capture.scope).toBe(options.scope)
    expect(capture.moduleKey).toBe(MODULE_KEY)
    expect(capture.action).toBe("delete")
    expect(capture.skipCapabilityCheck).toBe(true)
    expect(capture.getCacheAdapter).toBe(options.getCacheAdapter)
    expect(capture.getRateLimitStore).toBe(options.getRateLimitStore)
    expect(capture.runtimeCapabilities).toEqual({ deferredExecution: true, cache: true })
    expect(capture.auditSinkFactory).toBe(options.auditSinkFactory)
    expect(capture.outboxSinkFactory).toBe(options.outboxSinkFactory)
    expect(capture.createPersistence).toBe(options.createPersistence)
    expect(capture.invalidateTags).toBeTypeOf("function")
    expect(capture.validation).toEqual({ params: options.validation?.idParams })
    expect(capture.definition.key).toBe(`${MODULE_KEY}.delete`)
    expect(capture.definition.kind).toBe("mutation")
    expect(capture.definition.atomicity).toEqual({ kind: "standard", mode: "required" })
  })

  it("leaves out what is not configured", () => {
    const capture = build()
    for (const key of ["getRateLimitStore", "auditSinkFactory", "outboxSinkFactory", "invalidateTags", "rateLimit"]) expect(key in capture).toBe(false)
    expect("before" in capture.definition).toBe(false)
    expect("afterCommit" in capture.definition).toBe(false)
    expect("audit" in capture.definition).toBe(false)
  })

  it("hands an audit sink factory over only when audit is emitted for delete", () => {
    const sink = () => ({ write: vi.fn() })
    expect("auditSinkFactory" in build(baseOptions({ auditSinkFactory: sink, audit: { enabled: true, resource: "Widget", emitOn: ["update"] } }))).toBe(false)
    expect("auditSinkFactory" in build(baseOptions({ auditSinkFactory: sink, audit: { enabled: false, resource: "Widget" } }))).toBe(false)
    expect(build(baseOptions({ auditSinkFactory: sink, audit: { enabled: true, resource: "Widget", emitOn: ["delete"] } })).auditSinkFactory).toBe(sink)
    const noFactory = build(baseOptions({ audit: { enabled: true, resource: "Widget" } }))
    expect("auditSinkFactory" in noFactory).toBe(false)
    expect(noFactory.definition.audit).toBeDefined()
  })

  it("maps the delete rate limit, passing the failure mode only when set", () => {
    const withMode = build(baseOptions({ rateLimit: { delete: { max: 3, timeWindow: "1 minute", consistency: "atomic", failureMode: "fail-open" } } }))
    expect(withMode.rateLimit).toEqual({ config: { max: 3, timeWindow: "1 minute", consistency: "atomic", failureMode: "fail-open" }, consistency: "atomic", failureMode: "fail-open" })
    const withoutMode = build(baseOptions({ rateLimit: { delete: { max: 3, timeWindow: "1 minute", consistency: "best-effort" } } }))
    expect(withoutMode.rateLimit).toEqual({ config: { max: 3, timeWindow: "1 minute", consistency: "best-effort" }, consistency: "best-effort" })
    expect("failureMode" in (withoutMode.rateLimit ?? {})).toBe(false)
  })

  it("answers a fixed acknowledgement and an always-available recovery", async () => {
    const capture = build()
    const response = capture.toResponse({ success: true } as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ message: "Deleted" })
    expect(await capture.recoverCommittedResponse({} as never)).toEqual({ success: true })
    expect(capture.resolveResourceIdentity({ input: { id: "w9" } } as never)).toEqual({ entity: MODULE_KEY, id: "w9" })
  })
})

describe("delete audit definition", () => {
  it("describes the deleted resource with the configured audit options", () => {
    const fieldClassification = { name: "pii" } as never
    const capture = build(baseOptions({ audit: { enabled: true, resource: "Widget", fieldClassification, required: false, auditGuarantee: "atomic", requiredStateSemantics: "committed-state" } }))
    const audit = capture.definition.audit
    expect(audit?.action).toBe("Widget.deleted")
    expect(audit?.resourceType).toBe("Widget")
    expect(audit?.fieldClassification).toBe(fieldClassification)
    expect(audit?.required).toBe(false)
    expect(audit?.auditGuarantee).toBe("atomic")
    expect(audit?.requiredStateSemantics).toBe("committed-state")
    expect(audit?.resolveResourceId({ input: { id: "w7" } } as never)).toBe("w7")
    expect("extractOldValue" in (audit ?? {})).toBe(false)
  })

  it("falls back to the entity name and omits unset options", () => {
    const audit = build(baseOptions({ audit: { enabled: true } })).definition.audit
    expect(audit?.action).toBe("widget.deleted")
    expect(audit?.resourceType).toBe("widget")
    for (const key of ["fieldClassification", "required", "auditGuarantee", "requiredStateSemantics", "extractOldValue"]) expect(key in (audit ?? {})).toBe(false)
  })

  it("includes the old value only on request, projecting the existing record", () => {
    const capture = build(baseOptions({ audit: { enabled: true, resource: "Widget", includeValues: true } }))
    expect(capture.definition.audit?.extractOldValue?.({ input: { existing: { id: "w1", name: "n", ghost: "x" } } } as never)).toEqual({ id: "w1", name: "n" })
    expect("extractOldValue" in (build(baseOptions({ audit: { enabled: true, resource: "Widget", includeValues: false } })).definition.audit ?? {})).toBe(false)
  })
})

describe("delete hooks and authorization", () => {
  it("runs beforeDelete with the existing row and a read-only context", async () => {
    const beforeDelete = vi.fn(async () => undefined)
    const h = await ready({ crud: { delete: { beforeDelete } } })
    await h.capture.definition.before?.({ operation: h.operation, input: input() } as never)
    expect(beforeDelete).toHaveBeenCalledWith({ existing: row(), context: expect.objectContaining({ tenantId: "tenant-1", requestId: "req-1" }) })
  })

  it("runs afterCommit with the existing row and the post-commit context", async () => {
    const afterCommit = vi.fn(async () => undefined)
    const h = await ready({ crud: { delete: { afterCommit } } })
    const operation = { ...h.operation, metadata: { requestId: "meta-req" }, correlationId: "corr-9" }
    await h.capture.definition.afterCommit?.({ operation, input: input() } as never)
    expect(afterCommit).toHaveBeenCalledWith({ existing: row(), operation, context: { tenantId: "tenant-1", requestId: "meta-req", correlationId: "corr-9" } })
  })

  it("enforces the delete rule on the existing row during authorization, when an enforcer exists", async () => {
    const h = await ready()
    const enforce = vi.fn()
    expect(await h.capture.definition.authorization.authorize({ operation: { ...h.operation, enforceAbac: { enforce } }, input: input() } as never)).toEqual({ allowed: true })
    expect(enforce).toHaveBeenCalledWith("delete", row())
    expect(await h.capture.definition.authorization.authorize({ operation: h.operation, input: input() } as never)).toEqual({ allowed: true })
  })
})

describe("delete execute: lookup", () => {
  it("looks the row up by key under the structural and action scope", async () => {
    const h = await ready()
    await run(h)
    expect(h.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(base, tenant, ALLOW_ALL_SCOPE)])
  })

  it("composes the filter from whichever scopes apply", async () => {
    const platform = await ready({ entity: unscopedEntity(), entityScope: undefined, scope: { scope: "platform" } }, {}, "platform")
    await run(platform, { expectedVersion: undefined })
    expect(platform.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(base, ALLOW_ALL_SCOPE)])

    const anonymousTenant = await ready()
    await anonymousTenant.capture.definition.execute({ operation: mutationOperation(asAnonymous(anonymousTenant.context), anonymousTenant.persistence), input: input() } as never)
    expect(anonymousTenant.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(base, tenant)])

    const bare = await ready({ entity: unscopedEntity(), entityScope: undefined, scope: { scope: "platform" } }, {}, "platform")
    await bare.capture.definition.execute({ operation: mutationOperation(asAnonymous(bare.context), bare.persistence), input: input({ expectedVersion: undefined }) } as never)
    expect(bare.repo.findOneWhere?.mock.calls[0]).toEqual([base])
  })

  it("keys the lookup by id when the entity declares no primary key", async () => {
    const h = await ready({ entity: keylessEntity() })
    await run(h)
    expect(h.repo.findOneWhere?.mock.calls[0]?.[0]).toEqual(Predicate.and(base, tenant, ALLOW_ALL_SCOPE))
    const keyed = await ready({ entity: widgetEntity({ primaryKey: "name" }) })
    await run(keyed)
    expect(keyed.repo.findOneWhere?.mock.calls[0]?.[0]).toEqual(Predicate.and(Predicate.eq("name", "w1"), tenant, ALLOW_ALL_SCOPE))
  })

  it("falls back to a single-row page read when the repository has no keyed lookup", async () => {
    const findMany = vi.fn(async () => ({ rows: [row()], rowCount: 1, page: 1, pageSize: 1 }))
    const h = await ready({}, { findOneWhere: undefined, findMany })
    expect(await run(h)).toEqual({ success: true })
    expect(findMany).toHaveBeenCalledWith({ filter: Predicate.and(base, tenant, ALLOW_ALL_SCOPE), pagination: { kind: "offset", page: 1, pageSize: 1 } })
    const none = await ready({}, { findOneWhere: undefined, findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 1 })) })
    await expect(run(none)).rejects.toEqual(new NotFoundError("widget not found"))
  })

  it("answers not found when the row does not exist, without deleting", async () => {
    const h = await ready({}, { findOneWhere: vi.fn(async () => null) })
    await expect(run(h)).rejects.toEqual(new NotFoundError("widget not found"))
    expect(h.repo.deleteWhere).not.toHaveBeenCalled()
  })

  it("refuses to delete from an append-only entity", async () => {
    const h = await ready({ entity: widgetEntity({ deleteStrategy: "forbidden" }) })
    await expect(run(h)).rejects.toEqual(new ConfigurationError("Delete is forbidden for append-only entity widget"))
    expect(h.repo.deleteWhere).not.toHaveBeenCalled()
  })

  it("enforces the delete rule on the row that was found, when an enforcer exists", async () => {
    const enforce = vi.fn()
    const h = await ready()
    await h.capture.definition.execute({ operation: { ...h.operation, enforceAbac: { enforce } }, input: input() } as never)
    expect(enforce).toHaveBeenCalledWith("delete", row())
    const without = await ready()
    await expect(run(without)).resolves.toEqual({ success: true })
  })
})

describe("delete execute: version precondition", () => {
  it("requires the expected version for a versioned entity", async () => {
    const h = await ready()
    await expect(run(h, { expectedVersion: undefined })).rejects.toEqual(new PreconditionRequiredError("If-Match"))
    expect(h.repo.deleteWhere).not.toHaveBeenCalled()
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 2, "3"])("rejects the malformed expected version %s", async (expectedVersion) => {
    const h = await ready()
    await expect(run(h, { expectedVersion })).rejects.toThrow()
    expect(h.repo.deleteWhere).not.toHaveBeenCalled()
  })

  it("fences the hard delete on the expected version and returns the acknowledgement", async () => {
    const h = await ready()
    expect(await run(h)).toEqual({ success: true })
    expect(h.repo.deleteWhere?.mock.calls[0]).toEqual([
      Predicate.and(Predicate.and(base, tenant, ALLOW_ALL_SCOPE), Predicate.eq("version", 3)),
      { optimisticConcurrency: { expectedVersion: 3 } },
    ])
  })

  it("uses the configured concurrency field over the entity's version field", async () => {
    const h = await ready({ optimisticConcurrency: { versionField: "name" } })
    await run(h, { expectedVersion: 3 })
    expect(h.repo.deleteWhere?.mock.calls[0]?.[0]).toEqual(Predicate.and(Predicate.and(base, tenant, ALLOW_ALL_SCOPE), Predicate.eq("name", 3)))
  })

  it("deletes an unversioned entity without a precondition", async () => {
    const h = await ready({ entity: plainEntity() })
    expect(await run(h, { expectedVersion: undefined })).toEqual({ success: true })
    expect(h.repo.deleteWhere?.mock.calls[0]).toEqual([Predicate.and(base, tenant, ALLOW_ALL_SCOPE), undefined])
  })
})

describe("delete execute: hard delete outcomes", () => {
  it("reports a stale version as a conflict when nothing was deleted", async () => {
    const h = await ready({}, { deleteWhere: vi.fn(async () => ({ deletedCount: 0 })) })
    await expect(run(h)).rejects.toEqual(new ConflictError("This record was modified by another user. Please reload and try again."))
  })

  it("reports a missing row as not found when an unversioned delete removed nothing", async () => {
    const h = await ready({ entity: plainEntity() }, { deleteWhere: vi.fn(async () => ({ deletedCount: 0 })) })
    await expect(run(h, { expectedVersion: undefined })).rejects.toEqual(new NotFoundError("widget not found"))
  })

  it("treats a not-found failure from a versioned delete as a version mismatch", async () => {
    const h = await ready({}, { deleteWhere: vi.fn(async () => { throw new NotFoundError("gone") }) })
    await expect(run(h)).rejects.toEqual(new OptimisticConcurrencyError("widget version mismatch"))
    const other = new ForbiddenError("nope")
    const failing = await ready({}, { deleteWhere: vi.fn(async () => { throw other }) })
    await expect(run(failing)).rejects.toBe(other)
  })

  it("rethrows a not-found failure from an unversioned delete unchanged", async () => {
    const missing = new NotFoundError("gone")
    const h = await ready({ entity: plainEntity() }, { deleteWhere: vi.fn(async () => { throw missing }) })
    await expect(run(h, { expectedVersion: undefined })).rejects.toBe(missing)
  })

  it("requires the repository to support filtered deletes", async () => {
    const h = await ready({}, { deleteWhere: undefined })
    await expect(run(h)).rejects.toEqual(new ConfigurationError("Secure delete for widget requires deleteWhere support"))
  })
})

describe("delete execute: soft delete", () => {
  const soft = { entity: widgetEntity({ deleteStrategy: "occ-soft", deletedAtField: "deletedAt" }) }

  it("stamps the deletion time on the fenced row instead of deleting it", async () => {
    const updateOneWhereReturning = vi.fn(async () => row())
    const h = await ready(soft, { updateOneWhereReturning })
    const before = Date.now()
    expect(await run(h)).toEqual({ success: true })
    const call = updateOneWhereReturning.mock.calls[0] as unknown as [unknown, { deletedAt: string }, unknown]
    expect(call[0]).toEqual(Predicate.and(Predicate.and(base, tenant, ALLOW_ALL_SCOPE), Predicate.eq("version", 3)))
    expect(Object.keys(call[1])).toEqual(["deletedAt"])
    expect(new Date(call[1].deletedAt).toISOString()).toBe(call[1].deletedAt)
    expect(Date.parse(call[1].deletedAt)).toBeGreaterThanOrEqual(before - 1000)
    expect(call[2]).toEqual({ optimisticConcurrency: { expectedVersion: 3 } })
    expect(h.repo.deleteWhere).not.toHaveBeenCalled()
  })

  it("reports a lost race as a conflict, and a missing update target as one for unversioned entities", async () => {
    const h = await ready(soft, { updateOneWhereReturning: vi.fn(async () => null) })
    await expect(run(h)).rejects.toEqual(new ConflictError("This record was modified by another user. Please reload and try again."))
    const plain = await ready({ entity: plainEntity({ deleteStrategy: "occ-soft", deletedAtField: "deletedAt" }) }, { updateOneWhereReturning: vi.fn(async () => null) })
    await expect(run(plain, { expectedVersion: undefined })).rejects.toEqual(new NotFoundError("widget not found"))
  })

  it("requires a deletedAt field and an update-returning repository", async () => {
    const message = "Soft delete for widget requires a deletedAt field and updateOneWhereReturning support"
    const noField = await ready({ entity: widgetEntity({ deleteStrategy: "occ-soft" }) }, { updateOneWhereReturning: vi.fn(async () => row()) })
    await expect(run(noField)).rejects.toEqual(new ConfigurationError(message))
    const noMethod = await ready(soft, { updateOneWhereReturning: undefined })
    await expect(run(noMethod)).rejects.toEqual(new ConfigurationError(message))
    const neither = await ready({ entity: widgetEntity({ deleteStrategy: "occ-soft" }) }, { updateOneWhereReturning: undefined })
    await expect(run(neither)).rejects.toEqual(new ConfigurationError(message))
  })
})

describe("delete atomic batch", () => {
  const prepare = (h: Awaited<ReturnType<typeof ready>>, over: Record<string, unknown> = {}, context = h.context) =>
    h.capture.definition.atomicBatch.prepare({ operation: mutationOperation(context, h.persistence), input: input(over) } as never)

  it("prepares a fenced delete command and the predicted result", async () => {
    const h = await ready()
    const prepared = await prepare(h)
    expect(prepared.commands).toEqual([{
      kind: "delete",
      entity: "widget",
      filter: Predicate.and(Predicate.and(base, tenant, ALLOW_ALL_SCOPE), Predicate.eq("version", 3)),
      expectedAffectedRows: 1,
      expectedVersion: 3,
    }])
    expect(prepared.result).toEqual({ success: true })
  })

  it("composes the filter from whichever scopes apply", async () => {
    const platform = await ready({ entity: unscopedEntity(), entityScope: undefined, scope: { scope: "platform" } }, {}, "platform")
    expect((await prepare(platform, { expectedVersion: undefined })).commands[0]).toEqual({ kind: "delete", entity: "widget", filter: Predicate.and(base, ALLOW_ALL_SCOPE), expectedAffectedRows: 1 })
    const tenantOnly = await ready()
    expect((await prepare(tenantOnly, {}, asAnonymous(tenantOnly.context))).commands[0]).toMatchObject({ filter: Predicate.and(Predicate.and(base, tenant), Predicate.eq("version", 3)) })
    const bare = await ready({ entity: unscopedEntity(), entityScope: undefined, scope: { scope: "platform" } }, {}, "platform")
    expect((await prepare(bare, { expectedVersion: undefined }, asAnonymous(bare.context))).commands[0]).toEqual({ kind: "delete", entity: "widget", filter: base, expectedAffectedRows: 1 })
  })

  it("keys the command by id without a declared primary key, and carries the namespace", async () => {
    const h = await ready({ entity: keylessEntity({ namespace: "crm" }) })
    const command = (await prepare(h)).commands[0] as { filter: unknown; namespace: string }
    expect(command.namespace).toBe("crm")
    expect(command.filter).toEqual(Predicate.and(Predicate.and(base, tenant, ALLOW_ALL_SCOPE), Predicate.eq("version", 3)))
  })

  it("prepares a soft-delete update for occ-soft entities", async () => {
    const h = await ready({ entity: widgetEntity({ deleteStrategy: "occ-soft", deletedAtField: "deletedAt", namespace: "crm" }) })
    const command = (await prepare(h)).commands[0] as { kind: string; entity: string; namespace: string; values: { deletedAt: string }; expectedAffectedRows: number; expectedVersion: number }
    expect(command.kind).toBe("update")
    expect(command.entity).toBe("widget")
    expect(command.namespace).toBe("crm")
    expect(Object.keys(command.values)).toEqual(["deletedAt"])
    expect(new Date(command.values.deletedAt).toISOString()).toBe(command.values.deletedAt)
    expect(command.expectedAffectedRows).toBe(1)
    expect(command.expectedVersion).toBe(3)
    const plain = await ready({ entity: plainEntity({ deleteStrategy: "occ-soft", deletedAtField: "deletedAt" }) })
    const unversioned = (await prepare(plain, { expectedVersion: undefined })).commands[0] as Record<string, unknown>
    expect(unversioned.kind).toBe("update")
    expect("expectedVersion" in unversioned).toBe(false)
    expect("namespace" in unversioned).toBe(false)
  })

  it("requires and validates the expected version for a versioned entity", async () => {
    const h = await ready()
    await expect(prepare(h, { expectedVersion: undefined })).rejects.toEqual(new PreconditionRequiredError("If-Match"))
    await expect(prepare(h, { expectedVersion: -4 })).rejects.toThrow()
    const configured = await ready({ entity: plainEntity(), optimisticConcurrency: { versionField: "version" } })
    await expect(prepare(configured, { expectedVersion: undefined })).rejects.toEqual(new PreconditionRequiredError("If-Match"))
    expect((await prepare(configured)).commands[0]).toMatchObject({ expectedVersion: 3 })
  })

  describe("verification", () => {
    const verifyOf = async (over: Record<string, unknown> = {}, entity = widgetEntity()) => {
      const h = await ready({ entity })
      return (await prepare(h, over)).verify
    }

    it("accepts exactly one affected row from any driver's metadata shape", async () => {
      const verify = await verifyOf()
      expect(() => verify({ commandResults: [{ meta: { changes: 1 } }] } as never)).not.toThrow()
      expect(() => verify({ commandResults: [{ changes: 1 }] } as never)).not.toThrow()
      expect(() => verify({ commandResults: [{ affectedRows: 1 }] } as never)).not.toThrow()
      expect(() => verify({ commandResults: [{ meta: { changes: 1 }, changes: 5, affectedRows: 5 }] } as never)).not.toThrow()
      expect(() => verify({ commandResults: [{ meta: {}, changes: 1 }] } as never)).not.toThrow()
    })

    it("fails when no driver metadata is present", async () => {
      const verify = await verifyOf()
      for (const commandResults of [[], [{}], [{ meta: {} }], [undefined]]) {
        expect(() => verify({ commandResults } as never)).toThrow(new ConfigurationError("Atomic delete did not return affected-row metadata"))
      }
    })

    it("reports a version conflict, or not found, when the row count is not one", async () => {
      const versioned = await verifyOf()
      for (const changes of [0, 2]) {
        expect(() => versioned({ commandResults: [{ changes }] } as never)).toThrow(new ConflictError("This record was modified by another user. Please reload and try again."))
      }
      const unversioned = await verifyOf({ expectedVersion: undefined }, plainEntity())
      expect(() => unversioned({ commandResults: [{ changes: 0 }] } as never)).toThrow(new NotFoundError("widget not found"))
      const configured = await ready({ entity: plainEntity(), optimisticConcurrency: { versionField: "version" } })
      const verify = (await prepare(configured)).verify
      expect(() => verify({ commandResults: [{ changes: 0 }] } as never)).toThrow(ConflictError)
    })
  })
})

describe("delete existing record and input", () => {
  it("loads the existing row for the id under the structural and action scope, or answers not found", async () => {
    const h = await ready()
    const existing = await h.capture.resolveExistingRecord?.({ validated: { validatedParams: { id: "w1" } }, context: h.context } as never)
    expect(existing).toEqual(row())
    // The tenant-scoped persistence adds the tenant condition once more around the structural and action scope.
    expect(h.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(Predicate.and(base, Predicate.and(tenant, ALLOW_ALL_SCOPE)), tenant)])

    const missing = await ready({}, { findOneWhere: vi.fn(async () => null) })
    await expect(missing.capture.resolveExistingRecord?.({ validated: { validatedParams: { id: "w1" } }, context: missing.context } as never)).rejects.toEqual(new NotFoundError("widget not found"))
  })

  const header = (value: string | null) => new Request("https://example.test/widgets/w1", { method: "DELETE", ...(value === null ? {} : { headers: { "if-match": value } }) })
  const resolve = async (h: Awaited<ReturnType<typeof ready>>, value: string | null) =>
    h.capture.resolveInput({ request: header(value), validated: { validatedParams: { id: "w1" } }, existing: row() } as never) as Promise<Record<string, unknown>>

  it("takes the expected version only from the If-Match header", async () => {
    const h = await ready()
    expect(await resolve(h, '"3"')).toEqual({ id: "w1", existing: row(), expectedVersion: 3 })
    expect(await resolve(h, "3")).toMatchObject({ expectedVersion: 3 })
    expect(await resolve(h, "0")).toMatchObject({ expectedVersion: 0 })
  })

  it("passes no expected version when the header is absent or blank", async () => {
    const h = await ready()
    for (const value of [null, "", "   "]) {
      const resolved = await resolve(h, value)
      expect(resolved).toEqual({ id: "w1", existing: row() })
      expect("expectedVersion" in resolved).toBe(false)
    }
  })

  it.each(["abc", 'W/"3"', '"abc"', "-1", "1.5", '"3', "3 4"])("rejects the unusable If-Match header %s", async (value) => {
    const h = await ready()
    await expect(resolve(h, value)).rejects.toEqual(new ConflictError("Version is required for this delete"))
  })

  it("ignores If-Match for an unversioned entity", async () => {
    const h = await ready({ entity: plainEntity() })
    expect(await resolve(h, "garbage")).toEqual({ id: "w1", existing: row() })
    const configured = await ready({ entity: plainEntity(), optimisticConcurrency: { versionField: "version" } })
    await expect(resolve(configured, "garbage")).rejects.toBeInstanceOf(ConflictError)
  })
})
