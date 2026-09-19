import type { PersistenceCapabilities } from "./capabilities"
import type { PredicateNode } from "../domain/predicate"
import type { AuditRecord } from "../events/durability/audit"
import type { OutboxRecord } from "../events/durability/outbox"
import { ConfigurationError, TenantScopeViolationError } from "../domain"
import { assertEntityVersion, assertEntityVersionCanIncrement, type EntityVersion } from "../serialization/version"
import type { ExecutionScope } from "../domain/executionScope"
import type { ListResult, QueryOptions } from "../query/queryPlan"
import type { ScalarDescriptor } from "../entity/scalars/index"
import type { DataClassification } from "../domain/dataClassification"
import { TENANT_SCOPED_PROVIDER_BRAND, isCoreTenantScopedProvider } from "./tenantScopeBrand"
export type { ListResult, QueryOptions, SortSpec } from "../query/queryPlan"

export interface FieldDescriptor {
  type: "string" | "number" | "boolean" | "date" | "json" | "integer" | "decimal" | "datetime" | "uuid" | "enum" | "custom"
  nullable?: boolean
  format?: FieldFormat
  scalar?: ScalarDescriptor
  durableCodec?: string
  classification?: DataClassification
  enumValues?: readonly string[]
  precision?: number
  scale?: number
}

export type FieldFormat = "text" | "email" | "phone" | "date" | "identifier" | "json"

export interface EntityDescriptor<T> {
  name: string
  namespace?: string
  primaryKey?: keyof T & string
  tenantField?: keyof T & string
  versionField?: keyof T & string
  fields: Record<keyof T & string, FieldDescriptor>
  immutableFields?: readonly (keyof T & string)[]
  activeRowFilter?: PredicateNode
  deleteStrategy?: "hard" | "occ-soft" | "forbidden"
  deletedAtField?: keyof T & string
}

/** Descriptor variants used by repository factories to select mutation policy. */
export type VersionedEntityDescriptor<T> = EntityDescriptor<T> & {
  versionField: keyof T & string
}

export type UnversionedEntityDescriptor<T> = EntityDescriptor<T> & {
  versionField?: never
}

export interface UpdateWhereOptions {
  optimisticConcurrency?: { expectedVersion: EntityVersion }
}

export interface DeleteOptions {
  idempotent?: boolean
  /** Delete only when the row still has this version. */
  optimisticConcurrency?: { expectedVersion: EntityVersion }
}

export interface ReadRepository<T, TId = string> {
  findById(id: TId): Promise<T | null>
  findOneWhere?(filter: PredicateNode): Promise<T | null>
  findMany(options?: QueryOptions): Promise<ListResult<T>>
}

export interface InsertRepository<T> {
  insert(data: Partial<T>): Promise<T>
  bulkInsert?(data: Partial<T>[]): Promise<T[]>
}

export interface VersionedMutationRepository<T, TId = string> {
  update(id: TId, data: Partial<T>, options: UpdateWhereOptions & { optimisticConcurrency: { expectedVersion: EntityVersion } }): Promise<T>
  updateOneWhere?(filter: PredicateNode, data: Partial<T>, options: UpdateWhereOptions & { optimisticConcurrency: { expectedVersion: EntityVersion } }): Promise<{ updatedCount: number }>
  updateOneWhereReturning?(filter: PredicateNode, data: Partial<T>, options: UpdateWhereOptions & { optimisticConcurrency: { expectedVersion: EntityVersion } }): Promise<T | null>
  delete(id: TId, options: DeleteOptions & { optimisticConcurrency: { expectedVersion: EntityVersion } }): Promise<void>
  deleteWhere?(filter: PredicateNode, options: DeleteOptions & { optimisticConcurrency: { expectedVersion: EntityVersion } }): Promise<{ deletedCount: number }>
}

