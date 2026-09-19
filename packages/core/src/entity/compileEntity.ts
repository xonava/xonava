import { ConfigurationError } from "../domain"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"
import type { RuntimeCapabilities } from "../bootstrap/runtimeCapabilities"
import type {
  BrandedEntityDefinition,
  CrudRouteKey,
  EntityDefinition,
  EntityDefinitionInput,
} from "./defineEntity"
import { ENTITY_DEFINITION_BRAND, isEntityDefinition, registerEntityDefinition } from "./brands"
import { validateEntity } from "./validateEntity"
import { compileEntityLifecycle, type CompiledEntityLifecycle } from "./lifecycle"
import { compileEntityScope, type CompiledEntityScope } from "./entityScope"
import { DEFAULT_QUERY_BUDGET, type QueryBudget } from "../query/queryBudget"
import { fieldsAllowedForPurpose, type DataClassification } from "../domain/dataClassification"
import type { AuditFieldClassifications } from "../events/durability/audit"
import type { SearchPort } from "../query/search"

export const COMPILED_ENTITY_DEFINITION_BRAND: unique symbol = Symbol("core.compiledEntityDefinition")
const compiledEntities = new WeakSet<object>()

/** Public runtime guard that keeps the compiler's brand itself package-internal. */
export function isCompiledEntityDefinition(value: unknown): boolean {
  return !!value && typeof value === "object"
    && compiledEntities.has(value)
}

export type EntityRuntimeRequirements = Readonly<{
  cacheAdapter: boolean
  auditSink: boolean
  outboxSink: boolean
  rateLimitStore: boolean
  idempotencyPort: boolean
  searchPortKey?: string
  runtimeCapabilities: readonly (keyof RuntimeCapabilities)[]
}>

export type EntityCompilationDependencies = {
  cacheAdapter?: unknown
  auditSinkFactory?: unknown
  outboxSinkFactory?: unknown
  rateLimitStore?: unknown
  idempotencyPort?: unknown
  searchPorts?: Readonly<Record<string, SearchPort>>
  runtimeCapabilities?: RuntimeCapabilities
}

export type CompiledEntityDefinition<
  TRow,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow = TRow,
  TDetailRow = TRow,
  TIdParams = unknown,
  TListQuery = unknown,
> = EntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery> & {
  readonly primaryKey: keyof TRow & string
  readonly versionField?: keyof TRow & string
  readonly tenantField?: keyof TRow & string
  readonly requiredRuntimeRequirements: EntityRuntimeRequirements
  readonly compiledScope: CompiledEntityScope
  readonly compiledPersistence: { readonly source: string; readonly access: "read-write" }
  readonly compiledQuery: { readonly budget: QueryBudget; readonly filterableFields: readonly string[]; readonly sortableFields: readonly string[]; readonly searchableFields: readonly string[] }
  readonly compiledPagination: { readonly strategy: "offset" | "cursor"; readonly maxOffset?: number }
  readonly compiledAudit: { readonly enabled: boolean; readonly guarantee: "atomic" | "durable" | "best-effort"; readonly fieldClassification: AuditFieldClassifications }
  readonly compiledCache: { readonly enabled: boolean; readonly guarantee: "generation-qualified" | "none" }
  readonly compiledIdempotency: { readonly required: boolean; readonly namespace: string }
  readonly compiledRateQuota: { readonly routes: readonly string[] }
  readonly compiledFieldProtections: { readonly immutable: readonly string[]; readonly classified: Readonly<Record<string, string>> }
  readonly compiledLifecycle: CompiledEntityLifecycle
  readonly requiredCapabilityManifest: EntityRuntimeRequirements
  readonly [ENTITY_DEFINITION_BRAND]: true
  readonly [COMPILED_ENTITY_DEFINITION_BRAND]: true
}

const routesFor = (definition: EntityDefinitionInput<never>, route?: CrudRouteKey) =>
  route === undefined || definition.routes?.[route] !== false

function requiredRuntimeRequirements(definition: EntityDefinitionInput<never>): EntityRuntimeRequirements {
  const rateLimitStore = Object.entries(definition.rateLimit ?? {}).some(([route, config]) =>
    routesFor(definition, route as CrudRouteKey) && (config as { consistency?: string }).consistency === "atomic")
  const bestEffortRateLimit = Object.entries(definition.rateLimit ?? {}).some(([route, config]) =>
    routesFor(definition, route as CrudRouteKey) && (config as { consistency?: string }).consistency === "best-effort")
  const mutating = routesFor(definition, "create") || routesFor(definition, "update") || routesFor(definition, "delete")
  return {
    cacheAdapter: (definition.cache !== false && definition.cache !== undefined) || bestEffortRateLimit,
    auditSink: definition.audit !== false && definition.audit !== undefined,
    outboxSink: definition.audit !== false && definition.audit !== undefined && definition.audit.auditGuarantee === "durable",
    rateLimitStore,
    idempotencyPort: mutating && definition.idempotency !== false,
    ...(definition.searchStrategy?.kind === "fullText" ? { searchPortKey: definition.searchStrategy.portKey } : {}),
    runtimeCapabilities: definition.cache !== false && definition.cache !== undefined ? ["cache"] : [],
  }
}

