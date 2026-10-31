import type { AuditFieldClassifications } from "../events/durability/audit"
import type { EntityDescriptor, ReadOnlyPersistenceProvider } from "../persistence/provider"
import type { RateLimitConfig, RateLimitPolicy } from "../rate-limit/rateLimit"
import type { ValidationSchema } from "../kernel/validation"
import { resolveCapabilityKey, type CapabilityCheckConfig } from "./capabilityCheck"
import type { EntityScopeDefinition } from "./entityScope"
import type { FilterFieldMeta } from "../domain"
import type {
  MutationOperationContext,
  PostCommitContext,
  RepresentationContext,
} from "../operation"
import { ConfigurationError } from "../domain"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"
import { compileEntity, defaultEntityNamespace, type CompiledEntityDefinition } from "./compileEntity"
import type { EntityLifecyclePolicy } from "./lifecycle"
import type { FieldDataClassifications } from "../domain/dataClassification"
import type { DurableCodecRegistry } from "../serialization/durableCodec"
import { ENTITY_DEFINITION_BRAND, registerEntityDefinition } from "./brands"

export type CrudRouteKey = "list" | "detail" | "create" | "update" | "delete"

export interface EntityValidationSchemas<
  TIdParams = unknown,
  TCreateBody = unknown,
  TUpdateBody = unknown,
  TListQuery = unknown,
> {
  idParams?: ValidationSchema<TIdParams>
  createBody?: ValidationSchema<TCreateBody>
  updateBody?: ValidationSchema<TUpdateBody>
  listQuery?: ValidationSchema<TListQuery>
}

export interface EntityAuditConfig {
  resource: string
  emitOn: Array<"create" | "update" | "delete">
  includeValues: boolean
  readAudit: boolean
  fieldClassification?: AuditFieldClassifications
  required?: boolean
  auditGuarantee?: "atomic" | "durable" | "best-effort"
  fallbackAuditGuarantee?: "best-effort"
  requiredStateSemantics?: "committed-state"
}
export interface EntityQueryLimits {
  maxPredicateDepth?: number
  maxPredicateNodes?: number
  maxOrBranches?: number
  maxInValues?: number
  maxSortFields?: number
  maxProjectionFields?: number
  maxSearchBytes?: number
  maxSearchableColumns?: number
  maxOffset?: number
  maxCount?: number
}
export interface EntitySearchStrategy {
  kind: "contains" | "prefix" | "fullText"
  indexName?: string
  /** Required for fullText so compilation binds a concrete SearchPort capability. */
  portKey?: string
}

export interface EntityCacheConfig {
  tag: string
  keyPrefix: string
}

export interface EntityIdempotencyConfig {
  namespace?: string
}
export type EntityAuditSetting = false | EntityAuditConfig
export type EntityCacheSetting = false | EntityCacheConfig
export type EntityIdempotencySetting = false | EntityIdempotencyConfig

export type EntityRateLimitSetting = RateLimitConfig & RateLimitPolicy & { consistency: NonNullable<RateLimitPolicy["consistency"]> }
export type EntityRateLimitConfig = Partial<Record<CrudRouteKey, EntityRateLimitSetting>>

export interface EntityRouteConfig {
  list: boolean
  detail: boolean
  create: boolean
  update: boolean
  delete: boolean
}

/**
 * Optimistic concurrency is MANDATORY for any entity that enables `update` or
 * `delete` routes. Mutating routes run read-then-write authorization; without
 * a concrete numeric `versionField` the authorization snapshot is exposed to
 * TOCTOU. `validateEntity` rejects update/delete routes that declare neither
 * `entity.versionField` nor `optimisticConcurrency.versionField`.
 */

export interface CrudListResult<T = Record<string, unknown>> {
  rows: T[]
  /** Total matching rows; present only for offset pages that requested a total. */
  rowCount?: number
  page: number
  pageSize: number
}