export interface UnversionedMutationRepository<T, TId = string> {
  update(id: TId, data: Partial<T>, options?: UpdateWhereOptions): Promise<T>
  updateOneWhere?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<{ updatedCount: number }>
  updateOneWhereReturning?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<T | null>
  updateManyWhere?(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<number>
  delete(id: TId, options?: DeleteOptions): Promise<void>
  deleteWhere?(filter: PredicateNode, options?: DeleteOptions): Promise<{ deletedCount: number }>
}

/**
 * Version discipline contract: every entity that declares `versionField` is a
 * versioned (OCC) entity. Every write to such an entity MUST advance
 * `versionField`, and conditional writes MUST fence on the expected version so
 * a concurrent policy-relevant writer cannot slip a stale authorization
 * decision past the mutation. Raw writes that bypass OCC (plain update/delete
 * without an expected version) are unsafe for versioned entities and are only
 * permitted through explicit, consciously-opted-in internal paths.
 */
export interface VersionedRepository<T, TId = string> extends ReadRepository<T, TId>, InsertRepository<T>, VersionedMutationRepository<T, TId> {}

export interface UnversionedRepository<T, TId = string> extends ReadRepository<T, TId>, InsertRepository<T>, UnversionedMutationRepository<T, TId> {}

/** Explicit secure-CRUD capability: adapters accepted here prove an atomic conditional returning write. */
export interface ConditionalReturningRepository<T> {
  updateOneWhereReturning(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<T | null>
}

/** Optional transaction-scoped pessimistic locking capability. Never emulated. */
export interface PessimisticLockingRepository<T, TId = string> {
  findByIdForUpdate(id: TId): Promise<T | null>
}

/** Common capability surface shared by already-authorized providers. */
export interface PersistenceProvider {
  readonly dialect: string
  readonly capabilities: PersistenceCapabilities
  repository<T, TId = string>(entity: VersionedEntityDescriptor<T>): VersionedRepository<T, TId>
  repository<T, TId = string>(entity: UnversionedEntityDescriptor<T>): UnversionedRepository<T, TId>
}

export interface ScopedPersistenceProvider<TScope extends ExecutionScope> extends PersistenceProvider {
  readonly scope: TScope
}

export type ApplicationPersistenceProvider = ScopedPersistenceProvider<Extract<ExecutionScope, { kind: "application" }>>
export interface TenantScopedPersistenceProvider<TTenantId extends string = string>
  extends ScopedPersistenceProvider<{ readonly kind: "tenant"; readonly tenantId: TTenantId }> {
  readonly tenantId: TTenantId
  readonly [TENANT_SCOPED_PROVIDER_BRAND]?: true
}
/** Unforgeable marker for providers created by the core tenant-scope wrapper. */
export type TenantPersistenceProvider<TTenantId extends string = string> = TenantScopedPersistenceProvider<TTenantId>
export type PlatformPersistenceProvider = ScopedPersistenceProvider<Extract<ExecutionScope, { kind: "platform" }>>
export type SystemPersistenceProvider = ScopedPersistenceProvider<Extract<ExecutionScope, { kind: "system" }>>

/** Root authority router. It is intentionally not assignable to a scoped provider. */
export interface RootPersistenceProvider {
  resolveApplication(scope: Extract<ExecutionScope, { kind: "application" }>): ApplicationPersistenceProvider
  resolveTenant(scope: Extract<ExecutionScope, { kind: "tenant" }>): TenantPersistenceProvider
  resolvePlatform(scope: Extract<ExecutionScope, { kind: "platform" }>): PlatformPersistenceProvider
  resolveSystem(scope: Extract<ExecutionScope, { kind: "system" }>): SystemPersistenceProvider
}

export function isTenantScopedPersistenceProvider(
  provider: PersistenceProvider,
): provider is TenantScopedPersistenceProvider {
  return typeof (provider as Partial<TenantScopedPersistenceProvider>).tenantId === "string" &&
    isCoreTenantScopedProvider(provider)
}

export function assertMatchingPersistenceScope(
  current: PersistenceProvider,
  replacement: PersistenceProvider,
): void {
  if (isTenantScopedPersistenceProvider(current) && !isTenantScopedPersistenceProvider(replacement)) {
    throw new TenantScopeViolationError(
      `Cannot replace tenant-scoped persistence for "${current.tenantId}" with unscoped persistence.`,
    )
  }
  if (
    isTenantScopedPersistenceProvider(current) &&
    isTenantScopedPersistenceProvider(replacement) &&
    current.tenantId !== replacement.tenantId
  ) {
    throw new TenantScopeViolationError(
      `Cannot replace tenant-scoped persistence for "${current.tenantId}" with persistence for "${replacement.tenantId}".`,
    )
  }
}

/** The read-only surface exposed to read lifecycle hooks. */
export interface ReadOnlyRepository<T, TId = string> {
  findById(id: TId): Promise<T | null>
  findOneWhere?(filter: PredicateNode): Promise<T | null>
  findMany(options?: QueryOptions): Promise<ListResult<T>>
}

/** A persistence capability that structurally cannot mutate durable state. */
export interface ReadOnlyPersistenceProvider {
  readonly dialect: string
  readonly capabilities: PersistenceCapabilities
  readonly tenantId?: string

