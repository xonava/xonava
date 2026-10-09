import { ConfigurationError } from "../domain"
import type { CrudRouteKey, EntityDefinitionInput, EntityRouteConfig } from "./defineEntity"
import type { RateLimitConfig, RateLimitPolicy } from "../rate-limit/rateLimit"
import { isRuntimeCapability } from "../bootstrap/runtimeCapabilities"
import { assertCapabilityConfigValid, resolveCapabilityKey } from "./capabilityCheck"
import { entityFieldClassifications, queryableFieldFilter } from "./queryableFields"
import { DEFAULT_QUERY_BUDGET } from "../query/queryBudget"

/** Every key an entity may declare in `queryLimits`; anything else is a configuration error. */
const ENTITY_QUERY_LIMIT_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_QUERY_BUDGET),
  "maxSearchableColumns",
  "maxOffset",
  "maxCount",
])

export function assertEntityQueryLimits(entityName: string, limits: unknown): void {
  if (limits === undefined) return
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new ConfigurationError(`Entity "${entityName}" has invalid query limits.`)
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!ENTITY_QUERY_LIMIT_KEYS.has(name)) {
      throw new ConfigurationError(`Entity "${entityName}" declares unknown query limit ${name}.`)
    }
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid query limit for ${name}.`)
    }
  }
}

function routeRequires(route: CrudRouteKey, routes: EntityRouteConfig) {
  return routes[route] !== false
}

export function validateEntity<
  TRow,
  TCreateBody = TRow,
  TUpdateBody = Partial<TRow>,
  TListRow = TRow,
  TDetailRow = TRow,
  TIdParams = unknown,
  TListQuery = unknown,
>(
  input: EntityDefinitionInput<TRow, TCreateBody, TUpdateBody, TListRow, TDetailRow, TIdParams, TListQuery>,
  routes: EntityRouteConfig,
): void {
  const entityName = input.entity.name
  const fields = input.entity.fields
  const fieldNames = new Set(fields && typeof fields === "object" ? Object.keys(fields) : [])
  const requireText = (value: unknown, label: string) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid ${label}.`)
    }
  }
  const requireField = (value: unknown, label: string) => {
    requireText(value, label)
    if (!fieldNames.has(String(value))) {
      throw new ConfigurationError(`Entity "${entityName}" references unknown ${label} "${String(value)}".`)
    }
  }
  const validateFieldList = (values: readonly string[] | undefined, label: string) => {
    if (!values) return
    if (new Set(values).size !== values.length) {
      throw new ConfigurationError(`Entity "${entityName}" has duplicate ${label}.`)
    }
    for (const value of values) requireField(value, `${label} field`)
  }
  if (input.audit && Object.hasOwn(input.audit, "enabled")) throw new ConfigurationError(`Entity "${entityName}" audit must use false or a configuration object without enabled.`)
  if (input.cache && Object.hasOwn(input.cache, "enabled")) throw new ConfigurationError(`Entity "${entityName}" cache must use false or a configuration object without enabled.`)
  if (input.idempotency && Object.hasOwn(input.idempotency, "required")) throw new ConfigurationError(`Entity "${entityName}" idempotency must use false or a configuration object without required.`)

  if (!/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(input.moduleKey)) {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid module key.`)
  }

  requireText(entityName, "name")
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(entityName)) {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid name.`)
  }
  if (!fields || Object.keys(fields).length === 0) {
    throw new ConfigurationError(`Entity "${entityName}" must declare fields.`)
  }

  // P2-05: durability — every field descriptor must declare a valid type/format
  const ALLOWED_FIELD_TYPES = new Set(["string", "number", "boolean", "date", "json", "integer", "decimal", "datetime", "uuid", "enum", "custom"])
  const ALLOWED_FIELD_FORMATS = new Set(["text", "email", "phone", "date", "identifier", "json"])
  for (const [fieldName, descriptor] of Object.entries(fields as Record<string, unknown>)) {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid field descriptor for "${fieldName}".`)
    }
    const desc = descriptor as { type?: unknown; nullable?: unknown; format?: unknown; precision?: unknown; scale?: unknown; enumValues?: unknown; durableCodec?: unknown; classification?: unknown }
    if (typeof desc.type !== "string" || !ALLOWED_FIELD_TYPES.has(desc.type)) {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid field type for "${fieldName}".`)
    }
    if (desc.nullable !== undefined && typeof desc.nullable !== "boolean") {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid nullable flag for "${fieldName}".`)
    }
    if (desc.format !== undefined) {
      if (typeof desc.format !== "string" || !ALLOWED_FIELD_FORMATS.has(desc.format)) {
        throw new ConfigurationError(`Entity "${entityName}" has an invalid field format for "${fieldName}".`)
      }
    }
    if (desc.type === "integer" && desc.format !== undefined) throw new ConfigurationError(`Entity "${entityName}" integer field "${fieldName}" cannot declare a string format.`)
    if (desc.type === "decimal" && (!Number.isSafeInteger(desc.precision) || !Number.isSafeInteger(desc.scale) || Number(desc.precision) < 1 || Number(desc.scale) < 0 || Number(desc.scale) > Number(desc.precision))) throw new ConfigurationError(`Entity "${entityName}" has invalid decimal precision/scale for "${fieldName}".`)
    if (desc.type === "enum" && (!Array.isArray(desc.enumValues) || desc.enumValues.length === 0 || new Set(desc.enumValues).size !== desc.enumValues.length || desc.enumValues.some(value => typeof value !== "string" || value.length === 0))) throw new ConfigurationError(`Entity "${entityName}" has invalid enum values for "${fieldName}".`)
    if (desc.type === "custom") {
      const codec = typeof desc.durableCodec === "string" && input.durableCodecs && Object.hasOwn(input.durableCodecs, desc.durableCodec)
        ? input.durableCodecs[desc.durableCodec] as { encode?: unknown; decode?: unknown } | undefined
        : undefined
      if (!codec || typeof codec.encode !== "function" || typeof codec.decode !== "function") throw new ConfigurationError(`Entity "${entityName}" custom field "${fieldName}" requires a registered durable codec.`)
      // Fail closed: no persistence mapping applies durable codecs on write or
      // read yet, so a custom field would silently persist unencoded values.
      throw new ConfigurationError(`Entity "${entityName}" custom field "${fieldName}" is not yet supported: durable codecs are not applied by the persistence mapping.`)
    }
    if (desc.classification !== undefined && !["public", "internal", "confidential", "restricted"].includes(String(desc.classification))) throw new ConfigurationError(`Entity "${entityName}" has invalid data classification for "${fieldName}".`)
  }

  requireField(input.entity.primaryKey, "primary key")
  if (input.entity.tenantField) requireField(input.entity.tenantField, "tenant field")
  if (input.entity.versionField !== undefined) {
    requireField(input.entity.versionField, "version field")
    if (fields[input.entity.versionField]?.type !== "number") {
      throw new ConfigurationError(`Entity "${entityName}" requires version field "${String(input.entity.versionField)}" to have type "number".`)
    }
  }
  if (input.entityScope.kind === "application") requireField(input.entityScope.field, "application scope field")
  validateFieldList(input.entity.immutableFields, "immutable fields")
  validateFieldList(input.searchableColumns, "searchable")
  validateFieldList(input.filterableColumns, "filterable")
  validateFieldList(input.sortableColumns, "sortable")
  requireText(input.persistenceSource ?? "primary", "persistence source")
  for (const [field, classification] of Object.entries(input.dataClassification ?? {})) {
    requireField(field, "data classification field")
    if (!["public", "internal", "confidential", "restricted"].includes(String(classification))) throw new ConfigurationError(`Entity "${entityName}" has invalid data classification for "${field}".`)
  }

  const lifecycle = input.lifecycle ?? { kind: "hard-delete" as const }
  if (lifecycle.kind === "soft-delete") {
    requireField(lifecycle.deletedAtField, "soft-delete field")
    const descriptor = fields[lifecycle.deletedAtField]
    if (!descriptor?.nullable || !["date", "datetime"].includes(descriptor.type)) throw new ConfigurationError(`Entity "${entityName}" soft-delete field must be a nullable date or datetime.`)
    if (!input.entity.versionField && !input.optimisticConcurrency?.versionField) throw new ConfigurationError(`Entity "${entityName}" soft-delete lifecycle requires optimistic concurrency.`)
  } else if (lifecycle.kind === "append-only" && (routeRequires("update", routes) || routeRequires("delete", routes))) {
    throw new ConfigurationError(`Entity "${entityName}" append-only lifecycle cannot enable update or delete routes.`)
  } else if (lifecycle.kind !== "hard-delete" && lifecycle.kind !== "append-only") {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid lifecycle policy.`)
  }

  if ((input.entityScope.kind === "platform" || input.entityScope.kind === "system") && input.entityScope.acknowledged !== true) {
    throw new ConfigurationError(`Entity "${entityName}" must acknowledge entityScope kind "${input.entityScope.kind}".`)
  }

  const policy = input.policy
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid capability configuration.`)
  }
  assertCapabilityConfigValid(policy)
  const resolvedCapability = resolveCapabilityKey(policy)
  if (resolvedCapability.enabled && resolvedCapability.key !== undefined) {
    if (isRuntimeCapability(resolvedCapability.key) || resolvedCapability.key === "bypassAuthority") {
      throw new ConfigurationError(
        `Entity "${entityName}" declares capability key "${resolvedCapability.key}" which collides with a framework-reserved capability name.`,
      )
    }
  }

  if (input.listDefaults) {
    if (input.listDefaults.sortColumn !== undefined) {
      requireField(input.listDefaults.sortColumn, "default sort")
      // The default sort is applied without the caller asking, so it must obey
      // the same classification ceiling as caller-chosen sorts; otherwise
      // ordering and cursor values leak hidden fields.
      const queryable = queryableFieldFilter(entityFieldClassifications(fields, input.dataClassification))
      if ((input.sortableColumns && !input.sortableColumns.includes(input.listDefaults.sortColumn)) || !queryable(input.listDefaults.sortColumn)) {
        throw new ConfigurationError(
          `Entity "${entityName}" default sort column "${input.listDefaults.sortColumn}" must be declared in sortableColumns and be queryable under its data classification.`,
        )
      }
    }
    if (input.listDefaults.sortDesc !== undefined && typeof input.listDefaults.sortDesc !== "boolean") {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid default sort direction.`)
    }
  }

  if (input.optimisticConcurrency) {
    const concurrency = input.optimisticConcurrency
    const concurrencyVersionField = concurrency.versionField ?? input.entity.versionField
    requireField(concurrencyVersionField, "concurrency version")
    if (fields[concurrencyVersionField as keyof typeof fields]?.type !== "number") {
      throw new ConfigurationError(`Entity "${entityName}" requires concurrency version field "${String(concurrencyVersionField)}" to have type "number".`)
    }
    if (concurrency.versionField !== undefined && input.entity.versionField !== undefined && concurrency.versionField !== input.entity.versionField) {
      throw new ConfigurationError(`Entity "${entityName}" has conflicting concurrency version fields.`)
    }
  }

  for (const [route, config] of Object.entries(input.rateLimit ?? {})) {
    if (!["list", "detail", "create", "update", "delete"].includes(route)) {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid rate-limit route.`)
    }
    validateRateLimit(config, entityName, route)
  }

  if (input.entity.tenantField && input.entityScope.kind !== "tenant") {
    throw new ConfigurationError(
      `Entity "${input.entity.name}" declares tenantField "${String(input.entity.tenantField)}" but entityScope is not tenant. Remove tenantField if this entity is not tenant-scoped.`,
    )
  }

  if (!input.entity.tenantField && input.entityScope.kind === "tenant") {
    throw new ConfigurationError(
      `Entity "${input.entity.name}" requests tenant scoping but declares no tenantField.`,
    )
  }

  // Mandatory OCC for mutating routes (P1-03): update/delete routes run
  // read-then-write authorization; without a concrete numeric version field
  // the authorization snapshot is exposed to TOCTOU. The numeric-type
  // requirement is enforced by the versionField/optimisticConcurrency checks
  // above; here we require that at least one source actually declares the field.
  if (routeRequires("update", routes) || routeRequires("delete", routes)) {
    const concurrencyVersionField = input.entity.versionField ?? input.optimisticConcurrency?.versionField
    if (concurrencyVersionField === undefined) {
      throw new ConfigurationError(
        `Entity "${input.entity.name}" enables update or delete routes but declares no version field. Optimistic concurrency is mandatory for mutating routes: declare entity.versionField or optimisticConcurrency.versionField as a numeric field.`,
      )
    }
  }

  if (!input.entity.primaryKey && !Object.prototype.hasOwnProperty.call(input.entity.fields, "id")) {
    throw new ConfigurationError(
      `Entity "${input.entity.name}" needs an explicit or inferable primary key.`,
    )
  }

  if (input.audit !== false && input.audit !== undefined && !input.audit.resource) {
    throw new ConfigurationError(
      `Entity "${input.entity.name}" has audit enabled but no resource name.`,
    )
  }

  for (const [field, classification] of Object.entries(input.audit === false ? {} : input.audit?.fieldClassification ?? {})) {
    requireField(field, "audit classification field")
    if (classification !== "include" && classification !== "mask" && classification !== "omit") {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid audit classification for "${field}".`)
    }
  }
  assertEntityQueryLimits(entityName, input.queryLimits)
  if (input.searchStrategy && !["contains", "prefix", "fullText"].includes(input.searchStrategy.kind)) {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid search strategy.`)
  }
  if (input.searchStrategy?.kind === "fullText" && !input.searchStrategy.portKey?.trim()) {
    throw new ConfigurationError(`Entity "${entityName}" uses fullText search without a compiled SearchPort key.`)
  }

  if (input.cache !== false && input.cache !== undefined && (!input.cache.tag || !input.cache.keyPrefix)) {
    throw new ConfigurationError(
      `Entity "${input.entity.name}" has cache enabled but no cache tag/keyPrefix.`,
    )
  }

  if (routeRequires("create", routes) && !input.validation?.createBody) {
    throw new ConfigurationError(
      `Entity "${input.entity.name}" enables create but provides no createBody validation schema.`,
    )
  }

  if (routeRequires("update", routes) && !input.validation?.updateBody) {
    throw new ConfigurationError(
      `Entity "${input.entity.name}" enables update but provides no updateBody validation schema.`,
    )
  }

  validateCrudLifecycle(input.crud, entityName)
}

const ALLOWED_CRUD_ROUTES = new Set(["list", "detail", "create", "update", "delete"])
const CRUD_HOOK_ALLOWLIST: Record<string, readonly string[]> = {
  list: ["transformQuery", "projectResult"],
  detail: ["projectResult"],
  create: ["transformInput", "projectCommittedResult", "afterCommit"],
  update: ["transformInput", "projectCommittedResult", "afterCommit"],
  delete: ["beforeDelete", "afterCommit"],
}

function validateCrudLifecycle(
  crud: unknown,
  entityName: string,
): void {
  if (crud === undefined) return
  if (!crud || typeof crud !== "object" || Array.isArray(crud)) {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid crud configuration.`)
  }
  const ALL_HOOK_NAMES = new Set(Object.values(CRUD_HOOK_ALLOWLIST).flat())
  for (const [route, hooks] of Object.entries(crud as Record<string, unknown>)) {
    if (!ALLOWED_CRUD_ROUTES.has(route)) {
      // Allow non-route opaque/plain data used by defineEntity freezing tests
      // (e.g., crud.nested, crud.map). Only reject if the value looks like a
      // lifecycle route object containing hook names.
      if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
        const keys = Object.keys(hooks)
        const containsHook = keys.some((k) => ALL_HOOK_NAMES.has(k))
        if (containsHook) {
          throw new ConfigurationError(`Entity "${entityName}" has an invalid crud route "${route}".`)
        }
      } else if (typeof hooks === "function") {
        throw new ConfigurationError(`Entity "${entityName}" has an invalid crud route "${route}".`)
      }
      continue
    }
    if (hooks === undefined || hooks === null) continue
    if (typeof hooks !== "object" || Array.isArray(hooks)) {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid crud hooks configuration for route "${route}".`)
    }
    const allowed = CRUD_HOOK_ALLOWLIST[route] ?? []
    for (const [hookName, hookFn] of Object.entries(hooks as Record<string, unknown>)) {
      if (!allowed.includes(hookName)) {
        throw new ConfigurationError(
          `Entity "${entityName}" has invalid hook "${hookName}" for route "${route}". Allowed hooks: ${allowed.join(", ")}.`,
        )
      }
      if (hookFn !== undefined && typeof hookFn !== "function") {
        throw new ConfigurationError(
          `Entity "${entityName}" has an invalid hook "${hookName}" for route "${route}" — hook must be a function.`,
        )
      }
    }

    // Runtime persistence restrictions enforce the remaining lifecycle contract.
  }
}

function validateRateLimit(config: RateLimitConfig, entityName: string, route: string): void {
  if (!config || !Number.isInteger(config.max) || config.max <= 0) {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid rate-limit max for ${route}.`)
  }
  const consistency = (config as RateLimitPolicy).consistency
  if (consistency !== "atomic" && consistency !== "best-effort") {
    throw new ConfigurationError(`Entity "${entityName}" must declare rate-limit consistency for ${route}.`)
  }
  if (config.algorithm !== undefined && !(["fixed-window", "sliding-window", "token-bucket"] as const).includes(config.algorithm)) {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid rate-limit algorithm for ${route}.`)
  }
  if (config.cost !== undefined && (!Number.isSafeInteger(config.cost) || config.cost <= 0)) {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid rate-limit cost for ${route}.`)
  }
  if (typeof config.timeWindow === "number") {
    if (!Number.isFinite(config.timeWindow) || config.timeWindow <= 0) {
      throw new ConfigurationError(`Entity "${entityName}" has an invalid rate-limit window for ${route}.`)
    }
    return
  }
  if (typeof config.timeWindow !== "string" || !/^[1-9]\d*\s*(second|seconds|minute|minutes|hour|hours)$/.test(config.timeWindow.trim().toLowerCase())) {
    throw new ConfigurationError(`Entity "${entityName}" has an invalid rate-limit window for ${route}.`)
  }
}