export interface ListQueryInput {
  page: number
  pageSize: number
  sorting?: string
  filters?: string
}

export type CrudMutationHookOperation = Omit<
  MutationOperationContext,
  "persistence" | "enforceAbac" | "invoke" | "addDurableEffect" | "addBestEffortEffect"
> & { readonly persistence: ReadOnlyPersistenceProvider }

export type CrudReadHookOperation = Pick<
  RepresentationContext,
  "operationId" | "correlationId" | "services" | "metadata"
>

/** Context shared by mutation lifecycle hooks. Persistence is tenant-scoped and read-only. */
export interface CrudMutationHookContext {
  tenantId: string
  persistence: ReadOnlyPersistenceProvider
  requestId: string
  correlationId: string
  operation?: CrudMutationHookOperation
}

/** Context shared by read lifecycle hooks. Read hooks do not receive persistence. */
export interface CrudReadHookContext {
  tenantId: string
  requestId: string
  correlationId: string
  /** Operation services remain available, but generic persistence is not. */
  operation?: CrudReadHookOperation
}

export interface CrudPostCommitHookContext {
  tenantId: string
  requestId: string
  correlationId: string
}

/**
 * Lifecycle hook ordering / idempotency contract (P1-14 clean split):
 *
 * - `transformInput`: runs inside the mutation transaction
 *   before commit. It may transform the input/patch deterministically and must
 *   be idempotent under retries. Receives read-only persistence; it MUST NOT
 *   perform arbitrary writes — that would bypass ABAC/OCC/tenant scoping.
 *
 * - `projectCommittedResult`: representation-only; it MUST NOT mutate durable
 *   state and must be idempotent. On interactive-transaction providers it runs
 *   inside the writing transaction just before commit, and its read-only
 *   persistence is bound to that transaction: it sees the just-written row,
 *   cannot write, and fails if used after the operation ends. On atomic-batch
 *   providers it runs after the batch commits, with a fresh read-only
 *   persistence. (For list/detail, result projection hooks run inside the read
 *   transaction, before the read-projection/ABAC re-application.)
 *
 * - `afterCommit`: post-commit side-effect hook (outbox, notifications).
 *   Not a representation transform — must not mutate the returned row.
 *
 * `validateEntity` enforces this contract: it rejects unknown hook names
 * and ensures hooks are functions.
 */
export interface CrudLifecycle<
  TRow = Record<string, unknown>,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow = TRow,
  TDetailRow = TRow,
> {
  list?: {
    transformQuery?(args: { query: ListQueryInput; context: CrudReadHookContext }): Promise<void | { query?: ListQueryInput }>
    projectResult?(args: { result: CrudListResult<TListRow>; context: CrudReadHookContext }): Promise<CrudListResult<TListRow>>
  }
  detail?: {
    projectResult?(args: { row: TRow; context: CrudReadHookContext }): Promise<TDetailRow>
  }
  create?: {
    transformInput?(args: { input: TCreateBody; context: CrudMutationHookContext }): Promise<TCreateBody | void>
    projectCommittedResult?(args: { input: TCreateBody; originalInput?: TCreateBody; result: TRow; context: CrudMutationHookContext }): Promise<TRow | void>
    afterCommit?(args: { input: TCreateBody; result: TRow; operation: PostCommitContext; context: CrudPostCommitHookContext }): Promise<void>
  }
  update?: {
    transformInput?(args: { existing: TRow; patch: TUpdateBody; context: CrudMutationHookContext }): Promise<TUpdateBody | void>
    projectCommittedResult?(args: { existing: TRow; patch: TUpdateBody; originalPatch?: TUpdateBody; result: TRow; context: CrudMutationHookContext }): Promise<TRow | void>
    afterCommit?(args: { existing: TRow; patch: TUpdateBody; result: TRow; operation: PostCommitContext; context: CrudPostCommitHookContext }): Promise<void>
  }
  delete?: {
    beforeDelete?(args: { existing: TRow; context: CrudMutationHookContext }): Promise<void>
    afterCommit?(args: { existing: TRow; operation: PostCommitContext; context: CrudPostCommitHookContext }): Promise<void>
  }
}

