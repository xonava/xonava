import { z } from "zod"
import type { AuditSink, OutboxSink } from "@xonava/core/events"
import type { CacheAdapter } from "@xonava/core/cache"
import type { PersistenceProvider } from "@xonava/core/persistence"
import type { RuntimeCapabilities } from "@xonava/core/bootstrap"
import type { ValidationSchema } from "@xonava/core/kernel"
import type { EntityVersion } from "@xonava/core/serialization"
import type {
  CapabilityCheckConfig,
  CrudLifecycle,
  EntityScopeDefinition,
} from "@xonava/core/entity"
import type { EntityDescriptor } from "@xonava/core/persistence"
import type { RequestContext } from "@xonava/core/domain"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "../../server"
import type {
  CrudScopeConfig,
  ScopedFrameworkValidatedContext,
} from "../createFrameworkWriteHandler"
import type { FilterFieldMeta } from "@xonava/core/domain"
import type { CursorIntegrityPort } from "@xonava/core/query"

export type SelectableRow = Record<string, unknown>
export type AuditObject = Record<string, unknown>

export type CreateOperationInput<TCreateBody> = {
  body: TCreateBody
  originalBody: TCreateBody
  id: string
}
export type UpdateOperationInput<TRow, TUpdateBody> = {
  id: string
  patch: TUpdateBody
  originalPatch: TUpdateBody
  existing: TRow
  expectedVersion?: EntityVersion
}
export type DeleteOperationInput<TRow> = { id: string; existing: TRow; expectedVersion?: EntityVersion }
export type MutationOutsideReadScope = {
  success: true
  reason: "CREATED_OUTSIDE_READ_SCOPE" | "UPDATED_OUTSIDE_READ_SCOPE"
}
export type MutationResult<TRow> = { record: TRow } | MutationOutsideReadScope

export type RateLimitConfigs = {
  list?: import("@xonava/core/entity").EntityRateLimitSetting
  detail?: import("@xonava/core/entity").EntityRateLimitSetting
  create?: import("@xonava/core/entity").EntityRateLimitSetting
  update?: import("@xonava/core/entity").EntityRateLimitSetting
  delete?: import("@xonava/core/entity").EntityRateLimitSetting
}
export type ValidationSchemas = {
  idParams?: ValidationSchema
  createBody?: ValidationSchema
  updateBody?: ValidationSchema
  listQuery?: ValidationSchema
}
export interface AuditConfig {
  resource: string
  enabled?: boolean
  emitOn?: ("create" | "update" | "delete")[]
  includeValues?: boolean
  readAudit?: boolean
  fieldClassification?: import("@xonava/core/events").AuditFieldClassifications
  required?: boolean
  auditGuarantee?: "atomic" | "durable" | "best-effort"
  requiredStateSemantics?: "committed-state"
}
export type ListDefaults = { sortColumn?: string; sortDesc?: boolean }
export type ListPaginationConfig =
  | { strategy: "offset" }
  | { strategy: "cursor"; integrity: CursorIntegrityPort; uniqueFields: readonly string[]; nullableFields?: readonly string[]; maxCursorBytes?: number; /** Opt-in cursor lifetime in milliseconds; issued cursors then carry an integrity-protected expiry. */ cursorTtlMs?: number }
export type OptimisticConcurrencyConfig<TRow extends SelectableRow> = {
  versionField?: keyof TRow & string
}
export interface CrudRoutesConfig {
  list: boolean
  detail: boolean
  create: boolean
  update: boolean
  delete: boolean
}

export type EntityQueryLimitsWithBytes = import("@xonava/core/entity").EntityQueryLimits & {
  maxFilterJsonBytes?: number
  maxSortJsonBytes?: number
  maxFilterValueBytes?: number
}

export interface CrudOptions<
  TRow extends SelectableRow,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow extends SelectableRow = TRow,
  TDetailRow extends SelectableRow = TRow,
