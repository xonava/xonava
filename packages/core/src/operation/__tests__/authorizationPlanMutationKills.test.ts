import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, ConflictError, ForbiddenError, Predicate, encodeExecutionScopeId } from "../../domain"
import type { PersistenceProvider } from "../../persistence"
import { createAuthorizedExecutionPlan } from "../../security"
import type { PredicateNode } from "../../domain/predicate"
import { createOperationContext, type AuthorizationOperationContext } from "../operationContext"
import {
  MIN_MASKING_KEY_BYTES,
  MIN_PARTIAL_MASK_LENGTH,
  applyAuthorizationPlanToResult,
  assertAtomicBatchPlanSupported,
  authorizeOperation,
  createPlanConstrainedPersistenceProvider,
  revalidateAuthorizationFacts,
} from "../authorizationPlanEnforcement"

const authenticated = { kind: "authenticated", method: "session", authenticatedAt: "2026-09-10T00:00:00.000Z" } as const
const human = { id: "user-1", kind: "human", authentication: authenticated } as const
const scope = { kind: "tenant", tenantId: "tenant-1" } as const
const capabilities = {
  interactiveTransactions: false, atomicBatch: false, returningInsert: false, readSessions: false,
  jsonQueries: false, exactDecimal: false, persistentConnection: false, maxPageSize: 100,
  maxBindParams: 100, maxStatementBytes: 100_000,
} as const

function makeRequest(actor: unknown = human, subject: unknown = human): never {
  return {
    requestId: "request-1", correlationId: "correlation-1",
    identity: { actor, subject }, scope, scopeId: encodeExecutionScopeId(scope),
    signal: new AbortController().signal,
  } as never
}

function plan(overrides: Record<string, unknown> = {}) {
  return createAuthorizedExecutionPlan({
    identity: { actor: human, subject: human }, scope, action: "records.read", operationKind: "read",
    readableFields: new Set(["id", "tenantId", "secret", "status"]), writableFields: new Set(["status"]),
    obligations: [], dynamicFacts: [], policy: { key: "policy", version: 1, digest: "a".repeat(64) },
    ...overrides,
  } as never)
}

function operationWith(request: never = makeRequest()): AuthorizationOperationContext {
  return { ...createOperationContext({
    persistence: { dialect: "test", capabilities, repository: () => { throw new Error("unused") } },
    runtimeCapabilities: { deferredExecution: false, cache: false }, request,
    clock: { now: () => new Date("2026-09-10T00:01:00.000Z") },
  }), operationId: "operation-1", signal: new AbortController().signal } as unknown as AuthorizationOperationContext
}

function definition(decision: unknown, extra: Record<string, unknown> = {}): never {
  return { key: "op", kind: "read", authorization: { authorize: async () => decision }, ...extra } as never
}

function run(decision: unknown, extra: Record<string, unknown> = {}, operation = operationWith()) {
  return authorizeOperation({ operation, definition: definition(decision, extra), input: {} })
}

