import { describe, expect, expectTypeOf, it } from "vitest"
import { assertRequestBoundToOperation, createAuthorizationOperationContext, createOperationContext, createOperationRunContext, createMutationOperationContext, createPostCommitOperationContext, createPreparationOperationContext, createReadOperationContext, createRepresentationContext } from "../operationContext"
import type { AuthorizationOperationContext, MutationOperationContext, PostCommitContext, PreparationOperationContext, ReadOperationContext, RepresentationContext } from "../operationContext"
import { createReadOnlyPersistenceProvider, createTenantScopedPersistenceProvider, type InteractiveTransactionProvider, type PersistenceCapabilities, type PersistenceProvider, type ReadOnlyRepository, type UnversionedEntityDescriptor, type UnversionedRepository } from "../../persistence"
import type { RuntimeCapabilities } from "../../bootstrap/runtimeCapabilities"

type Row = { id: string; value: string }

const entity: UnversionedEntityDescriptor<Row> = {
  name: "ContextFixture",
  primaryKey: "id",
  fields: { id: { type: "string" }, value: { type: "string" } },
}

function createProvider(): PersistenceProvider {
  const repository: UnversionedRepository<Row> = {
    findById: async () => null,
    findMany: async () => ({ rows: [], rowCount: 0, page: 1, pageSize: 10 }),
    insert: async (data) => ({ id: "1", value: data.value ?? "" }),
    update: async (id, data) => ({ id, value: data.value ?? "" }),
    delete: async () => undefined,
  }
  const capabilities: PersistenceCapabilities = {
    interactiveTransactions: false,
    atomicBatch: false,
    returningInsert: false,
    readSessions: false,
    jsonQueries: false,
    exactDecimal: false,
    persistentConnection: false,
  }
  const provider: PersistenceProvider = { dialect: "fixture", capabilities, repository: <T, TId>() => repository as unknown as UnversionedRepository<T, TId> }
  return provider
}

const runtimeCapabilities: RuntimeCapabilities = { deferredExecution: true, cache: false }

