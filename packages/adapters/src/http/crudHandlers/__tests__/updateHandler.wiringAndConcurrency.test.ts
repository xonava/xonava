import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  ConfigurationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  Predicate,
  PreconditionRequiredError,
  bindAbacSecurityDigest,
  type PredicateNode,
} from "@xonava/core/domain"
import { createUpdateHandler, parseIfMatchVersion } from "../update"
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

const captured = vi.hoisted(() => ({ calls: [] as unknown[], preImages: [] as unknown[] }))

vi.mock("../../createFrameworkWriteHandler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../createFrameworkWriteHandler")>()
  return { ...actual, createFrameworkWriteHandler: (args: unknown) => { captured.calls.push(args); return vi.fn() } }
})

vi.mock("@xonava/core/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xonava/core/domain")>()
  return {
    ...actual,
    markAbacPreImage: <T extends Record<string, unknown>>(record: T): T => {
      captured.preImages.push(record)
      return actual.markAbacPreImage(record)
    },
  }
})

beforeEach(() => { captured.calls.length = 0; captured.preImages.length = 0 })

const row = (over: Partial<Row> = {}): Row => ({ id: "w1", tenantId: "tenant-1", version: 3, name: "n", ...over })
const rowsOf = (...rows: Row[]) => ({ rows, rowCount: rows.length, page: 1, pageSize: 1 })
const base = Predicate.eq("id", "w1")
const tenant = Predicate.eq("tenantId", "tenant-1")
const platform = { entity: unscopedEntity(), entityScope: undefined, scope: { scope: "platform" } }

function build(options = baseOptions(), shared: Record<string, unknown> = {}) {
  createUpdateHandler(sharedOf(options, shared))
  return lastCapture(captured.calls)
}

async function ready(over: Record<string, unknown> = {}, repoOver: Record<string, unknown> = {}, kind: "tenant" | "platform" = "tenant") {
  const repo = fakeRepo({
    findOneWhere: vi.fn(async () => row()),
    findMany: vi.fn(async () => rowsOf(row({ version: 4, name: "after" }))),
    updateOneWhereReturning: vi.fn(async () => row({ version: 4, name: "after" })),
    ...repoOver,
  })
  const persistence = persistenceOf(repo)
  const options = baseOptions({ createPersistence: () => persistence, ...over })
  const capture = build(options)
  const context = await contextFor(kind, "update")
  return { repo, persistence, options, capture, context, operation: mutationOperation(context, persistence) }
}
type Ready = Awaited<ReturnType<typeof ready>>

const input = (over: Record<string, unknown> = {}) => ({ id: "w1", patch: { name: "after" }, originalPatch: { name: "after" }, existing: row(), expectedVersion: 3, ...over })
const run = (h: Ready, over: Record<string, unknown> = {}, operationExtra: Record<string, unknown> = {}) =>
  h.capture.definition.execute({ operation: { ...h.operation, ...operationExtra }, input: input(over) } as never)

describe("If-Match parsing", () => {
  it.each([
    ['"1"', 1], ["1", 1], [" 7 ", 7], ['  "8"  ', 8], ['" 2 "', 2], ["0", 0], ['"0"', 0], ["95", 95],
    ["9007199254740991", 9007199254740991], ["1000000000000000", 1000000000000000], ["999999999999999", 999999999999999],
  ])("accepts the strong validator %s", (raw, expected) => {
    expect(parseIfMatchVersion(raw)).toBe(expected)
  })

  it.each([
    [undefined], [null], [""], ["   "], ['W/"1"'], ['w/"1"'], ["W/1"], ['""'], ['"'], ['"1'], ['1"'], ['"12'], ['12"'], ['"51'], ['51"'],
    ["01"], ["-1"], ["1.5"], ["1e3"], ["0x10"], ["1abc"], ["abc"], ["1 2"], ['" "'],
    ["9007199254740992"], ["9999999999999999"], ["12345678901234567"], ["10000000000000000"],
  ])("rejects %s", (raw) => {
    expect(parseIfMatchVersion(raw)).toBeUndefined()
  })

  it("treats a non-string header value by its string form", () => {
    expect(parseIfMatchVersion(5 as never)).toBe(5)
  })
})