> {
  adapterDeps: FrameworkAdapterDeps
  requestNormalization: FrameworkRequestNormalization
  scope: CrudScopeConfig
  moduleKey: string
  entity: EntityDescriptor<TRow>
  entityScope?: EntityScopeDefinition
  policy: CapabilityCheckConfig
  cache: { enabled?: boolean; tag: string; keyPrefix: string }
  getCacheAdapter: () => Promise<CacheAdapter>
  getRateLimitStore?: () => Promise<import("@xonava/core/rate-limit").RateLimitStore>
  createPersistence: (context: RequestContext) => PersistenceProvider
  auditSinkFactory?: (context: RequestContext, persistence?: PersistenceProvider) => AuditSink
  outboxSinkFactory?: (context: RequestContext, persistence?: PersistenceProvider) => OutboxSink
  runtimeCapabilities: RuntimeCapabilities
  validation?: ValidationSchemas
  rateLimit?: RateLimitConfigs
  crud?: CrudLifecycle<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow>
  routes?: Partial<CrudRoutesConfig>
  audit?: AuditConfig
  searchableColumns?: string[]
  queryLimits?: EntityQueryLimitsWithBytes
  searchStrategy?: import("@xonava/core/entity").EntitySearchStrategy
  filterableColumns?: string[]
  sortableColumns?: string[]
  filterFieldMeta?: Record<string, FilterFieldMeta>
  listDefaults?: ListDefaults
  pagination?: ListPaginationConfig
  optimisticConcurrency?: OptimisticConcurrencyConfig<TRow>
}

/** Upper bound on the offset page number accepted from callers. */
export const MAX_LIST_PAGE = 1_000_000

export const defaultListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(MAX_LIST_PAGE).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  sorting: z.string().max(64 * 1024).optional(),
  filters: z.string().max(64 * 1024).optional(),
  cursor: z.string().max(32 * 1024).optional(),
  before: z.string().max(32 * 1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  fields: z.string().max(16 * 1024).optional(),
  consistency: z.enum(["strong", "session", "eventual"]).optional(),
})
export const defaultIdParams = z.object({ id: z.string().uuid() }).strict()
export type ReadQuery = {
  page: number
  pageSize: number
  sorting?: string
  filters?: string
  cursor?: string
  before?: string
  limit?: number
  fields?: string
  consistency?: import("@xonava/core/query").ReadConsistency
}

export type CrudShared<
  TRow extends SelectableRow,
  TCreateBody,
  TUpdateBody,
  TListRow extends SelectableRow,
  TDetailRow extends SelectableRow,
> = {
  options: CrudOptions<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow>
  entity: EntityDescriptor<TRow>
  deps: FrameworkAdapterDeps
  idParamsSchema: ValidationSchema
  capabilityMode: { enabled: boolean; key: string | undefined }
  writeCapabilityConfig: CapabilityCheckConfig
  routes: CrudRoutesConfig
  writeRuntimeCapabilities: RuntimeCapabilities
  invalidateTags?: (
    validated: ScopedFrameworkValidatedContext,
    context: RequestContext
  ) => string[] | Promise<string[]>
  buildReadTags: (context: RequestContext) => string[]
  resolveDefaultSort: () =>
    import("@xonava/core/query").SortSpec[] | undefined
  enforceReadRateLimit: (
    route: "list" | "detail",
    config:
      import("@xonava/core/entity").EntityRateLimitSetting | undefined,
    request: Request,
    context: RequestContext
  ) => Promise<void>
  enforceReadAccess: (
    request: Request,
    context: RequestContext
  ) => Promise<import("../../server").AbacBundle | undefined>
  buildReadScope: (bundle: import("../../server").AbacBundle | undefined) => {
    filter:
      import("@xonava/core/domain").PredicateNode | undefined
    cacheScopeKey?: string
  }
  resolveReadScopeForContext: (context: RequestContext) => Promise<{
    filter:
      import("@xonava/core/domain").PredicateNode | undefined
    cacheScopeKey?: string
  }>
}