export interface EntityListDefaults {
  sortColumn?: string
  sortDesc?: boolean
}

export interface EntityOptimisticConcurrencyConfig<TRow> {
  versionField?: keyof TRow & string
}

export interface EntityDefinitionInput<
  TRow,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow = TRow,
  TDetailRow = TRow,
  TIdParams = unknown,
  TListQuery = unknown,
> {
moduleKey: string
  entity: EntityDescriptor<TRow>
  entityScope: EntityScopeDefinition
  policy: CapabilityCheckConfig
  validation?: EntityValidationSchemas<TIdParams, TCreateBody, TUpdateBody, TListQuery>
  audit?: false | Partial<EntityAuditConfig>
  cache?: false | Partial<EntityCacheConfig>
  idempotency?: false | EntityIdempotencyConfig
  rateLimit?: EntityRateLimitConfig
  crud?: CrudLifecycle<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow>
  routes?: Partial<EntityRouteConfig>
  searchableColumns?: string[]
  queryLimits?: EntityQueryLimits
  searchStrategy?: EntitySearchStrategy
  filterableColumns?: string[]
  sortableColumns?: string[]
  filterFieldMeta?: Record<string, FilterFieldMeta>
  listDefaults?: EntityListDefaults
  /**
   * Optimistic concurrency. Required when `update` or `delete` routes are
   * enabled (see {@link EntityRouteConfig}); the effective concurrency field
   * must be a declared numeric field.
   */
  optimisticConcurrency?: EntityOptimisticConcurrencyConfig<TRow>
  lifecycle?: EntityLifecyclePolicy<TRow>
  dataClassification?: FieldDataClassifications<TRow>
  durableCodecs?: DurableCodecRegistry
  persistenceSource?: string
}

export interface EntityDefinition<
  TRow,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow = TRow,
  TDetailRow = TRow,
  TIdParams = unknown,
  TListQuery = unknown,
> {
  moduleKey: string
  entity: EntityDescriptor<TRow>
  entityScope: EntityScopeDefinition
  policy: CapabilityCheckConfig
  validation: EntityValidationSchemas<TIdParams, TCreateBody, TUpdateBody, TListQuery>
  audit: EntityAuditSetting
  cache: EntityCacheSetting
  idempotency: EntityIdempotencySetting
  rateLimit: EntityRateLimitConfig
  crud: CrudLifecycle<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow>
  routes: EntityRouteConfig
  searchableColumns: string[]
  queryLimits?: EntityQueryLimits
  searchStrategy?: EntitySearchStrategy
  filterableColumns: string[]
  sortableColumns: string[]
  filterFieldMeta?: Record<string, FilterFieldMeta>
  listDefaults?: EntityListDefaults
  optimisticConcurrency?: EntityOptimisticConcurrencyConfig<TRow>
  lifecycle: EntityLifecyclePolicy<TRow>
  dataClassification: FieldDataClassifications<TRow>
  durableCodecs: DurableCodecRegistry
  persistenceSource: string
}

/** Runtime marker preventing CRUD construction from accepting an unvalidated object. */
export type BrandedEntityDefinition<
  TRow,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow = TRow,
  TDetailRow = TRow,
  TIdParams = unknown,
  TListQuery = unknown,
> = EntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery> & {
  readonly [ENTITY_DEFINITION_BRAND]: true
}

const DEFAULT_AUDIT_EMIT_ON: Array<"create" | "update" | "delete"> = ["create", "update", "delete"]

function normalizeRoutes(routes?: Partial<EntityRouteConfig>): EntityRouteConfig {
  return {
    list: routes?.list !== false,
    detail: routes?.detail !== false,
    create: routes?.create !== false,
    update: routes?.update !== false,
    delete: routes?.delete !== false,
  }
}

