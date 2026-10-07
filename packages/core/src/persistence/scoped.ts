import { Predicate, type PredicateNode } from "../domain/predicate"
import { isAlwaysTrue, simplifyPredicate } from "../domain/predicateSimplifier"
import { ConfigurationError, UnsupportedCapabilityError, NotFoundError, TenantScopeViolationError, ImmutableFieldViolationError } from "../domain/errors"
import type { EntityDescriptor } from "./provider"
import { isTenantScopedPersistenceProvider, supportsInteractiveTransactions } from "./provider"
import { registerTenantScopedProvider } from "./tenantScopeBrand"
import type {
  AtomicBatchPlan,
  AtomicBatchProvider,
  AtomicBatchResult,
  TenantScopedAtomicBatchPlan,
  TenantScopedAtomicBatchProvider,
  TenantScopedAtomicBatchCommandProvider,
  PersistenceProvider,
  TenantScopedPersistenceProvider,
  InteractiveTransactionProvider,
  TransactionOptions,
  VersionedEntityDescriptor,
  UnversionedEntityDescriptor,
  VersionedRepository,
  UnversionedRepository,
  ReadRepository,
  InsertRepository,
  UpdateWhereOptions,
  DeleteOptions,
  QueryOptions,
  ListResult,
} from "./provider"
import { assertVersionedWriteHasExpectedVersion } from "./provider"
import type { AuditRecord } from "../events/durability/audit"
import type { OutboxRecord } from "../events/durability/outbox"
import type {
  IdempotencyCommitItem,
  IdempotencyCompletion,
  IdempotencyPort,
  IdempotencyRequest,
  TransactionalIdempotencyPort,
  AtomicBatchIdempotencyPort,
} from "../events/durability/idempotency"

/** Framework-internal dynamic dispatch shape; never exported from the public port. */
interface FrameworkRepository<T, TId = string> extends ReadRepository<T, TId>, InsertRepository<T> {
  update(id: TId, data: Partial<T>, options?: UpdateWhereOptions): Promise<T>
  updateOneWhere?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<{ updatedCount: number }>
  updateOneWhereReturning?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<T | null>
  updateManyWhere?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<number>
  delete(id: TId, options?: DeleteOptions): Promise<void>
  deleteWhere?(filter: PredicateNode, options?: DeleteOptions): Promise<{ deletedCount: number }>
}

function internalRepositoryForDescriptor<T, TId = string>(
  provider: PersistenceProvider,
  entity: EntityDescriptor<T>,
): FrameworkRepository<T, TId> {
  const repository = entity.versionField
    ? provider.repository<T, TId>(entity as VersionedEntityDescriptor<T>)
    : provider.repository<T, TId>(entity as UnversionedEntityDescriptor<T>)
  return repository
}

function withTenantScope(filter: PredicateNode | undefined, tenantField: string, tenantId: string): PredicateNode {
  const tenantScope = Predicate.eq(tenantField, tenantId)
  return filter ? Predicate.and(filter, tenantScope) : tenantScope
}

function getPrimaryKey<T>(entity: EntityDescriptor<T>): keyof T & string {
  return entity.primaryKey ?? ("id" as keyof T & string)
}

function assertTenantFieldUnchanged<T>(data: Partial<T>, tenantField: keyof T & string, entityName: string): void {
  if (Object.prototype.hasOwnProperty.call(data, tenantField)) {
    throw new TenantScopeViolationError(
      `Cannot mutate tenant field "${String(tenantField)}" on entity "${entityName}" through update operations. ` +
      `Tenant assignment is managed by the framework.`
    )
  }
}

function assertImmutableFieldsUnchanged<T>(data: Partial<T>, entity: EntityDescriptor<T>): void {
  if (!entity.immutableFields) return
  for (const field of entity.immutableFields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      throw new ImmutableFieldViolationError(
        `Cannot mutate immutable field "${String(field)}" on entity "${entity.name}".`
      )
    }
  }
}

function assertPrimaryKeyUnchanged<T>(data: Partial<T>, entity: EntityDescriptor<T>): void {
  const primaryKey = getPrimaryKey(entity)
  if (Object.prototype.hasOwnProperty.call(data, primaryKey)) {
    throw new ImmutableFieldViolationError(
      `Cannot mutate primary key field "${String(primaryKey)}" on entity "${entity.name}".`,
    )
  }
}

function assertVersionFieldUnchanged<T>(data: Partial<T>, entity: EntityDescriptor<T>): void {
  const versionField = entity.versionField
  if (versionField && Object.prototype.hasOwnProperty.call(data, versionField)) {
    throw new ImmutableFieldViolationError(
      `Cannot mutate version field "${String(versionField)}" on entity "${entity.name}".`,
    )
  }
}