function assertDependencies(name: string, requirements: EntityRuntimeRequirements, dependencies?: EntityCompilationDependencies): void {
  if (!dependencies) {
    return
  }
  const missing: string[] = []
  if (requirements.cacheAdapter && !dependencies.cacheAdapter) missing.push("cacheAdapter")
  if (requirements.auditSink && !dependencies.auditSinkFactory) missing.push("auditSinkFactory")
  if (requirements.outboxSink && !dependencies.outboxSinkFactory) missing.push("outboxSinkFactory")
  if (requirements.rateLimitStore && !dependencies.rateLimitStore) missing.push("rateLimitStore")
  if (requirements.idempotencyPort && !dependencies.idempotencyPort) missing.push("idempotencyPort")
  if (requirements.searchPortKey) {
    const port=dependencies.searchPorts?.[requirements.searchPortKey]
    if (!port || port.capability.portKey !== requirements.searchPortKey) missing.push(`searchPorts.${requirements.searchPortKey}`)
  }
  for (const capability of requirements.runtimeCapabilities) {
    if (!dependencies.runtimeCapabilities?.[capability]) missing.push(`runtimeCapabilities.${capability}`)
  }
  if (missing.length > 0) throw new ConfigurationError(`Entity "${name}" is missing runtime dependencies: ${missing.join(", ")}.`)
}

export function compileEntity<
  TRow,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow = TRow,
  TDetailRow = TRow,
  TIdParams = unknown,
  TListQuery = unknown,
>(
  definition: BrandedEntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery>,
  options?: { dependencies?: EntityCompilationDependencies },
): CompiledEntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery> {
  if (!isEntityDefinition(definition)) {
    throw new ConfigurationError("compileEntity() requires an entity definition created by defineEntity().")
  }
  if (isCompiledEntityDefinition(definition) && options?.dependencies) {
    const compiled = definition as unknown as CompiledEntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery>
    assertDependencies(compiled.entity.name, compiled.requiredRuntimeRequirements, options.dependencies)
    return compiled
  }
  const requirements = requiredRuntimeRequirements(definition as unknown as EntityDefinitionInput<never>)
  assertDependencies(definition.entity.name, requirements, options?.dependencies)
  const lifecycle = compileEntityLifecycle(definition.lifecycle)
  const dataClassification = {
    ...Object.fromEntries(Object.entries(definition.entity.fields as Record<string, { classification?: DataClassification }>).flatMap(([field, descriptor]) => descriptor.classification ? [[field, descriptor.classification]] : [])),
    ...definition.dataClassification,
  } as Record<string, DataClassification>
  const auditFieldClassification = Object.fromEntries(Object.entries(dataClassification).map(([field, classification]) => [field, classification === "restricted" ? "omit" : classification === "confidential" ? "mask" : "include"])) as AuditFieldClassifications
  const compiledScope = compileEntityScope<TRow>(
    definition.entityScope.kind === "tenant"
      ? { kind: "tenant" as const, ...(definition.entity.tenantField ? { field: definition.entity.tenantField } : {}) }
      : definition.entityScope as import("./entityScope").EntityScopeDefinition<TRow>,
    definition.entity.tenantField,
  )
  const candidate = {
    ...definition,
    entity: {
      ...definition.entity,
      immutableFields: [...new Set([...(definition.entity.immutableFields ?? []), ...lifecycle.protectedFields])] as (keyof TRow & string)[],
      ...(lifecycle.activeRowFilter ? { activeRowFilter: lifecycle.activeRowFilter } : {}),
      deleteStrategy: lifecycle.deleteStrategy,
      ...(lifecycle.deletedAtField ? { deletedAtField: lifecycle.deletedAtField as keyof TRow & string } : {}),
    },
    [ENTITY_DEFINITION_BRAND]: true,
    primaryKey: definition.entity.primaryKey as keyof TRow & string,
    ...(definition.entity.versionField !== undefined ? { versionField: definition.entity.versionField } : {}),
    ...(definition.entity.tenantField !== undefined ? { tenantField: definition.entity.tenantField } : {}),
    requiredRuntimeRequirements: requirements,
    compiledScope,
    compiledPersistence: { source: definition.persistenceSource, access: "read-write" as const },
    compiledQuery: { budget: { ...DEFAULT_QUERY_BUDGET, ...definition.queryLimits }, filterableFields: [...definition.filterableColumns], sortableFields: [...definition.sortableColumns], searchableFields: definition.searchableColumns.filter(field => fieldsAllowedForPurpose(dataClassification, "search").includes(field) || dataClassification[field] === undefined) },
    compiledPagination: { strategy: "offset" as const, ...(definition.queryLimits?.maxOffset !== undefined ? { maxOffset: definition.queryLimits.maxOffset } : {}) },
    compiledAudit: { enabled: definition.audit !== false, guarantee: definition.audit === false ? "best-effort" : definition.audit.auditGuarantee ?? "best-effort", fieldClassification: auditFieldClassification },
    compiledCache: { enabled: definition.cache !== false, guarantee: definition.cache !== false ? "generation-qualified" as const : "none" as const },
    compiledIdempotency: { required: definition.idempotency !== false, namespace: definition.idempotency === false ? `${definition.moduleKey}:${definition.entity.name}` : definition.idempotency.namespace ?? `${definition.moduleKey}:${definition.entity.name}` },
    compiledRateQuota: { routes: Object.keys(definition.rateLimit).sort() },
    compiledFieldProtections: { immutable: [...new Set([...(definition.entity.immutableFields ?? []), ...lifecycle.protectedFields])], classified: dataClassification },
    compiledLifecycle: lifecycle,
    requiredCapabilityManifest: requirements,
  }
  Object.defineProperty(candidate, ENTITY_DEFINITION_BRAND, { value: true, enumerable: false })
  Object.defineProperty(candidate, COMPILED_ENTITY_DEFINITION_BRAND, { value: true, enumerable: false })
  const compiled = cloneAndFreezeDefinition(candidate) as unknown as CompiledEntityDefinition<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery>
  validateEntity(compiled as unknown as EntityDefinitionInput<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery>, compiled.routes)
  registerEntityDefinition(compiled)
  compiledEntities.add(compiled)
  return compiled
}