describe("operation context boundaries", () => {
  it("keeps read-only and post-commit context types free of persistence mutation APIs", () => {
    expectTypeOf<ReadOnlyRepository<Row, string>>().not.toHaveProperty("insert")
    expectTypeOf<ReadOnlyRepository<Row, string>>().not.toHaveProperty("update")
    expectTypeOf<ReadOnlyRepository<Row, string>>().not.toHaveProperty("delete")
    expectTypeOf<ReadOperationContext>().toHaveProperty("persistence")
    expectTypeOf<ReadOperationContext["persistence"]>().toHaveProperty("repository")
    expectTypeOf<AuthorizationOperationContext>().not.toHaveProperty("addDurableEffect")
    expectTypeOf<PreparationOperationContext>().not.toHaveProperty("addDurableEffect")
    expectTypeOf<RepresentationContext>().not.toHaveProperty("persistence")
    expectTypeOf<RepresentationContext>().not.toHaveProperty("addDurableEffect")
    expectTypeOf<PostCommitContext>().not.toHaveProperty("persistence")
    expectTypeOf<PostCommitContext>().not.toHaveProperty("addDurableEffect")
    expectTypeOf<MutationOperationContext>().toHaveProperty("addDurableEffect")
  })

  it("physically omits mutation and effect capabilities from attenuated runtime contexts", () => {
    const operation = createOperationRunContext(createOperationContext({ persistence: createProvider(), runtimeCapabilities }))
    const attenuated = [
      createAuthorizationOperationContext(operation),
      createPreparationOperationContext(operation),
      createReadOperationContext(operation),
    ]
    for (const context of attenuated) {
      const repository = context.persistence.repository(entity) as any
      expect(Reflect.get(repository, "insert")).toBeUndefined()
      expect(Reflect.get(repository, "update")).toBeUndefined()
      expect(Reflect.get(repository, "delete")).toBeUndefined()
      expect(Reflect.get(context as any, "requireRuntimeCapability")).toBeUndefined()
      expect(Reflect.get(context as any, "addTransactionalEffect")).toBeUndefined()
      expect(Reflect.get(context as any, "addOutboxRecord")).toBeUndefined()
      expect(Reflect.get(context as any, "addDurableEffect")).toBeUndefined()
      expect(Reflect.get(context as any, "addBestEffortEffect")).toBeUndefined()
      expect(Object.isFrozen(context)).toBe(true)
    }

    const postCommit = createPostCommitOperationContext(operation)
    expect(Reflect.get(postCommit, "persistence")).toBeUndefined()
    expect(Reflect.get(postCommit, "addDurableEffect")).toBeUndefined()

    const representation = createRepresentationContext(operation)
    expect(Reflect.get(representation, "addOutboxRecord")).toBeUndefined()
  })

  it("whitelists injected services before exposing restricted contexts", () => {
    const services = { clock: { now: () => new Date(0) }, idGenerator: () => "id", logger: { debug() {}, info() {}, warn() {}, error() {} }, telemetry: { emit() {} }, persistence: createProvider() }
    const operation = createOperationRunContext(createOperationContext({ persistence: createProvider(), runtimeCapabilities, services: services as never }))
    const representation = createRepresentationContext(operation)
    expect(Object.hasOwn(representation.services as object, "persistence")).toBe(false)
    expect(Object.isFrozen(representation.services)).toBe(true)
  })

  it("physically omits mutations inside a read-only transaction context", async () => {
    const provider = createProvider()
    const transactional = {
      ...provider,
      capabilities: { ...provider.capabilities, interactiveTransactions: true as const },
      runInTransaction: async (work: (scoped: PersistenceProvider) => Promise<void>) => work(provider),
    } as InteractiveTransactionProvider
    const readOnly = createReadOnlyPersistenceProvider(transactional)

    await expect(readOnly.runInTransaction(async (scoped) => {
      const readRepository = scoped.repository(entity) as any
      expect(Reflect.get(readRepository, "insert")).toBeUndefined()
      expect(Reflect.get(readRepository, "update")).toBeUndefined()
      expect(Reflect.get(readRepository, "delete")).toBeUndefined()
      expect(Object.isFrozen(readRepository)).toBe(true)
    })).resolves.toBeUndefined()
  })

  it("lets a mutation context register a durable effect", () => {
    const operation = createOperationRunContext(createOperationContext({
      persistence: createProvider(),
       runtimeCapabilities,
     }))
    const mutation = createMutationOperationContext(operation)

    mutation.addDurableEffect({ name: "publish", outbox: { type: "context-event", version: 1, scope: { kind: "platform", platformKey: "test" }, scopeId: "fscope:v1:eyJraW5kIjoicGxhdGZvcm0iLCJwbGF0Zm9ybUtleSI6InRlc3QifQ" as never, aggregateType: "fixture", aggregateId: "1", payload: { id: "1" }, idempotencyKey: "context-event-1" } })

    expect(Object.keys(mutation)).toContain("addDurableEffect")
    expect(Object.keys(mutation)).toContain("addBestEffortEffect")
    expect(Reflect.get(mutation, "requireRuntimeCapability")).toBeUndefined()
    expect(Reflect.get(mutation, "addTransactionalEffect")).toBeUndefined()
    expect(Reflect.get(mutation, "addOutboxRecord")).toBeUndefined()
    expect(operation.outboxRecords).toHaveLength(1)
    expect(operation.outboxRecords[0]).toMatchObject({ type: "context-event", payload: { id: "1" } })
  })

  it("does not replace tenant-scoped operation persistence with another tenant", () => {
    const tenantA = createTenantScopedPersistenceProvider(createProvider(), "tenant-a")
    const tenantB = createTenantScopedPersistenceProvider(createProvider(), "tenant-b")
    const operation = createOperationRunContext(createOperationContext({ persistence: tenantA, runtimeCapabilities }))

    expect(() => operation.withPersistence(tenantB as unknown as typeof tenantA)).toThrow("Cannot replace tenant-scoped persistence")
    expect(() => operation.withPersistence(createProvider() as unknown as typeof tenantA)).toThrow("with unscoped persistence")
    expect(operation.withPersistence(tenantA).persistence).toBe(tenantA)

    // A tenant-scoped context cannot be widened through the replacement API.
    // @ts-expect-error A different tenant scope is not a valid replacement.
    if (false) operation.withPersistence(tenantB)
    // @ts-expect-error Tenant-scoped operation persistence requires the same provider scope.
    if (false) operation.withPersistence(createProvider())
  })

  it("binds a request route to the selected operation while preserving requestless work", () => {
    const requestBound = {
      request: { route: { routeKey: "records.read", operationKey: "records.read", definitionVersion: 1 } },
    } as never
    expect(() => assertRequestBoundToOperation(requestBound, "records.delete")).toThrow(/bound to operation/)
    expect(() => assertRequestBoundToOperation(requestBound, "records.read")).not.toThrow()
    expect(() => assertRequestBoundToOperation({} as never, "background.cleanup")).not.toThrow()
  })
})