function assertUpdateDataValid<T>(data: Partial<T>, entity: EntityDescriptor<T>): void {
  const tenantField = entity.tenantField
  if (tenantField) {
    assertTenantFieldUnchanged(data, tenantField, entity.name)
  }
  assertPrimaryKeyUnchanged(data, entity)
  assertVersionFieldUnchanged(data, entity)
  assertImmutableFieldsUnchanged(data, entity)
}

function assertSafeDestructiveFilter(filter: PredicateNode, entityName: string): void {
  if (isAlwaysTrue(simplifyPredicate(filter))) {
    throw new ConfigurationError(
      `Destructive operations on ${entityName} cannot target every row.`,
    )
  }
}

function assertScopedTenantInsert<T>(data: Partial<T>, tenantField: keyof T & string, tenantId: string, entityName: string): void {
  if (Object.prototype.hasOwnProperty.call(data, tenantField)) {
    const supplied = (data as Record<string, unknown>)[tenantField]
    if (supplied !== tenantId) {
      throw new TenantScopeViolationError(
        `Cannot insert into "${entityName}" with tenant field "${String(tenantField)}" set to "${String(supplied)}" for tenant "${tenantId}". ` +
        "Tenant assignment is managed by the framework.",
      )
    }
  }
}

function assertReturnedTenantRecord<T>(record: T | null, tenantField: string, tenantId: string, entityName: string): T | null {
  if (record === null) return null
  if (!record || typeof record !== "object" || (record as Record<string, unknown>)[tenantField] !== tenantId) {
    throw new TenantScopeViolationError(`Persistence adapter returned a row outside tenant "${tenantId}" for entity "${entityName}".`)
  }
  return record
}

function normalizeTenantRecord<T extends { tenantId?: string | null }>(
  record: T,
  tenantId: string,
  kind: string,
): T & { tenantId: string } {
  if (record.tenantId != null && record.tenantId !== tenantId) {
    throw new TenantScopeViolationError(
      `Cannot include ${kind} for tenant "${record.tenantId}" in a batch for tenant "${tenantId}".`,
    )
  }
  return { ...record, tenantId }
}

/** Encodes a tenant namespace so tenant IDs containing delimiters cannot collide. */
export function encodeTenantIdempotencyScope(tenantId: string): string {
  return `tenant:${tenantId.length}:${tenantId}`
}

function decodeTenantIdempotencyScope(scope: string): string | null {
  const match = /^tenant:(\d+):/.exec(scope)
  if (!match) return null

  const encodedLength = Number(match[1])
  if (!Number.isSafeInteger(encodedLength)) return null
  const tenantStart = match[0].length
  const tenantEnd = tenantStart + encodedLength
  if (scope.length !== tenantEnd && scope[tenantEnd] !== ":") return null
  return scope.slice(tenantStart, tenantEnd)
}

export function assertTenantIdempotencyScope(scope: string, tenantId: string): void {
  // Decode the scope's tenant segment and compare the complete value. This
  // deliberately rejects the pre-length-prefixed format as unsafe to migrate.
  if (decodeTenantIdempotencyScope(scope) !== tenantId) {
    throw new TenantScopeViolationError(
      `Cannot use idempotency scope "${scope}" for tenant "${tenantId}".`,
    )
  }
}

/**
 * Encodes a cache tag in the tenant's length-prefixed namespace. Readers and
 * writers must both use this form for tenant-owned tags so a tenant-scoped
 * atomic batch can advance the generation the tenant's cache entries read.
 */
export function encodeTenantCacheTag(tenantId: string, tag: string): string {
  return `${encodeTenantIdempotencyScope(tenantId)}:${tag}`
}

/** Rejects cache-generation tags that are global or belong to another tenant. */
export function assertTenantCacheTag(tag: string, tenantId: string): void {
  if (typeof tag !== "string" || decodeTenantIdempotencyScope(tag) !== tenantId) {
    throw new TenantScopeViolationError(
      `Cannot advance cache generation "${String(tag)}" for tenant "${tenantId}".`,
    )
  }
}

/** Tenant attenuation preserves only durable commit operations that carry a scope. */
export type TenantScopedIdempotencyPort<TResult, TPort extends IdempotencyPort<TResult>> =
  IdempotencyPort<TResult>
  & (TPort extends TransactionalIdempotencyPort<TResult> ? Pick<TransactionalIdempotencyPort<TResult>, "markCommittedInTransaction"> : object)
  & (TPort extends AtomicBatchIdempotencyPort<TResult> ? Pick<AtomicBatchIdempotencyPort<TResult>, "createCommitBatchItem"> : object)