  repository<T, TId = string>(entity: EntityDescriptor<T>): ReadOnlyRepository<T, TId>
}

/** Read-only transaction surface; it cannot hand mutable repositories to callbacks. */
export interface ReadOnlyInteractiveTransactionProvider extends ReadOnlyPersistenceProvider {
  readonly capabilities: PersistenceCapabilities & { interactiveTransactions: true }
  runInTransaction<TResult>(
    work: (scoped: ReadOnlyPersistenceProvider) => Promise<TResult>,
    options?: TransactionOptions,
  ): Promise<TResult>
}

/** Wrap a provider so operation code can only use its read path. */
export function createReadOnlyPersistenceProvider(provider: InteractiveTransactionProvider): ReadOnlyInteractiveTransactionProvider
export function createReadOnlyPersistenceProvider(provider: PersistenceProvider): ReadOnlyPersistenceProvider
export function createReadOnlyPersistenceProvider(provider: PersistenceProvider): ReadOnlyPersistenceProvider {
  const readOnlyRepository = <T, TId>(entity: EntityDescriptor<T>): ReadOnlyRepository<T, TId> => {
    const repository = entity.versionField
      ? provider.repository<T, TId>(entity as VersionedEntityDescriptor<T>)
      : provider.repository<T, TId>(entity as UnversionedEntityDescriptor<T>)
    return Object.freeze({
      findById: (id: TId) => repository.findById(id),
      ...(repository.findOneWhere ? { findOneWhere: (filter: PredicateNode) => repository.findOneWhere!(filter) } : {}),
      findMany: (options?: QueryOptions) => repository.findMany(options),
    })
  }

  const baseReadOnly: ReadOnlyPersistenceProvider = Object.freeze({
    dialect: provider.dialect,
    capabilities: provider.capabilities,
    ...(isTenantScopedPersistenceProvider(provider) ? { tenantId: provider.tenantId } : {}),
    repository: readOnlyRepository,
  })
  if (supportsInteractiveTransactions(provider)) {
    return Object.freeze({
      ...baseReadOnly,
      capabilities: provider.capabilities,
      runInTransaction: (work: (scoped: ReadOnlyPersistenceProvider) => Promise<unknown>, options?: TransactionOptions) => provider.runInTransaction(
        (scoped) => work(createReadOnlyPersistenceProvider(scoped)),
        { ...options, accessMode: "read only" },
      ),
    }) as ReadOnlyInteractiveTransactionProvider
  }
  return baseReadOnly
}

export interface TransactionOptions {
  isolationLevel?: "read committed" | "repeatable read" | "serializable"
  accessMode?: "read only" | "read write"
}

export interface InteractiveTransactionProvider extends PersistenceProvider {
  readonly capabilities: PersistenceCapabilities & { interactiveTransactions: true }
  runInTransaction<TResult>(
    work: (scoped: PersistenceProvider) => Promise<TResult>,
    options?: TransactionOptions,
  ): Promise<TResult>
}

export function supportsInteractiveTransactions(provider: PersistenceProvider): provider is InteractiveTransactionProvider {
  return (
    provider.capabilities.interactiveTransactions === true &&
    typeof (provider as Partial<InteractiveTransactionProvider>).runInTransaction === "function"
  )
}

export type AtomicBatchItem<TCommand = unknown> =
  | { kind: "command"; command: TCommand }
  | { kind: "audit"; record: AuditRecord }
  | { kind: "outbox"; record: OutboxRecord }
  | { kind: "cache-generation"; tag: string }
  | { kind: "idempotency"; commit: import("../events/durability/idempotency").IdempotencyCommitItem }

export interface AtomicBatchPlan<TCommand = unknown> {
  readonly items: readonly AtomicBatchItem<TCommand>[]
}

export type AtomicBatchItemResult =
  | { readonly kind: "command"; readonly result: unknown }
  | { readonly kind: "audit"; readonly result: unknown }
  | { readonly kind: "outbox"; readonly result: unknown }
  | { readonly kind: "cache-generation"; readonly result: unknown }
  | { readonly kind: "idempotency"; readonly result: unknown }

export type AtomicBatchResult = readonly AtomicBatchItemResult[]

export type TenantScopedWriteCommand =
  | { readonly kind: "insert"; readonly entity: string; readonly values: Readonly<Record<string, unknown>> }
  | { readonly kind: "update"; readonly entity: string; readonly filter: PredicateNode; readonly values: Readonly<Record<string, unknown>>; readonly expectedVersion?: EntityVersion; readonly expectedAffectedRows?: number }
  | { readonly kind: "delete"; readonly entity: string; readonly filter: PredicateNode; readonly expectedVersion?: EntityVersion; readonly expectedAffectedRows?: number }

/** Adapters own this encoder; callers only submit typed write commands. */
export interface TenantScopedAtomicBatchCommandEncoder<TCommand = unknown> {
  readonly tenantId: string
  encode(command: TCommand): TCommand
}

export interface TenantScopedAtomicBatchCommandProvider<TCommand = unknown> {
  createTenantScopedCommandEncoder(tenantId: string): TenantScopedAtomicBatchCommandEncoder<TCommand>
}

export type TenantScopedAtomicBatchPlan<TCommand = unknown> = AtomicBatchPlan<TCommand>

export interface AtomicBatchProvider<TCommand = unknown> extends PersistenceProvider {
  readonly capabilities: PersistenceCapabilities & { atomicBatch: true; atomicBatchScope?: "unscoped" }
  executeAtomicBatch(plan: AtomicBatchPlan<TCommand>): Promise<AtomicBatchResult>
}

export interface TenantScopedAtomicBatchProvider<TCommand = unknown> extends PersistenceProvider {
  readonly capabilities: PersistenceCapabilities & { atomicBatch: true; atomicBatchScope: "tenant-scoped" }
  /** The scoped provider's adapter-owned command encoder. */
  readonly tenantId: string
  readonly commandEncoder: TenantScopedAtomicBatchCommandEncoder<TCommand>
  executeAtomicBatch(plan: TenantScopedAtomicBatchPlan<TCommand>): Promise<AtomicBatchResult>
}

export type AtomicBatchCapableProvider<TCommand = unknown> =
  | AtomicBatchProvider<TCommand>
  | TenantScopedAtomicBatchProvider<TCommand>

function hasTenantScopedAtomicBatchContract(provider: PersistenceProvider): boolean {
  return (
    typeof (provider as Partial<TenantScopedAtomicBatchProvider>).executeAtomicBatch === "function" &&
    typeof (provider as Partial<TenantScopedAtomicBatchProvider>).tenantId === "string" &&
    typeof (provider as Partial<TenantScopedAtomicBatchProvider>).commandEncoder?.encode === "function"
  )
}

export function supportsAtomicBatch(provider: PersistenceProvider): provider is AtomicBatchCapableProvider {
  return (
    provider.capabilities.atomicBatch === true &&
    (provider.capabilities.atomicBatchScope === undefined || provider.capabilities.atomicBatchScope === "unscoped"
      ? typeof (provider as Partial<AtomicBatchProvider>).executeAtomicBatch === "function"
      : provider.capabilities.atomicBatchScope === "tenant-scoped" && hasTenantScopedAtomicBatchContract(provider))
  )
}

export function supportsTenantScopedAtomicBatch(
  provider: PersistenceProvider,
): provider is TenantScopedAtomicBatchProvider {
  return (
    provider.capabilities.atomicBatch === true &&
    provider.capabilities.atomicBatchScope === "tenant-scoped" &&
    hasTenantScopedAtomicBatchContract(provider)
  )
}

/**
 * Batch 1 version discipline helper.
 * Ensures every write to a versioned entity supplies an expectedVersion so
 * concurrent policy-relevant writers cannot slip a stale authorization decision
 * past the mutation. The check is exposed for adapter reuse; repositories call
 * it at the start of each mutating method.
 *
 * All versioned writes require an expected version.
 */
export function assertVersionedWriteHasExpectedVersion<T>(
  entity: EntityDescriptor<T>,
  options?: UpdateWhereOptions | DeleteOptions,
  incrementsVersion = true,
): void {
  if (!entity.versionField) return
  const oc = options?.optimisticConcurrency
  if (!oc || oc.expectedVersion === undefined || oc.expectedVersion === null) {
    throw new ConfigurationError(
      `Versioned entity "${entity.name}" requires optimisticConcurrency.expectedVersion`,
    )
  }
  // A conditional delete fences on the current version but does not advance it.
  // Keep the terminal safe integer usable for that final state transition.
  if (incrementsVersion) assertEntityVersionCanIncrement(oc.expectedVersion)
  else assertEntityVersion(oc.expectedVersion)
}