describe("update handler wiring", () => {
  it("passes the configured pieces to the write handler", () => {
    const options = baseOptions({ getRateLimitStore: async () => ({}) as never, auditSinkFactory: () => ({ write: vi.fn() }), outboxSinkFactory: () => ({ append: vi.fn() }), audit: { enabled: true, resource: "Widget" } })
    const capture = build(options, { invalidateTags: () => ["t"] })
    expect(capture.adapterDeps).toBe(options.adapterDeps)
    expect(capture.requestNormalization).toBe(options.requestNormalization)
    expect(capture.scope).toBe(options.scope)
    expect(capture.moduleKey).toBe(MODULE_KEY)
    expect(capture.action).toBe("update")
    expect(capture.skipCapabilityCheck).toBe(true)
    expect(capture.getCacheAdapter).toBe(options.getCacheAdapter)
    expect(capture.getRateLimitStore).toBe(options.getRateLimitStore)
    expect(capture.runtimeCapabilities).toEqual({ deferredExecution: true, cache: true })
    expect(capture.auditSinkFactory).toBe(options.auditSinkFactory)
    expect(capture.outboxSinkFactory).toBe(options.outboxSinkFactory)
    expect(capture.createPersistence).toBe(options.createPersistence)
    expect(capture.invalidateTags).toBeTypeOf("function")
    expect(capture.validation).toEqual({ params: options.validation?.idParams, body: options.validation?.updateBody })
    expect(capture.definition.key).toBe(`${MODULE_KEY}.update`)
    expect(capture.definition.kind).toBe("mutation")
    expect(capture.definition.atomicity).toEqual({ kind: "standard", mode: "required" })
  })

  it("validates only the params when no update body schema is configured", () => {
    const options = baseOptions({ validation: { idParams: { parse: (v: unknown) => v } } })
    const capture = build(options)
    expect(capture.validation).toEqual({ params: options.validation?.idParams })
    expect("body" in (capture.validation ?? {})).toBe(false)
  })

  it("leaves out what is not configured", () => {
    const capture = build()
    for (const key of ["getRateLimitStore", "auditSinkFactory", "outboxSinkFactory", "invalidateTags", "rateLimit"]) expect(key in capture).toBe(false)
    expect("before" in capture.definition).toBe(false)
    expect("afterCommit" in capture.definition).toBe(false)
    expect("audit" in capture.definition).toBe(false)
  })

  it("hands an audit sink factory over only when audit is emitted for update", () => {
    const sink = () => ({ write: vi.fn() })
    expect("auditSinkFactory" in build(baseOptions({ auditSinkFactory: sink, audit: { enabled: true, resource: "Widget", emitOn: ["create"] } }))).toBe(false)
    expect("auditSinkFactory" in build(baseOptions({ auditSinkFactory: sink, audit: { enabled: false, resource: "Widget" } }))).toBe(false)
    expect(build(baseOptions({ auditSinkFactory: sink, audit: { enabled: true, resource: "Widget", emitOn: ["update"] } })).auditSinkFactory).toBe(sink)
    const noFactory = build(baseOptions({ audit: { enabled: true, resource: "Widget" } }))
    expect("auditSinkFactory" in noFactory).toBe(false)
    expect(noFactory.definition.audit).toBeDefined()
  })

  it("maps the update rate limit, passing the failure mode only when set", () => {
    const withMode = build(baseOptions({ rateLimit: { update: { max: 3, timeWindow: "1 minute", consistency: "atomic", failureMode: "fail-open" } } }))
    expect(withMode.rateLimit).toEqual({ config: { max: 3, timeWindow: "1 minute", consistency: "atomic", failureMode: "fail-open" }, consistency: "atomic", failureMode: "fail-open" })
    const withoutMode = build(baseOptions({ rateLimit: { update: { max: 3, timeWindow: "1 minute", consistency: "best-effort" } } }))
    expect(withoutMode.rateLimit).toEqual({ config: { max: 3, timeWindow: "1 minute", consistency: "best-effort" }, consistency: "best-effort" })
    expect("failureMode" in (withoutMode.rateLimit ?? {})).toBe(false)
  })

  it("answers 200 with the record or the acknowledgement", async () => {
    const capture = build()
    const updated = capture.toResponse({ record: { id: "w1" } } as never)
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({ id: "w1" })
    const acknowledged = capture.toResponse({ success: true, reason: "UPDATED_OUTSIDE_READ_SCOPE" } as never)
    expect(acknowledged.status).toBe(200)
    expect(await acknowledged.json()).toEqual({ success: true, reason: "UPDATED_OUTSIDE_READ_SCOPE" })
  })
})

describe("update resource identity", () => {
  it("predicts the committed version from the existing row", () => {
    const capture = build()
    expect(capture.resolveResourceIdentity({ input: { id: "w1", existing: { version: 3 } } } as never)).toEqual({ entity: MODULE_KEY, id: "w1", version: 4 })
    const zero = capture.resolveResourceIdentity({ input: { id: "w1", existing: { version: 0 } } } as never)
    expect(zero).toEqual({ entity: MODULE_KEY, id: "w1", version: 1 })
  })

  it("names no version when the existing version is not a number or the entity is unversioned", () => {
    const capture = build()
    const odd = capture.resolveResourceIdentity({ input: { id: "w1", existing: { version: "3" } } } as never)
    expect(odd).toEqual({ entity: MODULE_KEY, id: "w1" })
    expect("version" in odd).toBe(false)
    const plain = build(baseOptions({ entity: plainEntity() })).resolveResourceIdentity({ input: { id: "w1", existing: { version: 3 } } } as never)
    expect("version" in plain).toBe(false)
  })

  it("uses the configured concurrency field over the entity version field", () => {
    const capture = build(baseOptions({ optimisticConcurrency: { versionField: "name" } }))
    expect(capture.resolveResourceIdentity({ input: { id: "w1", existing: { version: 3, name: 9 } } } as never)).toEqual({ entity: MODULE_KEY, id: "w1", version: 10 })
    const configuredOnly = build(baseOptions({ entity: plainEntity(), optimisticConcurrency: { versionField: "version" } }))
    expect(configuredOnly.resolveResourceIdentity({ input: { id: "w1", existing: { version: 3 } } } as never)).toEqual({ entity: MODULE_KEY, id: "w1", version: 4 })
  })
})