export function createTenantScopedIdempotencyPort<TResult, TPort extends IdempotencyPort<TResult>>(
  base: TPort,
  tenantId: string,
): TenantScopedIdempotencyPort<TResult, TPort> {
  const validateRequest = (request: IdempotencyRequest): void => {
    assertTenantIdempotencyScope(request.scope, tenantId)
  }
  const validateCompletion = (completion: IdempotencyCompletion<TResult>): void => {
    assertTenantIdempotencyScope(completion.scope, tenantId)
  }
  // Copy only the tenant-safe base operations. In particular, do not spread
  // finalizer methods: their claim API has no tenant parameter and cannot be
  // safely attenuated here.
  const scoped = {
    acquire: async (request: IdempotencyRequest) => {
      validateRequest(request)
      return base.acquire(request)
    },
    renew: async (lease: Parameters<TPort["renew"]>[0]) => {
      validateRequest(lease)
      return base.renew(lease)
    },
    complete: async (completion: IdempotencyCompletion<TResult>) => {
      validateCompletion(completion)
      return base.complete(completion)
    },
  } as TPort & Partial<TransactionalIdempotencyPort<TResult> & AtomicBatchIdempotencyPort<TResult>>

  if (typeof (base as Partial<TransactionalIdempotencyPort<TResult>>).markCommittedInTransaction === "function") {
    scoped.markCommittedInTransaction = async (completion: IdempotencyCommitItem, persistence: PersistenceProvider) => {
      assertTenantIdempotencyScope(completion.scope, tenantId)
      return (base as unknown as TransactionalIdempotencyPort<TResult>).markCommittedInTransaction(completion, persistence)
    }
  }
  if (typeof (base as Partial<AtomicBatchIdempotencyPort<TResult>>).createCommitBatchItem === "function") {
    scoped.createCommitBatchItem = (completion: IdempotencyCommitItem) => {
      assertTenantIdempotencyScope(completion.scope, tenantId)
      return (base as unknown as AtomicBatchIdempotencyPort<TResult>).createCommitBatchItem(completion)
    }
  }
  return scoped as TenantScopedIdempotencyPort<TResult, TPort>
}

