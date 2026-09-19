import { ConfigurationError } from "core/domain"
import { isCompiledEntityDefinition, type CompiledEntityDefinition } from "core/entity"
import type { AuditSink, OutboxSink } from "core/events"
import type { CacheAdapter } from "core/cache"
import type { PersistenceProvider } from "core/persistence"
import type { RuntimeCapabilities } from "core/bootstrap"
import type { RequestContext } from "core/domain"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "../server"
import { createCrudHandlersInternal } from "./createCrudHandlers"
import type { CrudScopeConfig } from "./createFrameworkWriteHandler"

type SelectableRow = Record<string, unknown>

export interface CrudRuntime {
  adapterDeps: FrameworkAdapterDeps
  requestNormalization: FrameworkRequestNormalization
  scope: CrudScopeConfig
  createPersistence: (context: RequestContext) => PersistenceProvider
  getCacheAdapter: () => Promise<CacheAdapter>
  auditSinkFactory?: (context: RequestContext, persistence?: PersistenceProvider) => AuditSink
  outboxSinkFactory?: (context: RequestContext, persistence?: PersistenceProvider) => OutboxSink
  runtimeCapabilities?: RuntimeCapabilities
}

export function CRUD<
  TRow extends SelectableRow,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow extends SelectableRow = TRow,
  TDetailRow extends SelectableRow = TRow,
  TIdParams = unknown,
  TListQuery = unknown,
>(
  definition: CompiledEntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery>,
  runtime: CrudRuntime,
) {
  if (!isCompiledEntityDefinition(definition)) {
    throw new ConfigurationError("CRUD() requires an entity definition created by defineEntity().")
  }
  const compiled = definition
  if (!compiled.policy || typeof compiled.policy !== "object" ||
      (compiled.policy.skipCapabilityCheck !== true && typeof compiled.policy.customCapabilityKey !== "string") ||
      (compiled.policy.skipCapabilityCheck === true && compiled.policy.customCapabilityKey !== undefined)) {
    throw new ConfigurationError(`Entity "${compiled.entity.name}" has an invalid capability configuration.`)
  }
  if (compiled.audit !== false && !runtime.auditSinkFactory) {
    throw new ConfigurationError(
      `Entity "${compiled.entity.name}" has audit enabled but no auditSinkFactory was provided to CRUD().`,
    )
  }
  if (compiled.audit !== false && compiled.audit.auditGuarantee === "durable" && !runtime.outboxSinkFactory) {
    throw new ConfigurationError(
      `Entity "${compiled.entity.name}" configures durable audit guarantee without an outboxSinkFactory in CRUD().`,
    )
  }

  return createCrudHandlersInternal({
    adapterDeps: runtime.adapterDeps,
    requestNormalization: runtime.requestNormalization,
    scope: runtime.scope,
     moduleKey: compiled.moduleKey,
     entity: compiled.entity,
     entityScope: compiled.entityScope,
     policy: compiled.policy,
     cache: compiled.cache === false ? { enabled: false, tag: compiled.entity.name, keyPrefix: compiled.entity.name } : { enabled: true, ...compiled.cache },
    getCacheAdapter: runtime.getCacheAdapter,
    ...(runtime.adapterDeps.getRateLimitStore
      ? { getRateLimitStore: runtime.adapterDeps.getRateLimitStore }
      : {}),
     createPersistence: runtime.createPersistence,
      ...(runtime.auditSinkFactory ? { auditSinkFactory: runtime.auditSinkFactory } : {}),
      ...(runtime.outboxSinkFactory ? { outboxSinkFactory: runtime.outboxSinkFactory } : {}),
      runtimeCapabilities: runtime.runtimeCapabilities ?? { deferredExecution: false, cache: false },
     validation: compiled.validation,
     rateLimit: compiled.rateLimit,
     crud: compiled.crud,
     routes: compiled.routes,
     audit: compiled.audit === false ? { enabled: false, resource: compiled.entity.name } : { enabled: true, ...compiled.audit, fieldClassification: compiled.audit.fieldClassification ?? compiled.compiledAudit.fieldClassification },
     searchableColumns: compiled.searchableColumns,
     ...(compiled.queryLimits ? { queryLimits: compiled.queryLimits } : {}),
     ...(compiled.searchStrategy ? { searchStrategy: compiled.searchStrategy } : {}),
     filterableColumns: compiled.filterableColumns,
      ...(compiled.filterFieldMeta ? { filterFieldMeta: compiled.filterFieldMeta } : {}),
      ...(compiled.listDefaults ? { listDefaults: compiled.listDefaults } : {}),
      ...(compiled.optimisticConcurrency ? { optimisticConcurrency: compiled.optimisticConcurrency } : {}),
  })
}