/**
 * Canonicalizes a capability policy at definition time. `resolveCapabilityKey`
 * rejects configs that claim both branches (unsound runtime casts), so the
 * stored policy (and therefore the derived capability mode used by the CRUD
 * handlers) is always exactly one of `{ customCapabilityKey }` or
 * `{ skipCapabilityCheck: true }`.
 */
function normalizeCapabilityPolicy(config: CapabilityCheckConfig): CapabilityCheckConfig {
  const resolved = resolveCapabilityKey(config)
  return resolved.enabled ? { customCapabilityKey: resolved.key! } : { skipCapabilityCheck: true }
}

/**
 * Default cache tag and key prefix: `entity:` + defaultEntityNamespace (`entity:${moduleKey}:${name}`,
 * or `entity:${moduleKey}:${namespace}:${name}` for an entity with a persistence namespace).
 *
 * Format history: `${moduleKey}:${namespace}:${name}` (earlier this release)
 * could equal a tenant-owned tag `tenant:<len>:<tenantId>` — moduleKey
 * "tenant", namespace "1", name "x" gave "tenant:1:x", which a tenant-scoped
 * batch for tenant "x" was allowed to advance. The reserved "entity:" prefix
 * keeps defaults disjoint from tenant tags by construction. Upgrading changes
 * every default prefix/tag once (one cold cache); explicit configuration is
 * unaffected.
 */
const ENTITY_CACHE_NAMESPACE_PREFIX = "entity:"
/** Prefix of tenant-owned cache tags (see encodeTenantCacheTag in persistence/scoped.ts). */
const TENANT_CACHE_TAG_PREFIX = "tenant:"

function defaultCacheNamespace(moduleKey: string, entity: { readonly name: string; readonly namespace?: string }): string {
  return `${ENTITY_CACHE_NAMESPACE_PREFIX}${defaultEntityNamespace(moduleKey, entity)}`
}

export function defineEntity<
  TRow,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow = TRow,
  TDetailRow = TRow,
  TIdParams = unknown,
  TListQuery = unknown,