describe("update input resolution", () => {
  const request = (headers: Record<string, string> = {}) => new Request("https://example.test/widgets/w1", { method: "PATCH", headers })
  const resolve = (h: Ready, headers: Record<string, string>, body: Record<string, unknown> = { name: "after" }) =>
    h.capture.resolveInput({ request: request(headers), validated: { validatedParams: { id: "w1" }, validatedBody: body }, existing: row() } as never) as Promise<Record<string, unknown>>

  it("builds the input from the validated body, the existing row and the If-Match version", async () => {
    const h = await ready()
    const resolved = await resolve(h, { "if-match": '"3"' })
    expect(resolved).toEqual({ id: "w1", patch: { name: "after" }, originalPatch: { name: "after" }, existing: row(), expectedVersion: 3 })
    expect(resolved.patch).toBe(resolved.originalPatch)
  })

  it("accepts version zero", async () => {
    const h = await ready()
    expect(await resolve(h, { "if-match": "0" })).toMatchObject({ expectedVersion: 0 })
  })

  it("asks for a precondition when the header is absent or blank", async () => {
    const h = await ready()
    await expect(resolve(h, {})).rejects.toEqual(new PreconditionRequiredError("If-Match"))
    await expect(resolve(h, { "if-match": "   " })).rejects.toEqual(new PreconditionRequiredError("If-Match"))
  })

  it.each(["abc", 'W/"3"', "-1", "1.5", '"3', "3 4", "9007199254740992"])("rejects the unusable If-Match header %s", async (value) => {
    const h = await ready()
    await expect(resolve(h, { "if-match": value })).rejects.toEqual(new ConflictError("Version is required for this update"))
  })

  it("does not read If-Match for an unversioned entity, and keeps the body as the patch", async () => {
    const h = await ready({ entity: plainEntity() })
    const resolved = await resolve(h, { "if-match": "garbage" })
    expect(resolved).toEqual({ id: "w1", patch: { name: "after" }, originalPatch: { name: "after" }, existing: row() })
    expect("expectedVersion" in resolved).toBe(false)
  })

  it("never takes the expected version from the body", async () => {
    const plain = await ready({ entity: plainEntity() })
    const unversioned = await resolve(plain, { "if-match": "5" }, { name: "x", version: 9 })
    expect("expectedVersion" in unversioned).toBe(false)
    const versioned = await ready()
    await expect(resolve(versioned, { "if-match": "3" }, { name: "x", version: 9 })).rejects.toEqual(new ForbiddenError("Cannot modify protected fields on widget: version"))
  })

  it("refuses patches that touch protected or reserved fields", async () => {
    const h = await ready({ update: { protectedFields: ["name"] } })
    await expect(resolve(h, { "if-match": "3" })).rejects.toEqual(new ForbiddenError("Cannot modify protected fields on widget: name"))
    await expect(resolve(h, { "if-match": "3" }, { id: "x" })).rejects.toEqual(new ForbiddenError("Cannot modify protected fields on widget: id"))
  })

  it("copies the validated body rather than aliasing it", async () => {
    const h = await ready()
    const body = { name: "after" }
    const resolved = await resolve(h, { "if-match": "3" }, body)
    expect(resolved.patch).toEqual(body)
    expect(resolved.patch).not.toBe(body)
  })

  it("loads the existing row for the id, or answers not found", async () => {
    const h = await ready()
    expect(await h.capture.resolveExistingRecord?.({ validated: { validatedParams: { id: "w1" } }, context: h.context } as never)).toEqual(row())
    expect(h.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(Predicate.and(base, Predicate.and(tenant, ALLOW_ALL_SCOPE)), tenant)])
    const missing = await ready({}, { findOneWhere: vi.fn(async () => null) })
    await expect(missing.capture.resolveExistingRecord?.({ validated: { validatedParams: { id: "w1" } }, context: missing.context } as never)).rejects.toEqual(new NotFoundError("widget not found"))
  })
})

describe("update before (transformInput)", () => {
  it("checks the incoming patch, runs the hook, and re-checks its output", async () => {
    const transformInput = vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => ({ ...patch, extra: 1 }))
    const h = await ready({ crud: { update: { transformInput } }, update: { protectedFields: ["deletedAt"] } })
    const next = await h.capture.definition.before?.({ operation: h.operation, input: input() } as never) as { patch: unknown; originalPatch: unknown }
    expect(next.patch).toEqual({ name: "after", extra: 1 })
    expect(next.originalPatch).toEqual({ name: "after" })
    expect(transformInput).toHaveBeenCalledWith({ existing: row(), patch: { name: "after" }, context: expect.objectContaining({ tenantId: "tenant-1" }) })
    await expect(h.capture.definition.before?.({ operation: h.operation, input: input({ patch: { id: "x" } }) } as never)).rejects.toEqual(new ForbiddenError("Cannot modify protected fields on widget: id"))

    const reserved = await ready({ crud: { update: { transformInput: async () => ({ deletedAt: "x" }) } }, update: { protectedFields: ["deletedAt"] } })
    await expect(reserved.capture.definition.before?.({ operation: reserved.operation, input: input() } as never)).rejects.toEqual(new ForbiddenError("Cannot modify protected fields on widget: deletedAt"))

    const keep = await ready({ crud: { update: { transformInput: async () => undefined } } })
    const original = input()
    expect(await keep.capture.definition.before?.({ operation: keep.operation, input: original } as never)).toBe(original)
  })

  it("re-checks the original patch against the reserved fields too", async () => {
    const h = await ready({ crud: { update: { transformInput: async () => undefined } }, update: { protectedFields: ["name"] } })
    await expect(h.capture.definition.before?.({ operation: h.operation, input: input() } as never)).rejects.toEqual(new ForbiddenError("Cannot modify protected fields on widget: name"))
  })
})