describe("authorization decision validation", () => {
  it("rejects authorizers that are null or lack an authorize function", async () => {
    await expect(authorizeOperation({ operation: operationWith(), definition: { key: "op", kind: "read", authorization: null } as never, input: {} }))
      .rejects.toThrow("Operation op authorization is invalid.")
    await expect(authorizeOperation({ operation: operationWith(), definition: { key: "op", kind: "read", authorization: { authorize: 1 } } as never, input: {} }))
      .rejects.toThrow("Operation op authorization is invalid.")
  })

  it("requires an explicit object decision", async () => {
    await expect(run(undefined)).rejects.toThrow("Operation op authorization must return an explicit decision.")
    await expect(run([])).rejects.toThrow("Operation op authorization must return an explicit decision.")
  })

  it("requires allowed to be an own boolean data property", async () => {
    await expect(run({ allowed: "yes" })).rejects.toThrow("Operation op authorization decision.allowed must be boolean.")
    await expect(run(Object.create({ allowed: true }))).rejects.toThrow("Operation op authorization decision.allowed must be boolean.")
  })

  it("requires reason to be a string when present", async () => {
    await expect(run({ allowed: true, reason: 5 })).rejects.toThrow("Operation op authorization decision.reason must be a string.")
    await expect(run({ allowed: false, reason: 5 })).rejects.toThrow("Operation op authorization decision.reason must be a string.")
  })

  it("treats an explicit undefined reason as absent on an allowed decision", async () => {
    await expect(run({ allowed: true, reason: undefined })).resolves.toBeUndefined()
  })

  it("uses the supplied reason or the default message for denials", async () => {
    await expect(run({ allowed: false, reason: "blocked" })).rejects.toThrow(new ForbiddenError("blocked"))
    await expect(run({ allowed: false })).rejects.toThrow(
      new ForbiddenError("Operation is not allowed: op. Operation op is not allowed."),
    )
  })

  it("rejects a plan that is not a framework authorization plan", async () => {
    await expect(run({ allowed: true, plan: { operationKind: "read" } })).rejects.toThrow(
      "Operation op authorization decision.plan must be a framework authorization plan.",
    )
  })

  it("rejects an execution plan attached to a denial", async () => {
    await expect(run({ allowed: false, plan: plan() })).rejects.toThrow(
      "Operation op denied authorization cannot include an execution plan.",
    )
  })

  it("requires decision fields to be own data properties", async () => {
    const inheritedPlan = Object.create({ plan: plan() })
    inheritedPlan.allowed = true
    await expect(run(inheritedPlan)).rejects.toThrow("Operation op authorization decision must use own data properties.")
    const inheritedReason = Object.create({ reason: "x" })
    inheritedReason.allowed = true
    await expect(run(inheritedReason)).rejects.toThrow("Operation op authorization decision must use own data properties.")
  })

  it("returns undefined for an allowed decision without a plan and the plan otherwise", async () => {
    await expect(run({ allowed: true })).resolves.toBeUndefined()
    await expect(run({ allowed: true, plan: plan() })).resolves.toMatchObject({ operationKind: "read", action: "records.read" })
  })

  it("rejects plans whose scope or identity does not match the verified request", async () => {
    const otherScope = { kind: "tenant", tenantId: "tenant-2" } as const
    await expect(run({ allowed: true, plan: plan({ scope: otherScope }) })).rejects.toThrow(
      "Authorization plan identity or scope does not match operation op.",
    )
    const otherActor = { id: "user-2", kind: "human", authentication: authenticated } as const
    await expect(run({ allowed: true, plan: plan({ identity: { actor: otherActor, subject: human } }) }, {}, operationWith(makeRequest()))).rejects.toThrow(ForbiddenError)
    const serviceActor = { id: "user-1", kind: "service", authentication: authenticated } as const
    await expect(run({ allowed: true, plan: plan() }, {}, operationWith(makeRequest(serviceActor, human)))).rejects.toThrow(ForbiddenError)
    const otherSubject = { id: "user-3", kind: "human", authentication: authenticated } as const
    await expect(run({ allowed: true, plan: plan() }, {}, operationWith(makeRequest(human, otherSubject)))).rejects.toThrow(ForbiddenError)
    const subjectKind = { id: "user-1", kind: "service", authentication: authenticated } as const
    await expect(run({ allowed: true, plan: plan() }, {}, operationWith(makeRequest(human, subjectKind)))).rejects.toThrow(ForbiddenError)
  })
})