>(
  input: EntityDefinitionInput<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery>,
): CompiledEntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery> {
  if (input.audit && Object.hasOwn(input.audit, "enabled")) throw new ConfigurationError(`Entity "${input.entity.name}" audit must use false or a configuration object without enabled.`)
  // A global entity tag in the tenant tag namespace could be advanced by that tenant's atomic batches.
  if (input.cache && typeof input.cache.tag === "string" && input.cache.tag.startsWith(TENANT_CACHE_TAG_PREFIX)) throw new ConfigurationError(`Entity "${input.entity.name}" cache tag must not start with the reserved "${TENANT_CACHE_TAG_PREFIX}" prefix.`)
  if (input.cache && Object.hasOwn(input.cache, "enabled")) throw new ConfigurationError(`Entity "${input.entity.name}" cache must use false or a configuration object without enabled.`)
  if (input.idempotency && Object.hasOwn(input.idempotency, "required")) throw new ConfigurationError(`Entity "${input.entity.name}" idempotency must use false or a configuration object without required.`)
  const routes = normalizeRoutes(input.routes)
  const concurrencyVersionField = input.optimisticConcurrency?.versionField
  if (input.entity.versionField !== undefined &&
      concurrencyVersionField !== undefined &&
      input.entity.versionField !== concurrencyVersionField) {
    throw new ConfigurationError(`Entity "${input.entity.name}" has conflicting concurrency version fields.`)
  }
  const versionField = input.entity.versionField ?? concurrencyVersionField
  const normalizedEntity: EntityDescriptor<TRow> = {
    ...input.entity,
    ...(input.entity.primaryKey !== undefined || Object.prototype.hasOwnProperty.call(input.entity.fields, "id")
      ? { primaryKey: input.entity.primaryKey ?? ("id" as keyof TRow & string) }
      : {}),
    ...(versionField !== undefined ? { versionField } : {}),
    fields: cloneAndFreezeDefinition(input.entity.fields),
    ...(input.entity.immutableFields !== undefined ? { immutableFields: [...input.entity.immutableFields] } : {}),
  }
  const normalized: EntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery> = {
    moduleKey: input.moduleKey,
    entity: normalizedEntity,
    entityScope: cloneAndFreezeDefinition(input.entityScope),
    policy: cloneAndFreezeDefinition(normalizeCapabilityPolicy(input.policy)),
    validation: cloneAndFreezeDefinition(input.validation ?? {}),
    audit: input.audit === false || input.audit === undefined ? false : {
      resource: input.audit?.resource ?? input.entity.name,
      emitOn: input.audit?.emitOn ? [...input.audit.emitOn] : [...DEFAULT_AUDIT_EMIT_ON],
      includeValues: input.audit?.includeValues ?? true,
      readAudit: input.audit?.readAudit ?? false,
      ...(input.audit?.required !== undefined ? { required: input.audit.required } : {}),
      ...(input.audit?.auditGuarantee !== undefined ? { auditGuarantee: input.audit.auditGuarantee } : {}),
      ...(input.audit?.fallbackAuditGuarantee !== undefined ? { fallbackAuditGuarantee: input.audit.fallbackAuditGuarantee } : {}),
      ...(input.audit?.requiredStateSemantics !== undefined ? { requiredStateSemantics: input.audit.requiredStateSemantics } : {}),
      ...(input.audit?.fieldClassification ? { fieldClassification: { ...input.audit.fieldClassification } } : {}),
    },
    cache: input.cache === false || input.cache === undefined ? false : {
      tag: input.cache?.tag ?? defaultCacheNamespace(input.moduleKey, input.entity),
      keyPrefix: input.cache?.keyPrefix ?? defaultCacheNamespace(input.moduleKey, input.entity),
    },
    idempotency: input.idempotency === false ? false : cloneAndFreezeDefinition(input.idempotency ?? {}),
    rateLimit: input.rateLimit ? cloneAndFreezeDefinition(input.rateLimit) : {},
    crud: cloneAndFreezeDefinition(input.crud ?? {}),
    routes,
    searchableColumns: input.searchableColumns ? [...input.searchableColumns] : [],
    ...(input.queryLimits !== undefined ? { queryLimits: { ...input.queryLimits } } : {}),
    ...(input.searchStrategy !== undefined ? { searchStrategy: { ...input.searchStrategy } } : {}),
    filterableColumns: input.filterableColumns ? [...input.filterableColumns] : [],
    sortableColumns: input.sortableColumns ? [...input.sortableColumns] : [],
    ...(input.filterFieldMeta !== undefined ? { filterFieldMeta: cloneAndFreezeDefinition(input.filterFieldMeta) } : {}),
    ...(input.listDefaults !== undefined ? { listDefaults: cloneAndFreezeDefinition(input.listDefaults) } : {}),
    ...(input.optimisticConcurrency !== undefined ? { optimisticConcurrency: cloneAndFreezeDefinition(input.optimisticConcurrency) } : {}),
    lifecycle: cloneAndFreezeDefinition(input.lifecycle ?? { kind: "hard-delete" }),
    dataClassification: cloneAndFreezeDefinition(input.dataClassification ?? {}) as FieldDataClassifications<TRow>,
    durableCodecs: cloneAndFreezeDefinition(input.durableCodecs ?? {}),
    persistenceSource: input.persistenceSource ?? "primary",
  }

  Object.defineProperty(normalized, ENTITY_DEFINITION_BRAND, { value: true, enumerable: false })
  registerEntityDefinition(normalized)
  return compileEntity(normalized as BrandedEntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery>)
}