describe("update execute: lookup and scope", () => {
  it("looks the row up by key under the structural and action scope", async () => {
    const h = await ready()
    await run(h)
    expect(h.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(Predicate.and(base, tenant), ALLOW_ALL_SCOPE)])
  })

  it("composes the filter from whichever scopes apply", async () => {
    const platformH = await ready(platform, {}, "platform")
    await run(platformH, { expectedVersion: undefined, existing: row({ version: 3 }) })
    expect(platformH.repo.updateOneWhereReturning?.mock.calls[0]?.[0]).toEqual(Predicate.and(base, ALLOW_ALL_SCOPE))

    const tenantOnly = await ready()
    await tenantOnly.capture.definition.execute({ operation: mutationOperation(asAnonymous(tenantOnly.context), tenantOnly.persistence), input: input() } as never)
    expect(tenantOnly.repo.findOneWhere?.mock.calls[0]).toEqual([Predicate.and(base, tenant)])

    const bare = await ready(platform, {}, "platform")
    await bare.capture.definition.execute({ operation: mutationOperation(asAnonymous(bare.context), bare.persistence), input: input({ expectedVersion: undefined }) } as never)
    expect(bare.repo.findOneWhere?.mock.calls[0]).toEqual([base])
  })

  it("keys the lookup by the declared primary key, defaulting to id", async () => {
    const keyed = await ready({ entity: widgetEntity({ primaryKey: "name" }) })
    await run(keyed)
    expect(keyed.repo.findOneWhere?.mock.calls[0]?.[0]).toEqual(Predicate.and(Predicate.and(Predicate.eq("name", "w1"), tenant), ALLOW_ALL_SCOPE))
    const keyless = await ready({ entity: keylessEntity() })
    await run(keyless)
    expect(keyless.repo.findOneWhere?.mock.calls[0]?.[0]).toEqual(Predicate.and(Predicate.and(base, tenant), ALLOW_ALL_SCOPE))
  })

  it("falls back to a single-row page read when the repository has no keyed lookup", async () => {
    const findMany = vi.fn(async () => rowsOf(row(), row({ id: "other" })))
    const h = await ready({}, { findOneWhere: undefined, findMany })
    await run(h)
    expect(findMany.mock.calls[0]).toEqual([{ filter: Predicate.and(Predicate.and(base, tenant), ALLOW_ALL_SCOPE), pagination: { kind: "offset", page: 1, pageSize: 1 } }])
    const none = await ready({}, { findOneWhere: undefined, findMany: vi.fn(async () => rowsOf()) })
    await expect(run(none)).rejects.toEqual(new NotFoundError("widget not found"))
  })

  it("answers not found without updating", async () => {
    const h = await ready({}, { findOneWhere: vi.fn(async () => null) })
    await expect(run(h)).rejects.toEqual(new NotFoundError("widget not found"))
    expect(h.repo.updateOneWhereReturning).not.toHaveBeenCalled()
  })

  it("enforces the update rule on the pre-image and the post-image of the found row", async () => {
    const enforce = vi.fn()
    const h = await ready()
    await run(h, {}, { enforceAbac: { enforce } })
    expect(enforce).toHaveBeenCalledTimes(2)
    expect(enforce.mock.calls[0]).toEqual(["update", row(), ["name"]])
    expect(enforce.mock.calls[1]).toEqual(["update", row({ name: "after" }), ["name"]])
    expect(captured.preImages).toContain(enforce.mock.calls[0]?.[1])
    expect(captured.preImages).not.toContain(enforce.mock.calls[1]?.[1])
    expect(captured.preImages.every((image) => image !== h.operation)).toBe(true)
    await expect(run(await ready())).resolves.toBeDefined()
  })
})

describe("update execute: concurrency", () => {
  it("requires a numeric stored version", async () => {
    const h = await ready({}, { findOneWhere: vi.fn(async () => row({ version: "3" as never })) })
    await expect(run(h)).rejects.toEqual(new ConfigurationError('Optimistic concurrency for "widget" requires numeric version field "version"'))
    expect(h.repo.updateOneWhereReturning).not.toHaveBeenCalled()
  })

  it("requires an expected version, and refuses a stale one", async () => {
    const h = await ready()
    await expect(run(h, { expectedVersion: undefined })).rejects.toEqual(new PreconditionRequiredError("If-Match"))
    await expect(run(h, { expectedVersion: "3" })).rejects.toEqual(new PreconditionRequiredError("If-Match"))
    await expect(run(h, { expectedVersion: 2 })).rejects.toEqual(new ConflictError("This record was modified by another user. Please reload and try again."))
    expect(h.repo.updateOneWhereReturning).not.toHaveBeenCalled()
  })

  it("fences the update on the expected version and passes it as the OCC option", async () => {
    const h = await ready()
    await run(h)
    expect(h.repo.updateOneWhereReturning?.mock.calls[0]).toEqual([
      Predicate.and(Predicate.and(Predicate.and(base, tenant), ALLOW_ALL_SCOPE), Predicate.eq("version", 3)),
      { name: "after" },
      { optimisticConcurrency: { expectedVersion: 3 } },
    ])
  })

  it("uses the configured concurrency field", async () => {
    const h = await ready({ optimisticConcurrency: { versionField: "name" } }, { findOneWhere: vi.fn(async () => row({ name: 7 as never })) })
    await run(h, { expectedVersion: 7 })
    expect(h.repo.updateOneWhereReturning?.mock.calls[0]?.[0]).toEqual(Predicate.and(Predicate.and(Predicate.and(base, tenant), ALLOW_ALL_SCOPE), Predicate.eq("name", 7)))
  })

  it("updates an unversioned entity without a precondition", async () => {
    const h = await ready({ entity: plainEntity() }, { findOneWhere: vi.fn(async () => row()), findMany: vi.fn(async () => rowsOf(row({ name: "after" }))), updateOneWhereReturning: vi.fn(async () => row({ name: "after" })) })
    await run(h, { expectedVersion: undefined })
    expect(h.repo.updateOneWhereReturning?.mock.calls[0]).toEqual([Predicate.and(Predicate.and(base, tenant), ALLOW_ALL_SCOPE), { name: "after" }, undefined])
  })
})