export function createTenantScopedPersistenceProvider<TTenantId extends string>(
  base: PersistenceProvider,
  tenantId: TTenantId,
): TenantScopedPersistenceProvider<TTenantId> {
  if (isTenantScopedPersistenceProvider(base)) {
    if (base.tenantId !== tenantId) {
      const currentTenantId = base.tenantId
      throw new TenantScopeViolationError(
        `Cannot rescope tenant persistence from "${currentTenantId}" to "${tenantId}".`,
      )
    }
    return base as TenantScopedPersistenceProvider<TTenantId>
  }

  const scoped = {
    dialect: base.dialect,
    tenantId,
    scope: Object.freeze({ kind: "tenant" as const, tenantId }),
    capabilities: base.capabilities.atomicBatch
      ? { ...base.capabilities, atomicBatchScope: "tenant-scoped" }
      : base.capabilities,
    repository<T, TId = string>(entity: EntityDescriptor<T>): FrameworkRepository<T, TId> {
      const tenantField = entity.tenantField

      if (!tenantField) {
        throw new TenantScopeViolationError(
          `Global entity "${entity.name}" cannot be accessed through tenant-scoped persistence. ` +
          "Use an explicit platform-scoped provider and authorize the required global capability.",
        )
      }

      const repo = internalRepositoryForDescriptor<T, TId>(base, entity)

      const primaryKey = getPrimaryKey(entity)

      const common = {
        async findById(id: TId): Promise<T | null> {
          const filter = withTenantScope(Predicate.eq(primaryKey, id as never), tenantField, tenantId)
          if (repo.findOneWhere) {
            return assertReturnedTenantRecord(await repo.findOneWhere(filter), tenantField, tenantId, entity.name)
          }
          const result = await repo.findMany({ filter, pagination: { kind: "offset", page: 1, pageSize: 1 } })
          return assertReturnedTenantRecord(result.rows[0] ?? null, tenantField, tenantId, entity.name)
        },
        async findOneWhere(filter: PredicateNode): Promise<T | null> {
          const scopedFilter = withTenantScope(filter, tenantField, tenantId)
          if (repo.findOneWhere) {
            return assertReturnedTenantRecord(await repo.findOneWhere(scopedFilter), tenantField, tenantId, entity.name)
          }
          const result = await repo.findMany({ filter: scopedFilter, pagination: { kind: "offset", page: 1, pageSize: 1 } })
          return assertReturnedTenantRecord(result.rows[0] ?? null, tenantField, tenantId, entity.name)
        },
        async findMany(options?: QueryOptions): Promise<ListResult<T>> {
          const result = await repo.findMany({
            ...options,
            filter: withTenantScope(options?.filter, tenantField, tenantId),
          })
          for (const row of result.rows) assertReturnedTenantRecord(row, tenantField, tenantId, entity.name)
          return result
        },
        async insert(data: Partial<T>): Promise<T> {
          assertScopedTenantInsert(data, tenantField, tenantId, entity.name)
          return assertReturnedTenantRecord(await repo.insert({
            ...data,
            [tenantField]: tenantId,
          }), tenantField, tenantId, entity.name) as T
        },
        async update(id: TId, data: Partial<T>, options?: UpdateWhereOptions): Promise<T> {
          assertUpdateDataValid(data, entity)
          assertVersionedWriteHasExpectedVersion(entity as EntityDescriptor<unknown>, options)

          if (!repo.updateOneWhereReturning) {
            throw new UnsupportedCapabilityError(
              `Scoped update by ID is not supported by the ${entity.name} repository adapter. ` +
              "Exact post-mutation row semantics require updateOneWhereReturning; an update-then-read fallback could observe a concurrent writer."
            )
          }
          const updated = await repo.updateOneWhereReturning(
            withTenantScope(Predicate.eq(primaryKey, id as never), tenantField, tenantId),
            data,
            options,
          )
          if (!updated) {
            throw new NotFoundError(`Scoped update failed: ${entity.name} not found`, { entity: entity.name, id })
          }
          return assertReturnedTenantRecord(updated, tenantField, tenantId, entity.name) as T
        },
        async updateOneWhere(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<{ updatedCount: number }> {
          assertUpdateDataValid(data, entity)
          assertSafeDestructiveFilter(filter, entity.name)
          assertVersionedWriteHasExpectedVersion(entity as EntityDescriptor<unknown>, options)

          const scopedFilter = withTenantScope(filter, tenantField, tenantId)
          if (repo.updateOneWhere) {
            return repo.updateOneWhere(scopedFilter, data, options)
          }
          throw new UnsupportedCapabilityError(
            `updateOneWhere is not supported by the ${entity.name} repository adapter.`,
          )
        },
        updateOneWhereReturning: async (filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<T | null> => {
            assertUpdateDataValid(data, entity)
            assertSafeDestructiveFilter(filter, entity.name)
            assertVersionedWriteHasExpectedVersion(entity as EntityDescriptor<unknown>, options)

            const scopedFilter = withTenantScope(filter, tenantField, tenantId)
            if (!repo.updateOneWhereReturning) {
              throw new UnsupportedCapabilityError(`updateOneWhereReturning is not supported by the ${entity.name} repository adapter.`)
            }
            return assertReturnedTenantRecord(await repo.updateOneWhereReturning(scopedFilter, data, options), tenantField, tenantId, entity.name)
        },
        async updateManyWhere(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<number> {
          assertUpdateDataValid(data, entity)
          assertSafeDestructiveFilter(filter, entity.name)
          if (entity.versionField) {
            throw new UnsupportedCapabilityError(
              `updateManyWhere is not supported for versioned entity ${entity.name}. ` +
              "Use individual updates with optimistic concurrency.",
            )
          }
          assertVersionedWriteHasExpectedVersion(entity as EntityDescriptor<unknown>, options)

          const scopedFilter = withTenantScope(filter, tenantField, tenantId)
          if (repo.updateManyWhere) {
            return repo.updateManyWhere(scopedFilter, data, options)
          }
          throw new UnsupportedCapabilityError(
            `updateManyWhere is not supported by the ${entity.name} repository adapter. ` +
            "Use a loop with individual updates or implement updateManyWhere on the adapter.",
          )
        },
        async delete(id: TId, options?: DeleteOptions): Promise<void> {
          assertVersionedWriteHasExpectedVersion(entity as EntityDescriptor<unknown>, options, false)
          if (!repo.deleteWhere) {
            throw new UnsupportedCapabilityError(
              `Scoped delete by ID is not supported by the ${entity.name} repository adapter.`
            )
          }
          const result = await repo.deleteWhere(
            withTenantScope(Predicate.eq(primaryKey, id as never), tenantField, tenantId),
            options,
          )
           if (result.deletedCount === 0 && !options?.idempotent) {
             throw new NotFoundError(`Scoped delete failed: ${entity.name} not found`, { entity: entity.name, id })
           }
          return
        },
        async deleteWhere(filter: PredicateNode, options?: DeleteOptions): Promise<{ deletedCount: number }> {
          assertSafeDestructiveFilter(filter, entity.name)
          assertVersionedWriteHasExpectedVersion(entity as EntityDescriptor<unknown>, options, false)
          const scopedFilter = withTenantScope(filter, tenantField, tenantId)
          if (repo.deleteWhere) {
            return repo.deleteWhere(scopedFilter, options)
          }
          throw new UnsupportedCapabilityError(
            `deleteWhere is not supported by the ${entity.name} repository adapter.`,
          )
        },
        ...(repo.bulkInsert != null && {
          bulkInsert: async (data: Partial<T>[]) => {
            const normalized = data.map((row) => {
              assertScopedTenantInsert(row, tenantField, tenantId, entity.name)
              assertPrimaryKeyUnchanged(row, entity)
              assertVersionFieldUnchanged(row, entity)
              assertImmutableFieldsUnchanged(row, entity)
              return {
                ...row,
                [tenantField]: tenantId,
              }
            })
            const rows = await repo.bulkInsert!(normalized)
            for (const row of rows) assertReturnedTenantRecord(row, tenantField, tenantId, entity.name)
            return rows
          },
        }),
      }

      if (entity.versionField) {
        const { updateManyWhere: _removed, ...versioned } = common
        return versioned
      }
      return common
    },
  } satisfies TenantScopedPersistenceProvider<TTenantId>

  const atomicBase = base as Partial<AtomicBatchProvider & TenantScopedAtomicBatchCommandProvider>
  if (typeof atomicBase.executeAtomicBatch === "function") {
    const atomicScoped: typeof scoped & {
      commandEncoder?: TenantScopedAtomicBatchProvider["commandEncoder"]
      executeAtomicBatch?: TenantScopedAtomicBatchProvider["executeAtomicBatch"]
    } = scoped
    const commandEncoder = atomicBase.createTenantScopedCommandEncoder?.(tenantId)
    if (commandEncoder) atomicScoped.commandEncoder = commandEncoder
    atomicScoped.executeAtomicBatch = async (plan: TenantScopedAtomicBatchPlan<unknown>): Promise<AtomicBatchResult> => {
      if (!commandEncoder) {
        throw new ConfigurationError(
          "Tenant-scoped atomic batches require an adapter-owned command encoder.",
        )
      }

      const encodedPlan: AtomicBatchPlan<unknown> = {
        ...plan,
        items: plan.items.map((item) => {
          if (item.kind === "command") {
            return { kind: "command", command: commandEncoder.encode(item.command) }
          }
          if (item.kind === "audit") {
            return { kind: "audit", record: normalizeTenantRecord<AuditRecord>(item.record, tenantId, "audit record") }
          }
          if (item.kind === "outbox") {
            return { kind: "outbox", record: normalizeTenantRecord<OutboxRecord>(item.record, tenantId, "outbox record") }
          }
          if (item.kind === "cache-generation") {
            assertTenantCacheTag(item.tag, tenantId)
            return { kind: "cache-generation", tag: item.tag }
          }
          assertTenantIdempotencyScope(item.commit.scope, tenantId)
          return { kind: "idempotency", commit: item.commit }
        }),
      }
      return atomicBase.executeAtomicBatch!(encodedPlan)
    }
  }

  const interactiveBase = base as Partial<InteractiveTransactionProvider>
  if (typeof interactiveBase.runInTransaction === "function") {
    const interactiveScoped: typeof scoped & {
      runInTransaction?: InteractiveTransactionProvider["runInTransaction"]
    } = scoped
    interactiveScoped.runInTransaction = async <TResult>(
      work: (transactionScoped: PersistenceProvider) => Promise<TResult>,
      options?: TransactionOptions,
    ): Promise<TResult> => interactiveBase.runInTransaction!(
      (transactionBase) => work(createTenantScopedPersistenceProvider(transactionBase, tenantId)),
      options,
    )
  }

  // The provider's identity and attenuation surface must not be rewritable
  // after it has been recognized as tenant-scoped.
  registerTenantScopedProvider(scoped)
  return Object.freeze(scoped)
}

export function createTenantScopedInteractiveTransactionProvider(
  base: InteractiveTransactionProvider,
  tenantId: string,
): InteractiveTransactionProvider {
  const scoped = createTenantScopedPersistenceProvider(base, tenantId)
  if (!supportsInteractiveTransactions(scoped)) {
    throw new ConfigurationError("Interactive transaction capability was lost while attenuating tenant persistence.")
  }
  return scoped
}
