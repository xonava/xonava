import { beforeEach, describe, expect, it, vi } from "vitest"
import { ConfigurationError, ForbiddenError, Predicate, bindAbacSecurityDigest, evaluatePredicate, type PredicateNode } from "@xonava/core/domain"
import { createCreateHandler } from "../create"
import {
  MODULE_KEY,
  baseOptions,
  contextFor,
  fakeRepo,
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

const row = (over: Partial<Row> = {}): Row => ({ id: "w1", tenantId: "tenant-1", version: 1, name: "n", ...over })
const rowsOf = (...rows: Row[]) => ({ rows, rowCount: rows.length, page: 1, pageSize: 1 })

function build(options = baseOptions(), shared: Record<string, unknown> = {}) {
  createCreateHandler(sharedOf(options, shared))
  return lastCapture(captured.calls)
}

async function ready(over: Record<string, unknown> = {}, repoOver: Record<string, unknown> = {}, caps: Record<string, unknown> = {}) {
  const repo = fakeRepo({ findMany: vi.fn(async () => rowsOf(row())), ...repoOver })
  const persistence = persistenceOf(repo, caps)
  const options = baseOptions({ createPersistence: () => persistence, ...over })
  const capture = build(options)
  const context = await contextFor("tenant", "create")
  return { repo, persistence, options, capture, context, operation: mutationOperation(context, persistence) }
}

const input = (body: Record<string, unknown> = { name: "n" }) => ({ body, originalBody: body, id: "w1" })

describe("create handler wiring", () => {
  it("passes the configured pieces to the write handler", () => {
    const options = baseOptions({ getRateLimitStore: async () => ({}) as never, auditSinkFactory: () => ({ write: vi.fn() }), outboxSinkFactory: () => ({ append: vi.fn() }), audit: { enabled: true, resource: "Widget" } })
    const capture = build(options, { invalidateTags: () => ["t"] })
    expect(capture.adapterDeps).toBe(options.adapterDeps)
    expect(capture.requestNormalization).toBe(options.requestNormalization)
    expect(capture.scope).toBe(options.scope)
    expect(capture.moduleKey).toBe(MODULE_KEY)
    expect(capture.action).toBe("create")
    expect(capture.skipCapabilityCheck).toBe(true)
    expect(capture.getCacheAdapter).toBe(options.getCacheAdapter)
    expect(capture.getRateLimitStore).toBe(options.getRateLimitStore)
    expect(capture.runtimeCapabilities).toEqual({ deferredExecution: true, cache: true })
    expect(capture.auditSinkFactory).toBe(options.auditSinkFactory)
    expect(capture.outboxSinkFactory).toBe(options.outboxSinkFactory)
    expect(capture.createPersistence).toBe(options.createPersistence)
    expect(capture.invalidateTags).toBeTypeOf("function")
    expect(capture.validation).toEqual({ body: options.validation?.createBody })
    expect(capture.definition.key).toBe(`${MODULE_KEY}.create`)
    expect(capture.definition.kind).toBe("mutation")
    expect(capture.definition.atomicity).toEqual({ kind: "standard", mode: "required" })
  })

  it("leaves out what is not configured", () => {
    const capture = build(baseOptions({ validation: {} }))
    for (const key of ["getRateLimitStore", "auditSinkFactory", "outboxSinkFactory", "invalidateTags", "validation", "rateLimit"]) expect(key in capture).toBe(false)
    expect("before" in capture.definition).toBe(false)
    expect("afterCommit" in capture.definition).toBe(false)
    expect("audit" in capture.definition).toBe(false)
  })

  it("does not hand an audit sink factory over when audit is not emitted for create", () => {
    const options = baseOptions({ auditSinkFactory: () => ({ write: vi.fn() }), audit: { enabled: true, resource: "Widget", emitOn: ["update"] } })
    const capture = build(options)
    expect("auditSinkFactory" in capture).toBe(false)
    expect("audit" in capture.definition).toBe(false)
    const disabled = build(baseOptions({ auditSinkFactory: () => ({ write: vi.fn() }), audit: { enabled: false, resource: "Widget" } }))
    expect("auditSinkFactory" in disabled).toBe(false)
    const emitted = build(baseOptions({ auditSinkFactory: () => ({ write: vi.fn() }), audit: { enabled: true, resource: "Widget", emitOn: ["create"] } }))
    expect(emitted.auditSinkFactory).toBeTypeOf("function")
    const noFactory = build(baseOptions({ audit: { enabled: true, resource: "Widget" } }))
    expect("auditSinkFactory" in noFactory).toBe(false)
    expect(noFactory.definition.audit).toBeDefined()
  })

  it("maps the create rate limit, passing the failure mode only when set", () => {
    const withMode = build(baseOptions({ rateLimit: { create: { max: 3, timeWindow: "1 minute", consistency: "atomic", failureMode: "fail-open" } } }))
    expect(withMode.rateLimit).toEqual({ config: { max: 3, timeWindow: "1 minute", consistency: "atomic", failureMode: "fail-open" }, consistency: "atomic", failureMode: "fail-open" })
    const withoutMode = build(baseOptions({ rateLimit: { create: { max: 3, timeWindow: "1 minute", consistency: "best-effort" } } }))
    expect(withoutMode.rateLimit).toEqual({ config: { max: 3, timeWindow: "1 minute", consistency: "best-effort" }, consistency: "best-effort" })
    expect("failureMode" in (withoutMode.rateLimit ?? {})).toBe(false)
  })

  it("answers 201 with the record, or with the acknowledgement when the row is outside the read scope", async () => {
    const capture = build()
    const created = capture.toResponse({ record: { id: "w1", name: "n" } } as never)
    expect(created.status).toBe(201)
    expect(await created.json()).toEqual({ id: "w1", name: "n" })
    const acknowledged = capture.toResponse({ success: true, reason: "CREATED_OUTSIDE_READ_SCOPE" } as never)
    expect(acknowledged.status).toBe(201)
    expect(await acknowledged.json()).toEqual({ success: true, reason: "CREATED_OUTSIDE_READ_SCOPE" })
  })
})

describe("create input and identity", () => {
  it("resolves the validated body with a fresh time-ordered id", async () => {
    const capture = build()
    const first = await capture.resolveInput({ validated: { validatedBody: { name: "a" } } } as never) as { body: unknown; originalBody: unknown; id: string }
    const second = await capture.resolveInput({ validated: { validatedBody: { name: "a" } } } as never) as { id: string }
    expect(first.body).toEqual({ name: "a" })
    expect(first.originalBody).toBe(first.body)
    expect(first.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second.id).not.toBe(first.id)
  })

  it.each(["id", "tenantId", "version"])("refuses a body that supplies the protected field %s", async (field) => {
    const capture = build()
    await expect(capture.resolveInput({ validated: { validatedBody: { name: "a", [field]: "x" } } } as never)).rejects.toEqual(new ForbiddenError(`Cannot provide protected fields on widget: ${field}`))
  })

  it("names the identity of the created resource, with version 1 only for versioned entities", () => {
    const versioned = build()
    expect(versioned.resolveResourceIdentity({ input: { id: "w9" } } as never)).toEqual({ entity: MODULE_KEY, id: "w9", version: 1 })
    const plain = build(baseOptions({ entity: plainEntity() }))
    const identity = plain.resolveResourceIdentity({ input: { id: "w9" } } as never)
    expect(identity).toEqual({ entity: MODULE_KEY, id: "w9" })
    expect("version" in identity).toBe(false)
  })
})

describe("create execute", () => {
  it("inserts the scoped record and reads it back through the writing transaction", async () => {
    const { repo, capture, operation } = await ready({}, { insert: vi.fn(async (data: Record<string, unknown>) => ({ ...data })) })
    const result = await capture.definition.execute({ operation, input: input({ name: "n" }) } as never) as { record: Row; committedRead: { kind: string }; hookPersistence: unknown }
    expect(repo.insert).toHaveBeenCalledWith({ name: "n", id: "w1", tenantId: "tenant-1", version: 1 })
    expect(result.record).toEqual({ name: "n", id: "w1", tenantId: "tenant-1", version: 1 })
    expect(result.committedRead.kind).toBe("record")
    expect(result.hookPersistence).toBe(operation.persistence)
  })

  it("refuses protected fields in the final body", async () => {
    const { capture, operation, repo } = await ready()
    await expect(capture.definition.execute({ operation, input: input({ name: "n", version: 4 }) } as never)).rejects.toEqual(new ForbiddenError("Cannot provide protected fields on widget: version"))
    expect(repo.insert).not.toHaveBeenCalled()
  })

  it("enforces the field-level write rules on the final record", async () => {
    const enforce = vi.fn()
    const { capture, operation } = await ready()
    await capture.definition.execute({ operation: { ...operation, enforceAbac: { enforce } }, input: input({ name: "n" }) } as never)
    expect(enforce).toHaveBeenCalledWith("create", { name: "n", id: "w1", tenantId: "tenant-1", version: 1 }, ["name"])
  })

  it("rejects an invalid committed version from the insert", async () => {
    for (const version of [-1, 1.5, "1", Number.NaN]) {
      const { capture, operation } = await ready({}, { insert: vi.fn(async (data: Record<string, unknown>) => ({ ...data, version })) })
      await expect(capture.definition.execute({ operation, input: input() } as never)).rejects.toThrow()
    }
  })

  it("reads the committed row only at the version the insert returned", async () => {
    const { capture, operation } = await ready({}, { findMany: vi.fn(async () => rowsOf(row({ version: 2 }))) })
    const result = await capture.definition.execute({ operation, input: input() } as never) as { committedRead: { kind: string } }
    expect(result.committedRead.kind).toBe("revision-unavailable")
  })

  it("reads an unversioned entity without a version check", async () => {
    const { capture, operation } = await ready({ entity: plainEntity() }, { findMany: vi.fn(async () => rowsOf(row())) })
    const result = await capture.definition.execute({ operation, input: input() } as never) as { record: Record<string, unknown>; committedRead: { kind: string } }
    expect("version" in result.record).toBe(false)
    expect(result.committedRead.kind).toBe("record")
  })

  it("reads back under the entity's structural scope", async () => {
    const scopeFilter = Predicate.eq("name", "visible")
    const options = { entity: unscopedEntity(), entityScope: { kind: "platform", scopeFilter }, scope: { scope: "platform" } }
    const repo = fakeRepo({ findMany: vi.fn(async () => rowsOf(row({ name: "visible" }))) })
    const persistence = persistenceOf(repo)
    const capture = build(baseOptions({ ...options, createPersistence: () => persistence }))
    const context = await contextFor("platform", "create")
    await capture.definition.execute({ operation: mutationOperation(context, persistence), input: input({ name: "visible" }) } as never)
    const filter = repo.findMany.mock.calls[0]?.[0].filter as PredicateNode
    expect(evaluatePredicate({ id: "w1", name: "visible" }, filter)).toBe(true)
    expect(evaluatePredicate({ id: "w1", name: "hidden" }, filter)).toBe(false)
  })
})

describe("create atomic batch", () => {
  it("prepares one insert command with the scoped values and the predicted result", async () => {
    const { capture, operation } = await ready()
    const prepared = await capture.definition.atomicBatch.prepare({ operation, input: input({ name: "n" }) } as never)
    expect(prepared.commands).toEqual([{ kind: "insert", entity: "widget", values: { name: "n", id: "w1", tenantId: "tenant-1", version: 1 } }])
    expect(prepared.result).toEqual({ record: { name: "n", id: "w1", tenantId: "tenant-1", version: 1 } })
    expect("namespace" in (prepared.commands[0] as object)).toBe(false)
  })

  it("carries the entity namespace and refuses protected fields", async () => {
    const { capture, operation } = await ready({ entity: widgetEntity({ namespace: "crm" }) })
    const prepared = await capture.definition.atomicBatch.prepare({ operation, input: input() } as never)
    expect(prepared.commands[0]).toMatchObject({ namespace: "crm" })
    await expect(capture.definition.atomicBatch.prepare({ operation, input: input({ id: "x" }) } as never)).rejects.toBeInstanceOf(ForbiddenError)
  })
})

describe("create before and after", () => {
  it("applies transformInput and re-checks protected fields on its output", async () => {
    const transformInput = vi.fn(async ({ input: body }: { input: Record<string, unknown> }) => ({ ...body, extra: 1 }))
    const { capture, operation } = await ready({ crud: { create: { transformInput } } })
    const next = await capture.definition.before?.({ operation, input: input({ name: "n" }) } as never) as { body: unknown; originalBody: unknown }
    expect(next.body).toEqual({ name: "n", extra: 1 })
    expect(next.originalBody).toEqual({ name: "n" })
    expect(transformInput).toHaveBeenCalledWith({ input: { name: "n" }, context: expect.objectContaining({ tenantId: "tenant-1", requestId: "req-1" }) })

    const keep = await ready({ crud: { create: { transformInput: async () => undefined } } })
    const original = input({ name: "n" })
    expect(await keep.capture.definition.before?.({ operation: keep.operation, input: original } as never)).toBe(original)

    const bad = await ready({ crud: { create: { transformInput: async () => ({ name: "n", tenantId: "other" }) } } })
    await expect(bad.capture.definition.before?.({ operation: bad.operation, input: input() } as never)).rejects.toEqual(new ForbiddenError("Cannot provide protected fields on widget: tenantId"))
  })

  it("builds the response from the transaction's committed read", async () => {
    const { capture, operation, repo } = await ready()
    const executed = await capture.definition.execute({ operation, input: input() } as never)
    const outcome = await capture.definition.after?.({ operation, input: input(), result: executed } as never)
    expect(outcome).toEqual({ record: expect.objectContaining({ id: "w1", name: "n", version: 1 }) })
    expect(repo.findMany).toHaveBeenCalledTimes(1)
  })

  it("rereads on the batch path, which has no committed read, at the predicted version", async () => {
    const { capture, operation, repo } = await ready()
    const outcome = await capture.definition.after?.({ operation, input: input(), result: { record: { name: "n", id: "w1", tenantId: "tenant-1", version: 1 } } } as never)
    expect(outcome).toEqual({ record: expect.objectContaining({ id: "w1", version: 1 }) })
    expect(repo.findMany).toHaveBeenCalledTimes(1)

    const stale = await ready({}, { findMany: vi.fn(async () => rowsOf(row({ version: 3 }))) })
    expect(await stale.capture.definition.after?.({ operation: stale.operation, input: input(), result: { record: { name: "n", id: "w1", tenantId: "tenant-1", version: 1 } } } as never)).toEqual({ success: true, reason: "CREATED_OUTSIDE_READ_SCOPE" })

    const plain = await ready({ entity: plainEntity() })
    expect(await plain.capture.definition.after?.({ operation: plain.operation, input: input(), result: { record: { name: "n", id: "w1", tenantId: "tenant-1" } } } as never)).toEqual({ record: expect.objectContaining({ id: "w1" }) })
  })

  it("rejects an invalid version in the predicted batch record", async () => {
    const { capture, operation } = await ready()
    await expect(capture.definition.after?.({ operation, input: input(), result: { record: { id: "w1", version: -2 } } } as never)).rejects.toThrow()
  })

  it("answers the acknowledgement when the committed row is not readable", async () => {
    const gone = await ready({}, { findMany: vi.fn(async () => rowsOf()) })
    const executed = await gone.capture.definition.execute({ operation: gone.operation, input: input() } as never)
    expect(await gone.capture.definition.after?.({ operation: gone.operation, input: input(), result: executed } as never)).toEqual({ success: true, reason: "CREATED_OUTSIDE_READ_SCOPE" })
  })

  it("refuses a result without a record", async () => {
    const { capture, operation } = await ready()
    await expect(capture.definition.after?.({ operation, input: input(), result: { success: true, reason: "CREATED_OUTSIDE_READ_SCOPE" } } as never)).rejects.toEqual(new ConfigurationError("Mutation result record is unavailable"))
  })

  it("passes the projection hook the committed row, the inputs and a read-only context", async () => {
    const projectCommittedResult = vi.fn(async ({ result }: { result: Row }) => ({ ...result, name: "projected" }))
    const { capture, operation } = await ready({ crud: { create: { projectCommittedResult } } })
    const executed = await capture.definition.execute({ operation, input: input({ name: "n" }) } as never)
    const outcome = await capture.definition.after?.({ operation, input: input({ name: "n" }), result: executed } as never) as { record: Row }
    expect(outcome.record.name).toBe("projected")
    const call = projectCommittedResult.mock.calls[0]?.[0] as unknown as { input: unknown; originalInput: unknown; result: Row; context: { tenantId: string; persistence: unknown } }
    expect(call.input).toEqual({ name: "n" })
    expect(call.originalInput).toEqual({ name: "n" })
    expect(call.result).toMatchObject({ id: "w1", version: 1 })
    expect(call.context.tenantId).toBe("tenant-1")
  })

  it("applies the field-level read overrides to what the hook returns", async () => {
    const bundle = await bindAbacSecurityDigest({
      mode: "tenant",
      moduleKey: MODULE_KEY,
      policies: [{
        source: { policyId: "p1", scopeType: "tenant_default" as const },
        moduleKey: MODULE_KEY,
        effect: "allow",
        priority: 1,
        payload: {
          actions: ["read", "create"],
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
    const base = baseOptions()
    const { capture, operation } = await ready({
      adapterDeps: { ...base.adapterDeps, resolveAbacBundle: async () => bundle },
      crud: { create: { projectCommittedResult } },
    }, { findMany: vi.fn(async () => rowsOf(row({ deletedAt: "secret" }))) })
    const executed = await capture.definition.execute({ operation, input: input() } as never)
    const outcome = await capture.definition.after?.({ operation, input: input(), result: executed } as never) as { record: Record<string, unknown> }
    expect("deletedAt" in outcome.record).toBe(false)
    expect(outcome.record.name).toBe("n")
  })
})

describe("create authorization and commit hooks", () => {
  it("enforces the create rule on the scoped request record before execution", async () => {
    const enforce = vi.fn()
    const { capture, context, persistence } = await ready()
    const operation = mutationOperation(context, persistence, { enforceAbac: { enforce } })
    expect(await capture.definition.authorization.authorize({ operation, input: input({ name: "n" }) } as never)).toEqual({ allowed: true })
    expect(enforce).toHaveBeenCalledWith("create", { name: "n", id: "w1", tenantId: "tenant-1", version: 1 }, ["name"])
  })

  it("skips enforcement without an enforcer or without a request context", async () => {
    const { capture, context, persistence } = await ready()
    const enforce = vi.fn()
    expect(await capture.definition.authorization.authorize({ operation: { ...mutationOperation(context, persistence), enforceAbac: undefined }, input: input() } as never)).toEqual({ allowed: true })
    expect(await capture.definition.authorization.authorize({ operation: { enforceAbac: { enforce } }, input: input() } as never)).toEqual({ allowed: true })
    expect(enforce).not.toHaveBeenCalled()
  })

  it("runs the after-commit hook with the committed record, or the identity when the row is unreadable", async () => {
    const afterCommit = vi.fn(async () => undefined)
    const { capture, context, persistence } = await ready({ crud: { create: { afterCommit } } })
    const operation = { ...mutationOperation(context, persistence), metadata: { requestId: "meta-req" }, correlationId: "corr-9" }
    await capture.definition.afterCommit?.({ operation, input: input({ name: "n" }), result: { record: { id: "w1", name: "n" } } } as never)
    expect(afterCommit).toHaveBeenLastCalledWith({
      input: { name: "n" },
      result: { id: "w1", name: "n" },
      operation,
      context: { tenantId: "tenant-1", requestId: "meta-req", correlationId: "corr-9" },
    })
    await capture.definition.afterCommit?.({ operation, input: input({ name: "n" }), result: { success: true, reason: "CREATED_OUTSIDE_READ_SCOPE" } } as never)
    expect(afterCommit).toHaveBeenLastCalledWith(expect.objectContaining({ result: { id: "w1" } }))

    const keyed = await ready({ entity: widgetEntity({ primaryKey: "name" }), crud: { create: { afterCommit } } })
    await keyed.capture.definition.afterCommit?.({ operation, input: input(), result: { success: true } } as never)
    expect(afterCommit).toHaveBeenLastCalledWith(expect.objectContaining({ result: { name: "w1" } }))
  })
})

describe("create audit definition", () => {
  it("describes the created resource with the configured audit options", () => {
    const fieldClassification = { name: "pii" } as never
    const capture = build(baseOptions({ audit: { enabled: true, resource: "Widget", fieldClassification, required: false, auditGuarantee: "atomic", requiredStateSemantics: "committed-state" } }))
    const audit = capture.definition.audit
    expect(audit?.action).toBe("Widget.created")
    expect(audit?.resourceType).toBe("Widget")
    expect(audit?.fieldClassification).toBe(fieldClassification)
    expect(audit?.required).toBe(false)
    expect(audit?.auditGuarantee).toBe("atomic")
    expect(audit?.requiredStateSemantics).toBe("committed-state")
    expect(audit?.resolveResourceId({ input: { id: "w7" } } as never)).toBe("w7")
    expect("extractNewValue" in (audit ?? {})).toBe(false)
  })

  it("falls back to the entity name and omits unset options", () => {
    const capture = build(baseOptions({ audit: { enabled: true } }))
    const audit = capture.definition.audit
    expect(audit?.action).toBe("widget.created")
    expect(audit?.resourceType).toBe("widget")
    for (const key of ["fieldClassification", "required", "auditGuarantee", "requiredStateSemantics", "extractNewValue"]) expect(key in (audit ?? {})).toBe(false)
  })

  it("includes the new value only on request, projecting the record", () => {
    const capture = build(baseOptions({ audit: { enabled: true, resource: "Widget", includeValues: true } }))
    const extract = capture.definition.audit?.extractNewValue
    expect(extract?.({ result: { record: { id: "w1", name: "n", ghost: "x" } } } as never)).toEqual({ id: "w1", name: "n" })
    expect(extract?.({ result: { success: true } } as never)).toEqual({})
    const off = build(baseOptions({ audit: { enabled: true, resource: "Widget", includeValues: false } }))
    expect("extractNewValue" in (off.definition.audit ?? {})).toBe(false)
  })
})

describe("create recovery", () => {
  it("rebuilds the committed response from the stored resource identity", async () => {
    const { capture, context } = await ready()
    const recovered = await capture.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1", version: 1 }, context } as never)
    expect(recovered).toEqual({ record: expect.objectContaining({ id: "w1", version: 1 }) })
  })

  it("answers nothing when the committed revision is gone", async () => {
    const { capture, context } = await ready({}, { findMany: vi.fn(async () => rowsOf(row({ version: 5 }))) })
    expect(await capture.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1", version: 1 }, context } as never)).toBeNull()
    const missing = await ready({}, { findMany: vi.fn(async () => rowsOf()) })
    expect(await missing.capture.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1", version: 1 }, context: missing.context } as never)).toBeNull()
  })

  it("reads without a version check when the identity carries none, under the structural scope", async () => {
    const { capture, context } = await ready({}, { findMany: vi.fn(async () => rowsOf(row({ version: 9 }))) })
    expect(await capture.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1" }, context } as never)).toEqual({ record: expect.objectContaining({ version: 9 }) })

    const scopeFilter = Predicate.eq("name", "visible")
    const repo = fakeRepo({ findMany: vi.fn(async () => rowsOf(row({ name: "visible" }))) })
    const persistence = persistenceOf(repo)
    const scoped = build(baseOptions({ entity: unscopedEntity(), entityScope: { kind: "platform", scopeFilter }, scope: { scope: "platform" }, createPersistence: () => persistence }))
    await scoped.recoverCommittedResponse({ resource: { entity: MODULE_KEY, id: "w1" }, context: await contextFor("platform", "create") } as never)
    const filter = repo.findMany.mock.calls[0]?.[0].filter as PredicateNode
    expect(evaluatePredicate({ id: "w1", name: "hidden" }, filter)).toBe(false)
  })
})