describe("update execute: write outcome", () => {
  it("returns the updated row and reads it back through the writing transaction", async () => {
    const h = await ready()
    const result = await run(h) as { record: Row; committedRead: { kind: string }; hookPersistence: unknown }
    expect(result.record).toEqual(row({ version: 4, name: "after" }))
    expect(result.committedRead.kind).toBe("record")
    expect(result.hookPersistence).toBe(h.operation.persistence)
  })

  it("reads the committed row only at the version the update returned, under the structural scope", async () => {
    const stale = await ready({}, { findMany: vi.fn(async () => rowsOf(row({ version: 9 }))) })
    expect((await run(stale) as { committedRead: { kind: string } }).committedRead.kind).toBe("revision-unavailable")

    const S = Predicate.eq("name", "visible")
    const scoped = await ready({ ...platform, entityScope: { kind: "platform", scopeFilter: S } }, { findOneWhere: vi.fn(async () => row({ name: "visible" })), updateOneWhereReturning: vi.fn(async () => row({ name: "visible", version: 4 })), findMany: vi.fn(async () => rowsOf(row({ name: "visible", version: 4 }))) }, "platform")
    await run(scoped, { expectedVersion: 3 })
    const filter = scoped.repo.findMany.mock.calls[0]?.[0].filter as PredicateNode
    expect(filter).toEqual(expect.objectContaining({ kind: "and" }))
    expect(JSON.stringify(filter)).toContain("visible")
  })

  it("reads an unversioned entity back without a version check", async () => {
    const h = await ready({ entity: plainEntity() }, { updateOneWhereReturning: vi.fn(async () => ({ id: "w1", tenantId: "tenant-1", name: "after" })), findMany: vi.fn(async () => rowsOf(row({ name: "after" }))) })
    const result = await run(h, { expectedVersion: undefined }) as { committedRead: { kind: string } }
    expect(result.committedRead.kind).toBe("record")
  })

  it("rejects an invalid committed version", async () => {
    for (const version of [-1, 1.5, "4"]) {
      const h = await ready({}, { updateOneWhereReturning: vi.fn(async () => row({ version: version as never })) })
      await expect(run(h)).rejects.toThrow()
    }
  })

  it("reports a lost race as a conflict when fenced, and as not found otherwise", async () => {
    const fenced = await ready({}, { updateOneWhereReturning: vi.fn(async () => null) })
    await expect(run(fenced)).rejects.toEqual(new ConflictError("This record was modified by another user. Please reload and try again."))
    const open = await ready({ entity: plainEntity() }, { updateOneWhereReturning: vi.fn(async () => null) })
    await expect(run(open, { expectedVersion: undefined })).rejects.toEqual(new NotFoundError("widget not found"))
  })

  it("requires the repository to support filtered updates", async () => {
    const h = await ready({}, { updateOneWhereReturning: undefined })
    await expect(run(h)).rejects.toEqual(new ConfigurationError("Secure update for widget requires updateOneWhereReturning support"))
  })
})

describe("update atomic batch", () => {
  const prepare = (h: Ready, over: Record<string, unknown> = {}, context = h.context, operationExtra: Record<string, unknown> = {}) =>
    h.capture.definition.atomicBatch.prepare({ operation: { ...mutationOperation(context, h.persistence), ...operationExtra }, input: input(over) } as never)

  it("prepares a fenced update command and the predicted result", async () => {
    const h = await ready()
    const prepared = await prepare(h)
    expect(prepared.commands).toEqual([{
      kind: "update",
      entity: "widget",
      filter: Predicate.and(Predicate.and(Predicate.and(base, tenant), ALLOW_ALL_SCOPE), Predicate.eq("version", 3)),
      values: { name: "after" },
      expectedAffectedRows: 1,
      expectedVersion: 3,
    }])
    expect(prepared.result).toEqual({ record: { ...row(), name: "after", version: 4 } })
  })

  it("composes the filter from whichever scopes apply", async () => {
    const platformH = await ready(platform, {}, "platform")
    expect((await prepare(platformH, { expectedVersion: undefined })).commands[0]).toMatchObject({ filter: Predicate.and(base, ALLOW_ALL_SCOPE) })
    const tenantOnly = await ready()
    expect((await prepare(tenantOnly, {}, asAnonymous(tenantOnly.context))).commands[0]).toMatchObject({ filter: Predicate.and(Predicate.and(base, tenant), Predicate.eq("version", 3)) })
    const bare = await ready(platform, {}, "platform")
    expect((await prepare(bare, { expectedVersion: undefined }, asAnonymous(bare.context))).commands[0]).toMatchObject({ filter: base })
  })

  it("keys the command by id without a declared primary key, and carries the namespace", async () => {
    const h = await ready({ entity: keylessEntity({ namespace: "crm" }) })
    const command = (await prepare(h)).commands[0] as { filter: unknown; namespace: string }
    expect(command.namespace).toBe("crm")
    expect(command.filter).toEqual(Predicate.and(Predicate.and(Predicate.and(base, tenant), ALLOW_ALL_SCOPE), Predicate.eq("version", 3)))
    const plain = await ready()
    expect("namespace" in ((await prepare(plain)).commands[0] as object)).toBe(false)
  })

  it("checks protected fields and enforces both images before preparing", async () => {
    const h = await ready({ update: { protectedFields: ["name"] } })
    await expect(prepare(h)).rejects.toEqual(new ForbiddenError("Cannot modify protected fields on widget: name"))
    const enforce = vi.fn()
    const ok = await ready()
    await prepare(ok, {}, ok.context, { enforceAbac: { enforce } })
    expect(enforce).toHaveBeenCalledTimes(2)
    expect(enforce.mock.calls[0]).toEqual(["update", row(), ["name"]])
    expect(enforce.mock.calls[1]).toEqual(["update", row({ name: "after" }), ["name"]])
    expect(captured.preImages).toContain(enforce.mock.calls[0]?.[1])
  })

  it("requires the expected version and a numeric stored version for a versioned entity", async () => {
    const h = await ready()
    await expect(prepare(h, { expectedVersion: undefined })).rejects.toEqual(new PreconditionRequiredError("If-Match"))
    await expect(prepare(h, { expectedVersion: "3" })).rejects.toEqual(new PreconditionRequiredError("If-Match"))
    await expect(prepare(h, { expectedVersion: 2 })).rejects.toEqual(new ConflictError("This record was modified by another user. Please reload and try again."))
    await expect(prepare(h, { existing: row({ version: "3" as never }) })).rejects.toEqual(new ConfigurationError('Optimistic concurrency for "widget" requires numeric version field "version"'))
  })

  it("prepares an unversioned update without version fencing or a predicted version", async () => {
    const h = await ready({ entity: plainEntity() })
    const prepared = await prepare(h, { expectedVersion: undefined, existing: { id: "w1", tenantId: "tenant-1", name: "n" } })
    const command = prepared.commands[0] as Record<string, unknown>
    expect("expectedVersion" in command).toBe(false)
    expect(command.filter).toEqual(Predicate.and(Predicate.and(base, tenant), ALLOW_ALL_SCOPE))
    expect(prepared.result).toEqual({ record: { id: "w1", tenantId: "tenant-1", name: "after" } })
    const ignoresStray = await prepare(h, { expectedVersion: 5, existing: { id: "w1", tenantId: "tenant-1", name: "n" } })
    expect(ignoresStray.result).toEqual({ record: { id: "w1", tenantId: "tenant-1", name: "after" } })
  })

  describe("verification", () => {
    const verifyOf = async () => (await prepare(await ready())).verify

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
        expect(() => verify({ commandResults } as never)).toThrow(new ConfigurationError("Atomic update did not return affected-row metadata"))
      }
    })

    it("reports a conflict when the row count is not one", async () => {
      const verify = await verifyOf()
      for (const changes of [0, 2]) {
        expect(() => verify({ commandResults: [{ changes }] } as never)).toThrow(new ConflictError("This record was modified by another user. Please reload and try again."))
      }
    })
  })
})