describe("authorization obligations", () => {
  it("enforces audit obligations only when the definition declares the same action", async () => {
    const auditPlan = plan({ obligations: [{ kind: "audit", action: "records.read" }] })
    await expect(run({ allowed: true, plan: auditPlan })).rejects.toThrow(
      "Authorization plan audit obligation is not enforced by operation op.",
    )
    await expect(run({ allowed: true, plan: auditPlan }, { audit: { action: "records.read", required: false } })).rejects.toThrow(
      "Authorization plan audit obligation is not enforced by operation op.",
    )
    await expect(run({ allowed: true, plan: auditPlan }, { audit: { action: "records.write" } })).rejects.toThrow(
      "Authorization plan audit obligation is not enforced by operation op.",
    )
    await expect(run({ allowed: true, plan: auditPlan }, { audit: { action: "records.read" } })).resolves.toMatchObject({ operationKind: "read" })
    await expect(run({ allowed: true, plan: auditPlan }, { audit: { action: "records.read", required: true } })).resolves.toMatchObject({ operationKind: "read" })
  })

  it("requires an authenticated actor for step-up obligations", async () => {
    const anonymous = { id: "anon-1", kind: "anonymous", authentication: { kind: "anonymous" } } as const
    const anonymousPlan = plan({
      identity: { actor: anonymous, subject: anonymous },
      obligations: [{ kind: "step-up", requirement: "mfa" }],
    })
    await expect(run({ allowed: true, plan: anonymousPlan }, {}, operationWith(makeRequest(anonymous, anonymous)))).rejects.toThrow(
      new ForbiddenError("Authorization plan step-up obligation is not satisfied for operation op."),
    )
  })

  it("enforces the mfa requirement by assurance level", async () => {
    const mfaHuman = { ...human, authentication: { ...authenticated, assuranceLevel: "mfa" } } as const
    const passwordHuman = { ...human, authentication: { ...authenticated, assuranceLevel: "password" } } as const
    const mfaPlan = plan({ identity: { actor: mfaHuman, subject: mfaHuman }, obligations: [{ kind: "step-up", requirement: "mfa" }] })
    await expect(run({ allowed: true, plan: mfaPlan }, {}, operationWith(makeRequest(mfaHuman, mfaHuman)))).resolves.toMatchObject({ operationKind: "read" })
    await expect(run({ allowed: true, plan: mfaPlan }, {}, operationWith(makeRequest(passwordHuman, passwordHuman)))).rejects.toThrow(
      new ForbiddenError("Authorization plan MFA obligation is not satisfied for operation op."),
    )
    await expect(run({ allowed: true, plan: mfaPlan }, {}, operationWith(makeRequest(human, human)))).rejects.toThrow(/MFA obligation/)
  })

  it("requires a maxAgeSeconds value for recent-authentication obligations", async () => {
    const recentPlan = plan({ obligations: [{ kind: "step-up", requirement: "recent-authentication" }] })
    await expect(run({ allowed: true, plan: recentPlan })).rejects.toThrow(
      "Recent-authentication obligations require a positive maxAgeSeconds.",
    )
  })

  it("accepts recent authentication only within the inclusive age window", async () => {
    const withinWindow = plan({ obligations: [{ kind: "step-up", requirement: "recent-authentication", maxAgeSeconds: 60 }] })
    // Clock is 60 seconds after authentication: exactly at the limit is still permitted.
    await expect(run({ allowed: true, plan: withinWindow })).resolves.toMatchObject({ operationKind: "read" })
    const tooOld = plan({ obligations: [{ kind: "step-up", requirement: "recent-authentication", maxAgeSeconds: 59 }] })
    await expect(run({ allowed: true, plan: tooOld })).rejects.toThrow(
      new ForbiddenError("Authorization plan recent-authentication obligation is not satisfied for operation op."),
    )
  })

  it("rejects future-dated and unparseable authentication instants", async () => {
    const recentPlan = plan({ obligations: [{ kind: "step-up", requirement: "recent-authentication", maxAgeSeconds: 600 }] })
    const future = { ...human, authentication: { ...authenticated, authenticatedAt: "2026-09-10T00:02:00.000Z" } } as const
    await expect(run({ allowed: true, plan: recentPlan }, {}, operationWith(makeRequest(future, future)))).rejects.toThrow(ForbiddenError)
    const unparseable = { ...human, authentication: { ...authenticated, authenticatedAt: "not-a-date" } } as const
    await expect(run({ allowed: true, plan: recentPlan }, {}, operationWith(makeRequest(unparseable, unparseable)))).rejects.toThrow(ForbiddenError)
  })
})

describe("atomic-batch plan support", () => {
  it("names the operation in the rejection", () => {
    expect(() => assertAtomicBatchPlanSupported(plan({ operationKind: "mutation", dynamicFacts: [] }) as never, "batch-op")).toThrow(
      "Atomic-batch operation batch-op cannot execute a mutation authorization plan without an adapter-bound command plan.",
    )
    expect(() => assertAtomicBatchPlanSupported(undefined, "batch-op")).not.toThrow()
  })
})

const mandatory = Predicate.eq("tenantId", "tenant-1")

function mutationRepository(overrides: Record<string, unknown> = {}) {
  return {
    findById: vi.fn(async () => ({ id: "2", tenantId: "tenant-2", status: "old" })),
    findOneWhere: vi.fn(async () => ({ id: "1", tenantId: "tenant-1", status: "old" })),
    findMany: vi.fn(async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 })),
    insert: vi.fn(async (data: object) => ({ id: "1", ...data })),
    update: vi.fn(async (_id: string, data: object) => ({ id: "1", ...data })),
    delete: vi.fn(async () => undefined),
    updateOneWhere: vi.fn(async () => ({ updatedCount: 1 })),
    updateOneWhereReturning: vi.fn(async () => ({ id: "1", tenantId: "tenant-1", status: "new" })),
    updateManyWhere: vi.fn(async () => 3),
    deleteWhere: vi.fn(async () => ({ deletedCount: 2 })),
    ...overrides,
  }
}

type ConstrainedRepository = {
  findById(id: string): Promise<unknown>
  findOneWhere?: (filter: PredicateNode) => Promise<unknown>
  findMany(options?: unknown): Promise<unknown>
  insert(data: unknown): Promise<unknown>
  bulkInsert?: (data: unknown[]) => Promise<unknown>
  update(id: string, data: unknown, options?: unknown): Promise<unknown>
  delete(id: string, options?: unknown): unknown
  updateOneWhere?: (filter: PredicateNode, data: unknown, options?: unknown) => Promise<unknown>
  updateOneWhereReturning?: (filter: PredicateNode, data: unknown, options?: unknown) => Promise<unknown>
  updateManyWhere?: (filter: PredicateNode, data: unknown, options?: unknown) => Promise<unknown>
  deleteWhere?: (filter: PredicateNode, options?: unknown) => Promise<unknown>
}

function constrain(repository: object, authorizationPlan: ReturnType<typeof plan>): ConstrainedRepository {
  return createPlanConstrainedPersistenceProvider(
    { dialect: "test", capabilities, repository: () => repository } as unknown as PersistenceProvider,
    authorizationPlan,
  ).repository({ name: "records", fields: {} } as never) as unknown as ConstrainedRepository
}

const mutationPlan = (overrides: Record<string, unknown> = {}) =>
  plan({ operationKind: "mutation", mandatoryResourcePredicate: mandatory, writableFields: new Set(["status", "tenantId"]), ...overrides })

describe("constrained persistence reads", () => {
  it("omits predicate-bearing read methods the underlying repository does not provide", () => {
    const withoutOneWhere = { findById: vi.fn(), findMany: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() }
    const constrained = constrain(withoutOneWhere, plan())
    expect("findOneWhere" in constrained).toBe(false)
    expect("insert" in constrained).toBe(false)
  })

  it("adds the mandatory predicate to findOneWhere and drops foreign rows", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, plan({ mandatoryResourcePredicate: mandatory }))
    await expect(constrained.findOneWhere!(Predicate.eq("id", "1"))).resolves.toMatchObject({ id: "1", tenantId: "tenant-1" })
    expect(repository.findOneWhere).toHaveBeenCalledWith(Predicate.and(Predicate.eq("id", "1"), mandatory))
    repository.findOneWhere.mockResolvedValueOnce({ id: "9", tenantId: "tenant-2" } as never)
    await expect(constrained.findOneWhere!(Predicate.eq("id", "9"))).resolves.toBeNull()
  })

  it("constrains findById only when a predicate is present", async () => {
    const repository = mutationRepository()
    const unconstrained = constrain(repository, plan())
    await expect(unconstrained.findById("2")).resolves.toMatchObject({ tenantId: "tenant-2" })
    const constrained = constrain(repository, plan({ mandatoryResourcePredicate: mandatory }))
    await expect(constrained.findById("2")).resolves.toBeNull()
    await expect(constrained.findById("1")).resolves.toBeNull()
  })

  it("passes read options through untouched when no predicate applies", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, plan())
    const options = { page: 2, pageSize: 5 }
    await constrained.findMany(options)
    expect((repository.findMany.mock.calls as unknown[][])[0]?.[0]).toBe(options)
    await constrained.findMany()
    expect(repository.findMany).toHaveBeenLastCalledWith(undefined)
  })

  it("merges the mandatory predicate into list filters and keeps envelope fields", async () => {
    const repository = mutationRepository({
      findMany: vi.fn(async () => ({
        rows: [
          { id: "1", tenantId: "tenant-1" },
          { id: "2", tenantId: "tenant-2" },
          { id: "3" },
          null,
        ],
        rowCount: 4, page: 3, pageSize: 10,
      })),
    })
    const constrained = constrain(repository, plan({ mandatoryResourcePredicate: mandatory }))
    const result = await constrained.findMany({ page: 3, filter: Predicate.eq("status", "open") }) as {
      rows: unknown[]; rowCount: number; page: number; pageSize: number
    }
    expect(repository.findMany).toHaveBeenCalledWith({ page: 3, filter: Predicate.and(Predicate.eq("status", "open"), mandatory) })
    expect(result.rows).toEqual([{ id: "1", tenantId: "tenant-1" }, { id: "3" }])
    expect(result).toMatchObject({ rowCount: 2, page: 3, pageSize: 10 })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.rows)).toBe(true)
  })

  it("requires dynamic mutation-predicate facts to constrain reads of mutation plans", async () => {
    const repository = mutationRepository()
    const dynamicPlan = mutationPlan({
      mandatoryResourcePredicate: undefined,
      dynamicFacts: [{
        factKey: "status-guard", version: "1", observedAt: "2026-09-10T00:00:00.000Z",
        revalidation: { kind: "mutation-predicate", field: "status", expectedValue: "open" },
      }],
    })
    const constrained = constrain(repository, dynamicPlan)
    await constrained.findMany()
    expect(repository.findMany).toHaveBeenCalledWith({ filter: Predicate.eq("status", "open") })
  })

  it("combines mandatory and dynamic predicates into one conjunction", async () => {
    const repository = mutationRepository()
    const dynamicPlan = mutationPlan({
      dynamicFacts: [{
        factKey: "status-guard", version: "1", observedAt: "2026-09-10T00:00:00.000Z",
        revalidation: { kind: "mutation-predicate", field: "status", expectedValue: "open" },
      }],
    })
    await constrain(repository, dynamicPlan).findMany()
    expect(repository.findMany).toHaveBeenCalledWith({ filter: Predicate.and(mandatory, Predicate.eq("status", "open")) })
  })
})