describe("update after", () => {
  it("builds the response from the transaction's committed read", async () => {
    const h = await ready()
    const executed = await run(h)
    const outcome = await h.capture.definition.after?.({ operation: h.operation, input: input(), result: executed } as never)
    expect(outcome).toEqual({ record: expect.objectContaining({ id: "w1", name: "after", version: 4 }) })
    expect(h.repo.findMany).toHaveBeenCalledTimes(1)
  })

  it("rereads on the batch path, at the predicted version", async () => {
    const h = await ready()
    const outcome = await h.capture.definition.after?.({ operation: h.operation, input: input(), result: { record: row({ version: 4, name: "after" }) } } as never)
    expect(outcome).toEqual({ record: expect.objectContaining({ version: 4 }) })
    expect(h.repo.findMany).toHaveBeenCalledTimes(1)
    const stale = await ready({}, { findMany: vi.fn(async () => rowsOf(row({ version: 9 }))) })
    expect(await stale.capture.definition.after?.({ operation: stale.operation, input: input(), result: { record: row({ version: 4 }) } } as never)).toEqual({ success: true, reason: "UPDATED_OUTSIDE_READ_SCOPE" })
    const plain = await ready({ entity: plainEntity() }, { findMany: vi.fn(async () => rowsOf(row({ name: "after" }))) })
    expect(await plain.capture.definition.after?.({ operation: plain.operation, input: input(), result: { record: { id: "w1", tenantId: "tenant-1", name: "after" } } } as never)).toEqual({ record: expect.objectContaining({ id: "w1" }) })
    await expect(h.capture.definition.after?.({ operation: h.operation, input: input(), result: { record: { id: "w1", version: -1 } } } as never)).rejects.toThrow()
  })

  it("answers the acknowledgement when the committed row is not readable, and refuses a result without a record", async () => {
    const gone = await ready({}, { findMany: vi.fn(async () => rowsOf()) })
    const executed = await run(gone)
    expect(await gone.capture.definition.after?.({ operation: gone.operation, input: input(), result: executed } as never)).toEqual({ success: true, reason: "UPDATED_OUTSIDE_READ_SCOPE" })
    await expect(gone.capture.definition.after?.({ operation: gone.operation, input: input(), result: { success: true } } as never)).rejects.toEqual(new ConfigurationError("Mutation result record is unavailable"))
  })

  it("reads under the entity's structural scope", async () => {
    const S = Predicate.eq("name", "visible")
    const h = await ready({ ...platform, entityScope: { kind: "platform", scopeFilter: S } }, { findMany: vi.fn(async () => rowsOf(row({ name: "visible" }))) }, "platform")
    await h.capture.definition.after?.({ operation: h.operation, input: input(), result: { record: { id: "w1", name: "visible" } } } as never)
    const filter = h.repo.findMany.mock.calls[0]?.[0].filter as PredicateNode
    expect(JSON.stringify(filter)).toContain("visible")
  })

  it("passes the projection hook the projected existing row, both patches and the committed row", async () => {
    const projectCommittedResult = vi.fn(async ({ result }: { result: Row }) => ({ ...result, name: "projected" }))
    const h = await ready({ crud: { update: { projectCommittedResult } } })
    const executed = await run(h)
    const outcome = await h.capture.definition.after?.({ operation: h.operation, input: input({ existing: { ...row(), ghost: "x" } }), result: executed } as never) as { record: Row }
    expect(outcome.record.name).toBe("projected")
    const call = projectCommittedResult.mock.calls[0]?.[0] as unknown as { existing: Record<string, unknown>; patch: unknown; originalPatch: unknown; result: Row; context: { tenantId: string } }
    expect(call.existing).toEqual(row())
    expect("ghost" in call.existing).toBe(false)
    expect(call.patch).toEqual({ name: "after" })
    expect(call.originalPatch).toEqual({ name: "after" })
    expect(call.result).toMatchObject({ id: "w1", version: 4 })
    expect(call.context.tenantId).toBe("tenant-1")
  })

  it("applies the field-level read overrides to the existing row, the committed row and the hook's output", async () => {
    const bundle = await bindAbacSecurityDigest({
      mode: "tenant",
      moduleKey: MODULE_KEY,
      policies: [{
        source: { policyId: "p1", scopeType: "tenant_default" as const },
        moduleKey: MODULE_KEY,
        effect: "allow",
        priority: 1,
        payload: {
          actions: ["read", "update"],
          capabilities: [],
          conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
          fieldAccess: { read: { id: "allow", tenantId: "allow", name: "allow", version: "allow" } },
        },
        compiledConditions: Predicate.alwaysTrue(),
      }],
      context: { tenantId: "tenant-1" },
      defaultEffect: "deny",
      fieldCatalog: {},
    } as never)
    const projectCommittedResult = vi.fn(async ({ result }: { result: Row }) => ({ ...result, deletedAt: "leaked" }))
    const base0 = baseOptions()
    const h = await ready({ adapterDeps: { ...base0.adapterDeps, resolveAbacBundle: async () => bundle }, crud: { update: { projectCommittedResult } } }, { findMany: vi.fn(async () => rowsOf(row({ version: 4, deletedAt: "secret" }))) })
    const executed = await run(h)
    const outcome = await h.capture.definition.after?.({ operation: h.operation, input: input({ existing: row({ deletedAt: "old-secret" }) }), result: executed } as never) as { record: Record<string, unknown> }
    expect("deletedAt" in outcome.record).toBe(false)
    const hookCall = projectCommittedResult.mock.calls[0]?.[0] as unknown as { existing: Record<string, unknown> }
    expect("deletedAt" in hookCall.existing).toBe(false)
  })
})