describe("constrained persistence writes", () => {
  it("requires writes to use a data object and only writable fields", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, mutationPlan({ writableFields: new Set(["status"]) }))
    await expect(constrained.insert(["x"])).rejects.toThrow("Authorized repository writes must use a data object.")
    await expect(constrained.insert({ status: "x", secret: 1 })).rejects.toThrow(
      new ForbiddenError('Authorization plan does not permit writes to field "secret".'),
    )
    await expect(constrained.update("1", { secret: 1 })).rejects.toThrow('Authorization plan does not permit writes to field "secret".')
  })

  it("inserts without predicate checks when the plan has no predicate", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, mutationPlan({ mandatoryResourcePredicate: undefined }))
    await expect(constrained.insert({ status: "x" })).resolves.toMatchObject({ status: "x" })
    expect(repository.insert).toHaveBeenCalledWith({ status: "x" })
  })

  it("accepts an insert whose persisted row still satisfies the predicate", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, mutationPlan())
    await expect(constrained.insert({ tenantId: "tenant-1", status: "x" })).resolves.toMatchObject({ tenantId: "tenant-1" })
  })

  it("applies the same checks to bulk inserts when the repository supports them", async () => {
    const repository = mutationRepository({
      bulkInsert: vi.fn(async (data: object[]) => data.map((entry) => ({ id: "1", ...entry }))),
    })
    const constrained = constrain(repository, mutationPlan())
    await expect(constrained.bulkInsert!([{ tenantId: "tenant-1", status: "a" }])).resolves.toEqual([
      { id: "1", tenantId: "tenant-1", status: "a" },
    ])
    await expect(constrained.bulkInsert!([{ tenantId: "tenant-2", status: "a" }])).rejects.toThrow(
      new ForbiddenError("Authorization plan resource predicate does not permit this insert."),
    )
    expect("bulkInsert" in constrain(mutationRepository(), mutationPlan())).toBe(false)
  })

  it("permits direct updates and deletes only when no predicate applies", async () => {
    const repository = mutationRepository()
    const open = constrain(repository, mutationPlan({ mandatoryResourcePredicate: undefined }))
    await expect(open.update("1", { status: "x" })).resolves.toMatchObject({ status: "x" })
    expect(repository.update).toHaveBeenCalledWith("1", { status: "x" }, undefined)
    await expect(open.delete("1")).resolves.toBeUndefined()
    expect(repository.delete).toHaveBeenCalledWith("1", undefined)
    const guarded = constrain(repository, mutationPlan())
    expect(() => guarded.delete("1")).toThrow(ConfigurationError)
  })

  it("rewrites conditional updates with the mandatory predicate and the post-image", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, mutationPlan())
    await constrained.updateOneWhere!(Predicate.eq("id", "1"), { status: "open" })
    expect(repository.updateOneWhere).toHaveBeenCalledWith(
      Predicate.and(Predicate.and(Predicate.eq("id", "1"), mandatory), mandatory),
      { status: "open" },
      undefined,
    )
  })

  it("rejects a conditional update whose written tenant leaves the mandatory predicate", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, mutationPlan())
    await expect(constrained.updateOneWhere!(Predicate.eq("id", "1"), { tenantId: "tenant-2" })).rejects.toThrow(
      new ForbiddenError("Authorization plan resource predicate does not permit this update."),
    )
    expect(repository.updateOneWhere).not.toHaveBeenCalled()
  })

  it("rejects a written NULL that makes a mandatory condition unknown", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, mutationPlan({ mandatoryResourcePredicate: Predicate.eq("status", "open") }))
    await expect(constrained.updateOneWhere!(Predicate.eq("id", "1"), { status: null })).rejects.toThrow(
      "Authorization plan resource predicate does not permit this update.",
    )
  })

  it("strips undefined patch values before writing and before deciding the post-image", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, mutationPlan({ mandatoryResourcePredicate: Predicate.eq("status", "open") }))
    await constrained.updateOneWhere!(Predicate.eq("id", "1"), { status: undefined })
    const [filter, patch] = (repository.updateOneWhere.mock.calls as unknown[][])[0] as unknown as [unknown, Record<string, unknown>]
    expect(Object.keys(patch)).toEqual([])
    expect(filter).toEqual(Predicate.and(Predicate.and(Predicate.eq("id", "1"), Predicate.eq("status", "open")), Predicate.eq("status", "open")))
  })

  it("derives the post-image filter for every AND, OR and NOT shape", async () => {
    const filterFor = async (predicate: unknown, data: Record<string, unknown>) => {
      const repository = mutationRepository()
      const constrained = constrain(repository, mutationPlan({ mandatoryResourcePredicate: predicate }))
      await constrained.updateOneWhere!(Predicate.eq("id", "1"), data)
      return (repository.updateOneWhere.mock.calls as unknown[][])[0]?.[0]
    }
    const base = (predicate: unknown) => Predicate.and(Predicate.eq("id", "1"), predicate as never)

    // A decisive true disjunct makes the whole residual true, so no extra filter is added.
    expect(await filterFor(Predicate.or(Predicate.eq("status", "open"), Predicate.eq("tenantId", "tenant-1")), { status: "open" }))
      .toEqual(base(Predicate.or(Predicate.eq("status", "open"), Predicate.eq("tenantId", "tenant-1"))))

    // A false disjunct is dropped; the unwritten disjunct remains as the residual.
    expect(await filterFor(Predicate.or(Predicate.eq("status", "open"), Predicate.eq("tenantId", "tenant-1")), { status: "closed" }))
      .toEqual(Predicate.and(base(Predicate.or(Predicate.eq("status", "open"), Predicate.eq("tenantId", "tenant-1"))), Predicate.eq("tenantId", "tenant-1")))

    // Several unwritten conjuncts stay conjoined.
    const twoLeft = Predicate.and(Predicate.eq("tenantId", "tenant-1"), Predicate.eq("region", "eu"))
    expect(await filterFor(twoLeft, { status: "x" })).toEqual(Predicate.and(base(twoLeft), twoLeft))

    // A written value that fully satisfies an AND leaves no residual.
    expect(await filterFor(Predicate.and(Predicate.eq("status", "open")), { status: "open" })).toEqual(base(Predicate.and(Predicate.eq("status", "open"))))

    // NOT over a written, false condition is true and needs no residual.
    expect(await filterFor(Predicate.not(Predicate.eq("status", "open")), { status: "closed" })).toEqual(base(Predicate.not(Predicate.eq("status", "open"))))
    // NOT over an unwritten condition keeps the negation as the residual.
    expect(await filterFor(Predicate.not(Predicate.eq("tenantId", "tenant-1")), { status: "x" }))
      .toEqual(Predicate.and(base(Predicate.not(Predicate.eq("tenantId", "tenant-1"))), Predicate.not(Predicate.eq("tenantId", "tenant-1"))))
    // NOT over a written, true condition is false, so the update is forbidden.
    await expect(filterFor(Predicate.not(Predicate.eq("status", "open")), { status: "open" })).rejects.toThrow(ForbiddenError)
    await expect(filterFor(Predicate.literal(false), { status: "x" })).rejects.toThrow(ForbiddenError)
    await expect(filterFor(Predicate.literal(true), { status: "x" })).resolves.toEqual(base(Predicate.literal(true)))
    await expect(filterFor({ kind: "unsupported" }, { status: "x" })).rejects.toThrow(
      "Authorization plan resource predicate does not permit this update.",
    )
  })

  it("applies the same post-image rule to updateOneWhereReturning and updateManyWhere", async () => {
    const repository = mutationRepository()
    const constrained = constrain(repository, mutationPlan())
    await expect(constrained.updateOneWhereReturning!(Predicate.eq("id", "1"), { status: "new" })).resolves.toMatchObject({ tenantId: "tenant-1" })
    expect(repository.updateOneWhereReturning).toHaveBeenCalledWith(
      Predicate.and(Predicate.and(Predicate.eq("id", "1"), mandatory), mandatory),
      { status: "new" },
      undefined,
    )
    await expect(constrained.updateManyWhere!(Predicate.eq("id", "1"), { status: "new" })).resolves.toBe(3)
    expect(repository.updateManyWhere).toHaveBeenCalledWith(
      Predicate.and(Predicate.and(Predicate.eq("id", "1"), mandatory), mandatory),
      { status: "new" },
      undefined,
    )
  })

  it("returns null from updateOneWhereReturning when the returned row is outside the predicate", async () => {
    const repository = mutationRepository({
      updateOneWhereReturning: vi.fn(async () => ({ id: "1", tenantId: "tenant-2", status: "new" })),
    })
    await expect(constrain(repository, mutationPlan()).updateOneWhereReturning!(Predicate.eq("id", "1"), { status: "new" })).resolves.toBeNull()
    const empty = mutationRepository({ updateOneWhereReturning: vi.fn(async () => null) })
    await expect(constrain(empty, mutationPlan()).updateOneWhereReturning!(Predicate.eq("id", "1"), { status: "new" })).resolves.toBeNull()
  })

  it("conjoins the mandatory predicate into deletes and leaves unguarded deletes unchanged", async () => {
    const repository = mutationRepository()
    await constrain(repository, mutationPlan()).deleteWhere!(Predicate.eq("id", "1"))
    expect(repository.deleteWhere).toHaveBeenCalledWith(Predicate.and(Predicate.eq("id", "1"), mandatory), undefined)
    const filter = Predicate.eq("id", "1")
    await constrain(repository, mutationPlan({ mandatoryResourcePredicate: undefined })).deleteWhere!(filter)
    expect((repository.deleteWhere.mock.calls as unknown[][])[1]?.[0]).toBe(filter)
  })

  it("omits conditional mutation methods the repository does not provide", () => {
    const constrained = constrain({ insert: vi.fn(), update: vi.fn(), delete: vi.fn(), findMany: vi.fn(), findById: vi.fn() }, mutationPlan())
    expect("updateOneWhere" in constrained).toBe(false)
    expect("updateOneWhereReturning" in constrained).toBe(false)
    expect("updateManyWhere" in constrained).toBe(false)
    expect("deleteWhere" in constrained).toBe(false)
  })
})