describe("update authorization and commit hooks", () => {
  it("enforces the update rule on both images of the existing row when an enforcer exists", async () => {
    const enforce = vi.fn()
    const h = await ready()
    const operation = { ...h.operation, enforceAbac: { enforce } }
    expect(await h.capture.definition.authorization.authorize({ operation, input: input() } as never)).toEqual({ allowed: true })
    expect(enforce).toHaveBeenCalledTimes(2)
    expect(enforce.mock.calls[0]).toEqual(["update", row(), ["name"]])
    expect(enforce.mock.calls[1]).toEqual(["update", row({ name: "after" }), ["name"]])
    expect(await h.capture.definition.authorization.authorize({ operation: h.operation, input: input() } as never)).toEqual({ allowed: true })
  })

  const recordDependentBundle = () => bindAbacSecurityDigest({
    mode: "tenant",
    moduleKey: MODULE_KEY,
    policies: [{
      source: { policyId: "p1", scopeType: "tenant_default" as const },
      moduleKey: MODULE_KEY,
      effect: "allow",
      priority: 1,
      payload: {
        actions: ["read", "update"],
        capabilities: [],
        conditions: { version: 2, systemScope: { logic: "AND", conditions: [] }, userFilters: { logic: "AND", conditions: [] } },
        fieldAccess: { write: ["name"] },
      },
      compiledConditions: Predicate.eq("name", "n"),
    }],
    context: { tenantId: "tenant-1" },
    defaultEffect: "deny",
    fieldCatalog: {},
  } as never)

  it("requires optimistic concurrency when a field-write rule depends on the record", async () => {
    const bundle = await recordDependentBundle()
    const base0 = baseOptions()
    const dependent = { adapterDeps: { ...base0.adapterDeps, resolveAbacBundle: async () => bundle } }
    const enforce = vi.fn()
    const message = 'Record-dependent field-write ABAC on "widget" requires optimistic concurrency'

    const unversioned = await ready({ ...dependent, entity: plainEntity() })
    await expect(unversioned.capture.definition.authorization.authorize({ operation: { ...unversioned.operation, enforceAbac: { enforce } }, input: input({ expectedVersion: undefined }) } as never)).rejects.toEqual(new ConfigurationError(message))

    const missingVersion = await ready(dependent)
    await expect(missingVersion.capture.definition.authorization.authorize({ operation: { ...missingVersion.operation, enforceAbac: { enforce } }, input: input({ expectedVersion: undefined }) } as never)).rejects.toEqual(new ConfigurationError(message))

    const satisfied = await ready(dependent)
    await expect(satisfied.capture.definition.authorization.authorize({ operation: { ...satisfied.operation, enforceAbac: { enforce } }, input: input() } as never)).resolves.toEqual({ allowed: true })

    const configured = await ready({ ...dependent, entity: plainEntity(), optimisticConcurrency: { versionField: "version" } })
    await expect(configured.capture.definition.authorization.authorize({ operation: { ...configured.operation, enforceAbac: { enforce } }, input: input() } as never)).resolves.toEqual({ allowed: true })
    await expect(configured.capture.definition.authorization.authorize({ operation: { ...configured.operation, enforceAbac: { enforce } }, input: input({ expectedVersion: undefined }) } as never)).rejects.toEqual(new ConfigurationError(message))
  })

  it("does not demand concurrency without record-dependent rules, for anonymous callers or without a bundle", async () => {
    const enforce = vi.fn()
    const plainRules = await ready({ entity: plainEntity() })
    await expect(plainRules.capture.definition.authorization.authorize({ operation: { ...plainRules.operation, enforceAbac: { enforce } }, input: input({ expectedVersion: undefined }) } as never)).resolves.toEqual({ allowed: true })

    const bundle = await recordDependentBundle()
    const base0 = baseOptions()
    const dependent = await ready({ adapterDeps: { ...base0.adapterDeps, resolveAbacBundle: async () => bundle }, entity: plainEntity() })
    await expect(dependent.capture.definition.authorization.authorize({ operation: { ...mutationOperation(asAnonymous(dependent.context), dependent.persistence), enforceAbac: { enforce } }, input: input({ expectedVersion: undefined }) } as never)).resolves.toEqual({ allowed: true })

    const noBundle = await ready({ adapterDeps: { ...base0.adapterDeps, resolveAbacBundle: async () => null }, entity: plainEntity() })
    await expect(noBundle.capture.definition.authorization.authorize({ operation: { ...noBundle.operation, enforceAbac: { enforce } }, input: input({ expectedVersion: undefined }) } as never)).resolves.toEqual({ allowed: true })
  })

  it("asks the bundle resolver for this module with the request context", async () => {
    const resolveAbacBundle = vi.fn(async () => null)
    const base0 = baseOptions()
    const h = await ready({ adapterDeps: { ...base0.adapterDeps, resolveAbacBundle } })
    await h.capture.definition.authorization.authorize({ operation: { ...h.operation, enforceAbac: { enforce: vi.fn() } }, input: input() } as never)
    expect(resolveAbacBundle).toHaveBeenCalledWith({ moduleKey: MODULE_KEY, context: h.context })
  })

  it("runs the after-commit hook with the committed record, or the identity when the row is unreadable", async () => {
    const afterCommit = vi.fn(async () => undefined)
    const h = await ready({ crud: { update: { afterCommit } } })
    const operation = { ...h.operation, metadata: { requestId: "meta-req" }, correlationId: "corr-9" }
    await h.capture.definition.afterCommit?.({ operation, input: input(), result: { record: { id: "w1", name: "after" } } } as never)
    expect(afterCommit).toHaveBeenLastCalledWith({
      existing: row(),
      patch: { name: "after" },
      result: { id: "w1", name: "after" },
      operation,
      context: { tenantId: "tenant-1", requestId: "meta-req", correlationId: "corr-9" },
    })
    await h.capture.definition.afterCommit?.({ operation, input: input(), result: { success: true, reason: "UPDATED_OUTSIDE_READ_SCOPE" } } as never)
    expect(afterCommit).toHaveBeenLastCalledWith(expect.objectContaining({ result: { id: "w1" } }))
    const keyed = await ready({ entity: widgetEntity({ primaryKey: "name" }), crud: { update: { afterCommit } } })
    await keyed.capture.definition.afterCommit?.({ operation, input: input(), result: { success: true } } as never)
    expect(afterCommit).toHaveBeenLastCalledWith(expect.objectContaining({ result: { name: "w1" } }))
    const keyless = await ready({ entity: keylessEntity(), crud: { update: { afterCommit } } })
    await keyless.capture.definition.afterCommit?.({ operation, input: input(), result: { success: true } } as never)
    expect(afterCommit).toHaveBeenLastCalledWith(expect.objectContaining({ result: { id: "w1" } }))
  })
})