describe("commit-time fact revalidation", () => {
  it("skips plans without facts and read plans", async () => {
    const runContext = { persistence: {}, operationId: "operation-1", signal: new AbortController().signal } as never
    await expect(revalidateAuthorizationFacts({ plan: plan(), operation: runContext })).resolves.toBeUndefined()
    const mutationWithoutFacts = plan({ operationKind: "mutation" })
    await expect(revalidateAuthorizationFacts({ plan: mutationWithoutFacts, operation: runContext })).resolves.toBeUndefined()
  })

  it("does not require a revalidator for pre-image predicate facts", async () => {
    const runContext = { persistence: {}, operationId: "operation-1", signal: new AbortController().signal } as never
    const predicatePlan = plan({
      operationKind: "mutation",
      dynamicFacts: [{
        factKey: "status-guard", version: "1", observedAt: "2026-09-10T00:00:00.000Z",
        revalidation: { kind: "mutation-predicate", field: "status", expectedValue: "open" },
      }],
    })
    await expect(revalidateAuthorizationFacts({ plan: predicatePlan, operation: runContext })).resolves.toBeUndefined()
  })

  it("passes the commit context to the revalidator and names the failing fact", async () => {
    const persistence = { tag: "tx" }
    const signal = new AbortController().signal
    const runContext = { persistence, operationId: "operation-9", signal } as never
    const factPlan = plan({
      operationKind: "mutation",
      dynamicFacts: [{
        factKey: "membership", version: "1", observedAt: "2026-09-10T00:00:00.000Z",
        revalidation: { kind: "transaction-check", checkKey: "membership" },
      }],
    })
    const revalidate = vi.fn(async () => true)
    await revalidateAuthorizationFacts({ plan: factPlan, operation: runContext, revalidator: { revalidate } as never })
    expect(revalidate).toHaveBeenCalledWith(expect.objectContaining({
      plan: factPlan, persistence, operationId: "operation-9", signal,
      fact: expect.objectContaining({ factKey: "membership" }),
    }))
    const stale = { revalidate: async () => false }
    await expect(revalidateAuthorizationFacts({ plan: factPlan, operation: runContext, revalidator: stale as never })).rejects.toThrow(
      new ConflictError('Authorization fact "membership" changed before mutation commit.'),
    )
  })
})

describe("masking and projection", () => {
  it("exposes the masking key and partial-mask length minimums", () => {
    expect(MIN_MASKING_KEY_BYTES).toBe(16)
    expect(MIN_PARTIAL_MASK_LENGTH).toBe(8)
  })

  it("validates the masking key only when a plan applies", () => {
    const hash = plan({ obligations: [{ kind: "mask", field: "secret", strategy: "hash" }] })
    expect(applyAuthorizationPlanToResult(undefined, { id: "1" }, { maskingKey: new Uint8Array(1) })).toEqual({ id: "1" })
    expect(() => applyAuthorizationPlanToResult(hash, { id: "1" }, { maskingKey: new Uint8Array(15) })).toThrow(
      "Masking key must be at least 16 bytes",
    )
    expect(() => applyAuthorizationPlanToResult(hash, { id: "1" }, { maskingKey: "not-bytes" as never })).toThrow(ConfigurationError)
  })

  it("keeps only readable fields that are present, and leaves dates and scalars untouched", () => {
    const readPlan = plan()
    const date = new Date("2026-09-10T00:00:00.000Z")
    expect(applyAuthorizationPlanToResult(readPlan, { id: "1", status: "open", hidden: true, when: date })).toEqual({ id: "1", status: "open" })
    const datedPlan = plan({ readableFields: new Set(["id", "when"]) })
    const projected = applyAuthorizationPlanToResult(datedPlan, { id: "1", when: date }) as { when: unknown }
    expect(projected.when).toBe(date)
    expect(applyAuthorizationPlanToResult(readPlan, "scalar")).toBe("scalar")
    expect(applyAuthorizationPlanToResult(readPlan, [[{ id: "1", hidden: 1 }]])).toEqual([[{ id: "1" }]])
  })

  it("preserves null and undefined values when masking", () => {
    const redact = plan({ obligations: [{ kind: "mask", field: "secret", strategy: "redact" }] })
    expect(applyAuthorizationPlanToResult(redact, { id: "1", secret: null })).toEqual({ id: "1", secret: null })
    expect(applyAuthorizationPlanToResult(redact, { id: "1", secret: undefined })).toEqual({ id: "1", secret: undefined })
    expect(applyAuthorizationPlanToResult(redact, { id: "1", secret: "value" })).toEqual({ id: "1", secret: "[REDACTED]" })
  })

  it("applies only the first mask obligation declared for a field", () => {
    const duplicate = plan({ obligations: [
      { kind: "mask", field: "secret", strategy: "redact" },
      { kind: "mask", field: "secret", strategy: "partial" },
    ] })
    expect(applyAuthorizationPlanToResult(duplicate, { id: "1", secret: "4111111111111111" })).toEqual({ id: "1", secret: "[REDACTED]" })
  })

  it("partially masks only long strings, keeping the last four characters", () => {
    const partial = plan({ obligations: [{ kind: "mask", field: "secret", strategy: "partial" }] })
    expect(applyAuthorizationPlanToResult(partial, { id: "1", secret: "abcdefgh" })).toEqual({ id: "1", secret: "****efgh" })
    expect(applyAuthorizationPlanToResult(partial, { id: "1", secret: "abcdefg" })).toEqual({ id: "1", secret: "[REDACTED]" })
    expect(applyAuthorizationPlanToResult(partial, { id: "1", secret: 12345678 })).toEqual({ id: "1", secret: "[REDACTED]" })
    // Characters, not UTF-16 code units, decide the length.
    expect(applyAuthorizationPlanToResult(partial, { id: "1", secret: "😀😀😀😀😀😀😀😀" })).toEqual({ id: "1", secret: "****😀😀😀😀" })
  })

  it("redacts hash masks without a key and keys them with a key", () => {
    const hash = plan({ obligations: [{ kind: "mask", field: "secret", strategy: "hash" }] })
    const key = new TextEncoder().encode("0123456789abcdef-key")
    expect(applyAuthorizationPlanToResult(hash, { id: "1", secret: "value" })).toEqual({ id: "1", secret: "[REDACTED]" })
    const keyed = applyAuthorizationPlanToResult(hash, { id: "1", secret: "value" }, { maskingKey: key }) as { secret: string }
    expect(keyed.secret).toMatch(/^hmac-sha256:[0-9a-f]{64}$/)
  })

  it("projects only the page envelope of list results and recomputes rowCount", () => {
    const readPlan = plan()
    const result = applyAuthorizationPlanToResult(readPlan, {
      rows: [{ id: "1", hidden: true }, { id: "2" }],
      rowCount: 99, page: 2, pageSize: 2, pageInfo: { next: null }, debug: { secret: "leak" },
    }) as Record<string, unknown>
    expect(result).toEqual({ rows: [{ id: "1" }, { id: "2" }], rowCount: 2, page: 2, pageSize: 2, pageInfo: { next: null } })
    expect(Object.isFrozen(result)).toBe(true)
    const withoutEnvelope = applyAuthorizationPlanToResult(readPlan, { rows: [], rowCount: 0 })
    expect(withoutEnvelope).toEqual({ rows: [], rowCount: 0 })
  })
})