describe("update audit definition", () => {
  it("describes the updated resource with the configured audit options", () => {
    const fieldClassification = { name: "pii" } as never
    const audit = build(baseOptions({ audit: { enabled: true, resource: "Widget", fieldClassification, required: false, auditGuarantee: "atomic", requiredStateSemantics: "committed-state" } })).definition.audit
    expect(audit?.action).toBe("Widget.updated")
    expect(audit?.resourceType).toBe("Widget")
    expect(audit?.fieldClassification).toBe(fieldClassification)
    expect(audit?.required).toBe(false)
    expect(audit?.auditGuarantee).toBe("atomic")
    expect(audit?.requiredStateSemantics).toBe("committed-state")
    expect("extractOldValue" in (audit ?? {})).toBe(false)
    expect("extractNewValue" in (audit ?? {})).toBe(false)
  })

  it("falls back to the entity name and omits unset options", () => {
    const audit = build(baseOptions({ audit: { enabled: true } })).definition.audit
    expect(audit?.action).toBe("widget.updated")
    expect(audit?.resourceType).toBe("widget")
    for (const key of ["fieldClassification", "required", "auditGuarantee", "requiredStateSemantics"]) expect(key in (audit ?? {})).toBe(false)
  })

  it("resolves the resource id from the committed record, or the input id when none is readable", () => {
    const audit = build(baseOptions({ audit: { enabled: true } })).definition.audit
    expect(audit?.resolveResourceId({ input: { id: "from-input" }, result: { record: { id: 42 } } } as never)).toBe("42")
    expect(audit?.resolveResourceId({ input: { id: "from-input" }, result: { success: true } } as never)).toBe("from-input")
    const keyed = build(baseOptions({ audit: { enabled: true }, entity: widgetEntity({ primaryKey: "name" }) })).definition.audit
    expect(keyed?.resolveResourceId({ input: { id: "from-input" }, result: { record: { id: "no", name: "key-value" } } } as never)).toBe("key-value")
    const keyless = build(baseOptions({ audit: { enabled: true }, entity: keylessEntity() })).definition.audit
    expect(keyless?.resolveResourceId({ input: { id: "from-input" }, result: { record: { id: "7", name: "x" } } } as never)).toBe("7")
  })

  it("includes the old and new values only on request, projecting both", () => {
    const audit = build(baseOptions({ audit: { enabled: true, resource: "Widget", includeValues: true } })).definition.audit
    expect(audit?.extractOldValue?.({ input: { existing: { id: "w1", name: "old", ghost: "x" } } } as never)).toEqual({ id: "w1", name: "old" })
    expect(audit?.extractNewValue?.({ result: { record: { id: "w1", name: "new", ghost: "x" } } } as never)).toEqual({ id: "w1", name: "new" })
    expect(audit?.extractNewValue?.({ result: { success: true } } as never)).toEqual({})
    const off = build(baseOptions({ audit: { enabled: true, resource: "Widget", includeValues: false } })).definition.audit
    expect("extractOldValue" in (off ?? {})).toBe(false)
    expect("extractNewValue" in (off ?? {})).toBe(false)
  })
})

describe("update recovery", () => {
  it("rebuilds the committed response from the stored resource identity", async () => {
    const h = await ready()
    expect(await h.capture.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1", version: 4 }, context: h.context } as never)).toEqual({ record: expect.objectContaining({ id: "w1", version: 4 }) })
  })

  it("answers nothing when the committed revision is gone", async () => {
    const stale = await ready({}, { findMany: vi.fn(async () => rowsOf(row({ version: 9 }))) })
    expect(await stale.capture.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1", version: 4 }, context: stale.context } as never)).toBeNull()
    const missing = await ready({}, { findMany: vi.fn(async () => rowsOf()) })
    expect(await missing.capture.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1", version: 4 }, context: missing.context } as never)).toBeNull()
  })

  it("reads without a version check when the identity carries none, under the structural scope", async () => {
    const h = await ready({}, { findMany: vi.fn(async () => rowsOf(row({ version: 9 }))) })
    expect(await h.capture.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1" }, context: h.context } as never)).toEqual({ record: expect.objectContaining({ version: 9 }) })
    const S = Predicate.eq("name", "visible")
    const scoped = await ready({ ...platform, entityScope: { kind: "platform", scopeFilter: S } }, { findMany: vi.fn(async () => rowsOf(row({ name: "visible" }))) }, "platform")
    await scoped.capture.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1" }, context: scoped.context } as never)
    expect(JSON.stringify(scoped.repo.findMany.mock.calls[0]?.[0].filter)).toContain("visible")
  })
})
