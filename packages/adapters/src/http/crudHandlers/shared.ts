import { enforceRateLimit, type RateLimitConfig, type RateLimitPolicy, type RateLimitStore } from "@xonava/core/rate-limit"
import type { EntityVersion } from "@xonava/core/serialization"
import { internalRepositoryForDescriptor } from "../../repository/dynamicRepository"
import type { EntityRateLimitSetting } from "@xonava/core/entity"
import {
  assertFrameworkAuthorization,
  ConfigurationError,
  assertVerifiedAbacBundle,
  createAbacAuthorizer,
  ForbiddenError,
  Predicate,
  projectResponseRecord,
  resolveFieldReadOverrides,
  deepFreeze,
  type PredicateNode,
  type RequestContext,
} from "@xonava/core/domain"
import { createReadOnlyPersistenceProvider, createTenantScopedPersistenceProvider, encodeTenantCacheTag, type PersistenceProvider } from "@xonava/core/persistence"
import { CacheBackedRateLimitStore } from "../../cache"
import type {
  CrudMutationHookContext,
  CrudPostCommitHookContext,
  CrudReadHookContext,
  CrudMutationHookOperation,
  CrudReadHookOperation,
} from "@xonava/core/entity"
import type {
  PostCommitContext,
  AtomicBatchPreparationContext,
  MutationOperationContext,
  PreparationOperationContext,
  ReadOperationContext,
  RepresentationContext,
} from "@xonava/core/operation"
import type { FrameworkRequestNormalization } from "../../server"
import { normalizeFrameworkRequest } from "../scopeResolution"
import type {
  CrudShared,
  AuditObject,
  CrudOptions,
  MutationResult,
  SelectableRow,
} from "./types"

export function tenantIdFromContext(context: RequestContext): string | undefined {
  return context.scope.kind === "tenant" ? context.scope.tenantId : undefined
}

/** Fails at handler construction when an enabled CRUD handler has no route binding. */
export function assertCrudRouteBinding(
  normalization: FrameworkRequestNormalization,
  routeKey: "list" | "detail",
  moduleKey: string,
): void {
  if (!Object.hasOwn(normalization.routeBindings, routeKey))
    throw new ConfigurationError(`CRUD handler for "${moduleKey}" has no route binding "${routeKey}"`)
}

export async function normalizeCrudRequest(args: {
  request: Request
  routeKey: string
  normalization: FrameworkRequestNormalization
  requestId: string
  correlationId: string
  pathParameters?: Readonly<Record<string, string>>
  metadata?: Readonly<Record<string, unknown>>
}): Promise<RequestContext> {
  const route = Object.hasOwn(args.normalization.routeBindings, args.routeKey)
    ? args.normalization.routeBindings[args.routeKey]
    : undefined
  if (route === undefined) throw new ConfigurationError(`No route binding is configured for "${args.routeKey}"`)
  const session = await args.normalization.resolveTrustedSession({ request: args.request, route })
  const trustedHeaders = Object.fromEntries((args.normalization.trustedHeaders ?? []).flatMap((name) => {
    const value = args.request.headers.get(name)
    return value === null ? [] : [[name.toLowerCase(), value]]
  }))
  return normalizeFrameworkRequest({
    requestId: args.requestId,
    correlationId: args.correlationId,
    route,
    resolverBindings: args.normalization.resolverBindings,
    ...(args.normalization.verifyDelegationRevocation === undefined ? {} : { verifyDelegationRevocation: args.normalization.verifyDelegationRevocation }),
    ...(session === undefined ? {} : { session }),
    admit: ({ identity, scope, scopeId }) => args.normalization.resolveAdmissionEvidence({
      request: args.request,
      route,
      identity,
      scope,
      scopeId,
      ...(session === undefined ? {} : { session }),
    }),
    signal: args.request.signal,
    host: new URL(args.request.url).hostname,
    ...(args.pathParameters === undefined ? {} : { pathParameters: args.pathParameters }),
    ...(Object.keys(trustedHeaders).length === 0 ? {} : { headers: trustedHeaders }),
    ...(args.metadata === undefined ? {} : { metadata: args.metadata }),
  })
}

export function getRequestIp(
  request: Request,
  resolveClientIp?: import("../requestBody").TrustedClientIpResolver,
  resolveHttpMetadata?: import("../../server/frameworkAdapterDeps").FrameworkAdapterDeps["resolveHttpMetadata"],
): string {
  return resolveClientIp?.(request, resolveHttpMetadata?.(request))?.trim() || "unknown"
}

/**
 * Derives the cache partition for a read so that post-projection responses are
 * only shared within one security context. The partition is bound to the
 * verified ABAC security digest so two bundles with the same cacheScopeKey but
 * different authorization state can never share cached rows.
 */
export function deriveSecurityCachePartition(args: {
  bundle?: import("../../server").AbacBundle | undefined
  context: RequestContext
  cacheScopeKey?: string | undefined
  hasRepresentationHook: boolean
  deps: CrudOptions<SelectableRow>["adapterDeps"]
  scope: CrudOptions<SelectableRow>["scope"]["scope"]
}): { canCache: boolean; partition: string } {
  // Representation hook output is request-dependent. Until a reviewed
  // variance contract exists, never share a representation-hook execution.
  if (args.hasRepresentationHook) {
    return { canCache: false, partition: "" }
  }
  if (args.context.identity.actor.kind === "anonymous") {
    return { canCache: true, partition: `public:${args.context.scopeId}` }
  }
  const digest = args.bundle?.securityDigest
  if (!digest || digest.trim().length === 0) {
    return { canCache: false, partition: "" }
  }
  const scopeKey = args.cacheScopeKey
  const hasScopeKey = Boolean(scopeKey && scopeKey.trim().length > 0)
  return {
    canCache: hasScopeKey,
    partition: `abac:${digest}:${hasScopeKey ? scopeKey : "default"}`,
  }
}

export function canUseOwnerBypass(
  _deps: CrudOptions<SelectableRow>["adapterDeps"],
  _scope: CrudOptions<SelectableRow>["scope"]["scope"],
  _context: RequestContext,
): boolean {
  // Administrative bypass is no longer accepted from transport/session shape.
  // A future compiled entitlement may opt in through packages/core policy.
  return false
}

export function authorizeFrameworkModule(args: {
  deps: CrudOptions<SelectableRow>["adapterDeps"]
  moduleKey: string
  action: string
  capabilityKey?: string
  context: RequestContext
  bundle?: import("../../server").AbacBundle | null
  evaluateAbacAction?: boolean
}): { ownerBypass: boolean } {
  const customFacts = args.deps.resolveModuleAuthorizationFacts?.({
    moduleKey: args.moduleKey,
    context: args.context,
  })
  const impersonated = args.context.identity.actor.id !== args.context.identity.subject.id ||
    args.context.identity.actor.kind !== args.context.identity.subject.kind
  const facts = {
    ...(customFacts ?? {}),
    scope: args.context.scope.kind === "tenant" ? "tenant" as const : "platform" as const,
    ownerAuthority: false,
    impersonated,
  }
  return assertFrameworkAuthorization({
    facts,
    moduleKey: args.moduleKey,
    action: args.action,
    ...(args.capabilityKey !== undefined ? { capabilityKey: args.capabilityKey } : {}),
    ...(args.bundle !== undefined ? { bundle: args.bundle } : {}),
    ...(args.evaluateAbacAction !== undefined ? { evaluateAbacAction: args.evaluateAbacAction } : {}),
  })
}

export function auditEmit<
  TRow extends SelectableRow,
  A,
  B,
  L extends SelectableRow,
  D extends SelectableRow,
>(
  options: CrudOptions<TRow, A, B, L, D>,
  action: "create" | "update" | "delete"
): boolean {
  if (options.audit?.enabled === false) return false
  return options.audit?.emitOn ? options.audit.emitOn.includes(action) : true
}
/**
 * An application-scoped entity is partitioned by the trusted application key.
 * Outside an application execution scope there is no key to partition by, so
 * the request must fail closed instead of reading or writing every partition.
 */
function assertEntityScopeContext(
  entityScope: CrudOptions<SelectableRow>["entityScope"],
  context: RequestContext,
): void {
  if (entityScope?.kind === "application" && context.scope.kind !== "application")
    throw new ForbiddenError("This operation requires an application scope")
  // A tenant entity reached outside a tenant scope would get no structural filter and span every tenant.
  if (entityScope?.kind === "tenant" && context.scope.kind !== "tenant")
    throw new ForbiddenError("This operation requires a tenant scope")
}

export function buildStructuralScope<TRow extends SelectableRow>(
  entity: CrudOptions<TRow>["entity"],
  context: RequestContext,
  entityScope: CrudOptions<TRow>["entityScope"]
): PredicateNode | undefined {
  assertEntityScopeContext(entityScope, context)
  let scope: PredicateNode | undefined =
    entityScope?.kind === "tenant" && context.scope.kind === "tenant" && (entityScope.field ?? entity.tenantField)
      ? Predicate.eq((entityScope.field ?? entity.tenantField)!, context.scope.tenantId)
      : entityScope?.kind === "application" && context.scope.kind === "application"
        ? Predicate.eq(entityScope.field, context.scope.applicationKey)
      : undefined
  if ((entityScope?.kind === "platform" || entityScope?.kind === "system") && entityScope.scopeFilter)
    scope = scope
      ? Predicate.and(scope, entityScope.scopeFilter)
      : entityScope.scopeFilter
  if (entity.activeRowFilter) scope = scope ? Predicate.and(scope, entity.activeRowFilter) : entity.activeRowFilter
  return scope
}

export function getProtectedMutationFields<TRow extends SelectableRow>(
  entity: CrudOptions<TRow>["entity"]
): string[] {
  return [...new Set([
    entity.primaryKey,
    entity.tenantField,
    entity.versionField,
    ...(entity.immutableFields ?? []),
  ].filter((field): field is string => Boolean(field)))]
}

export function assertProtectedUpdateFields<TRow extends SelectableRow>(
  entity: CrudOptions<TRow>["entity"],
  patch: object,
  reservedFields: readonly string[] = [],
): void {
  const protectedFields = [...new Set([...getProtectedMutationFields(entity), ...reservedFields])]
  const provided = protectedFields.filter((field) => Object.hasOwn(patch, field))
  if (provided.length > 0)
    throw new ForbiddenError(
      `Cannot modify protected fields on ${entity.name}: ${provided.join(", ")}`,
      { fields: provided }
    )
}

export function assertProtectedCreateFields<TRow extends SelectableRow>(
  entity: CrudOptions<TRow>["entity"],
  body: object
): void {
  const protectedFields = getProtectedMutationFields(entity)
  const provided = protectedFields.filter((field) => Object.hasOwn(body, field))
  if (provided.length > 0)
    throw new ForbiddenError(
      `Cannot provide protected fields on ${entity.name}: ${provided.join(", ")}`,
      { fields: provided }
    )
}

export async function resolveActionScopeForContext<
  TRow extends SelectableRow,
  A = TRow,
  B = Partial<TRow>,
  L extends SelectableRow = TRow,
  D extends SelectableRow = TRow,
>(
  options: CrudOptions<TRow, A, B, L, D>,
  context: RequestContext,
  action: string
): Promise<PredicateNode | undefined> {
  if (context.identity.actor.kind === "anonymous" || canUseOwnerBypass(options.adapterDeps, options.scope.scope, context))
    return undefined
  const bundle = await options.adapterDeps.resolveAbacBundle({
    moduleKey: options.moduleKey,
    context,
  })
  if (!bundle)
    throw new ForbiddenError("ABAC authorization bundle unavailable")
  assertVerifiedAbacBundle(bundle)
  return bundle ? createAbacAuthorizer(bundle).assertCollectionAction(action).scope : undefined
}

/**
 * Re-enforces ABAC field/record write rules on the FINAL (post-transform)
 * mutation record. Uses the request's enforcer when the operation context
 * carries one; atomic-batch preparation contexts do not, so the verified
 * bundle is resolved again for the session.
 */
export async function enforceFinalWrite<
  TRow extends SelectableRow,
  A = TRow,
  B = Partial<TRow>,
  L extends SelectableRow = TRow,
  D extends SelectableRow = TRow,
>(args: {
  options: CrudOptions<TRow, A, B, L, D>
  operation: object
  context: RequestContext
  action: "create" | "update"
  record: Record<string, unknown>
  changedFields: string[]
}): Promise<void> {
  const enforcer = "enforceAbac" in args.operation
    ? (args.operation as { readonly enforceAbac?: import("@xonava/core/security").AbacWriteEnforcer }).enforceAbac
    : undefined
  if (enforcer) {
    enforcer.enforce(args.action, args.record, args.changedFields)
    return
  }
  if (args.context.identity.actor.kind === "anonymous" || canUseOwnerBypass(args.options.adapterDeps, args.options.scope.scope, args.context))
    return
  const bundle = await args.options.adapterDeps.resolveAbacBundle({ moduleKey: args.options.moduleKey, context: args.context })
  if (!bundle) throw new ForbiddenError("ABAC authorization bundle unavailable")
  assertVerifiedAbacBundle(bundle)
  createAbacAuthorizer(bundle).assertWrite({ action: args.action, record: args.record, changedFields: args.changedFields })
}

/** Internal versions are already validated numbers; do not coerce persisted strings. */
export function sameMutationVersion(a: unknown, b: unknown): boolean {
  return a === b
}

export function withScopedPersistence(
  context: RequestContext,
  persistence: PersistenceProvider
): PersistenceProvider {
  return context.scope.kind === "tenant"
    ? createTenantScopedPersistenceProvider(persistence, context.scope.tenantId)
    : persistence
}

function snapshotHookValue<T>(value: T): T {
  // Hooks may inspect request metadata, but must never receive references into
  // the authorization/session state used by the operation pipeline.
  return deepFreeze(value)
}

export function toCrudContext(
  context: RequestContext,
  operation: MutationOperationContext | PreparationOperationContext | RepresentationContext,
  persistence?: PersistenceProvider,
): CrudMutationHookContext {
  const operationPersistence = "persistence" in operation ? operation.persistence : undefined
  if (!persistence && !operationPersistence) throw new ConfigurationError("Mutation hook persistence is unavailable")
  const hookPersistence = persistence
    ? createReadOnlyPersistenceProvider(context.scope.kind === "tenant" ? withScopedPersistence(context, persistence) : persistence)
    : operationPersistence!

  // Keep internal effect, capability, disposal, and persistence-replacement
  // APIs out of the hook-visible operation object.
  const request = "request" in operation && operation.request !== undefined
    ? snapshotHookValue(operation.request)
    : undefined
  const hookOperation: CrudMutationHookOperation = {
    operationId: operation.operationId,
    ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
    ...(request !== undefined ? { request } : {}),
    persistence: hookPersistence,
    services: operation.services,
    signal: operation.signal,
    deadline: operation.deadline,
  }

  return {
    tenantId: tenantIdFromContext(context) ?? "",
    persistence: hookPersistence,
    requestId: request?.requestId ?? "",
    correlationId: request?.correlationId ?? operation.correlationId ?? "",
    operation: hookOperation,
  }
}
export function toCrudPostCommitContext(
  context: RequestContext,
  operation: PostCommitContext
): CrudPostCommitHookContext {
  const requestId =
    typeof operation.metadata?.requestId === "string"
      ? operation.metadata.requestId
      : (operation.correlationId ?? "")
  return {
    tenantId: tenantIdFromContext(context) ?? "",
    requestId,
    correlationId: operation.correlationId ?? "",
  }
}
export function toCrudReadContext(
  context: RequestContext,
  operation: ReadOperationContext | RepresentationContext
): CrudReadHookContext {
  const metadata = snapshotHookValue(
    "request" in operation ? operation.request?.metadata : "metadata" in operation ? operation.metadata : undefined
  )
  const metadataRequestId = typeof metadata?.requestId === "string"
    ? metadata.requestId
    : undefined
  return {
    tenantId: tenantIdFromContext(context) ?? "",
    requestId: ("request" in operation ? operation.request?.requestId : undefined) ?? metadataRequestId ?? "",
    correlationId: ("request" in operation ? operation.request?.correlationId : undefined) ?? operation?.correlationId ?? "",
    operation: {
      operationId: operation.operationId,
      ...(operation.correlationId !== undefined ? { correlationId: operation.correlationId } : {}),
      services: operation.services,
      ...(metadata !== undefined ? { metadata } : {}),
    } satisfies CrudReadHookOperation,
  }
}
export function resolveOperationRequestContext(
  operation: ReadOperationContext | MutationOperationContext | RepresentationContext | PostCommitContext | AtomicBatchPreparationContext
): RequestContext {
  if ("request" in operation && operation.request) return operation.request
  const metadata = "metadata" in operation ? operation.metadata : undefined
  const context = metadata?.requestContext as RequestContext | undefined
  if (!context)
    throw new ConfigurationError(
      "Canonical request context metadata missing for CRUD hook context"
    )
  return context
}

export function normalizeEntityRateLimitSetting(setting: EntityRateLimitSetting): {
  config: RateLimitConfig
  consistency: NonNullable<EntityRateLimitSetting["consistency"]>
  policy?: Pick<RateLimitPolicy, "failureMode">
} {
  const { max, timeWindow, consistency, failureMode, algorithm, cost } = setting
  return {
    config: { max, timeWindow, ...(algorithm!==undefined?{algorithm}:{}), ...(cost!==undefined?{cost}:{}) },
    consistency,
    ...(failureMode !== undefined ? { policy: { failureMode } } : {}),
  }
}

export async function loadExistingRecord<
  TRow extends SelectableRow,
  A,
  B,
  L extends SelectableRow,
  D extends SelectableRow,
>(
  options: CrudOptions<TRow, A, B, L, D>,
  id: string,
  context: RequestContext,
  extraFilter?: PredicateNode
): Promise<TRow | null> {
  const basePersistence = options.createPersistence(context)
  const readPersistence = options.entity.tenantField
    ? withScopedPersistence(context, basePersistence)
    : basePersistence
  const repo = internalRepositoryForDescriptor(readPersistence, options.entity)
  const structural = buildStructuralScope(
    options.entity,
    context,
    options.entityScope
  )
  const scope = extraFilter
    ? structural
      ? Predicate.and(structural, extraFilter)
      : extraFilter
    : structural
  const filter = scope
    ? Predicate.and(Predicate.eq(options.entity.primaryKey ?? "id", id), scope)
    : Predicate.eq(options.entity.primaryKey ?? "id", id)
  if (scope)
    return repo.findOneWhere
      ? repo.findOneWhere(filter)
      : ((await repo.findMany({ filter })).rows[0] ?? null)
  return repo.findById(id)
}
export function toAuditObject(value: object): AuditObject {
  return value as AuditObject
}
export function buildScopedCreateRecord<TRow extends SelectableRow>(
  entity: CrudOptions<TRow>["entity"],
  input: { id: string },
  body: AuditObject,
  context: RequestContext,
  entityScope?: CrudOptions<TRow>["entityScope"]
): Partial<TRow> {
  assertEntityScopeContext(entityScope, context)
  return {
    ...body,
    id: input.id,
    // Structural scope columns always come from the trusted execution scope,
    // never from the client body (which is also rejected upstream).
    ...(context.scope.kind === "tenant" && entity.tenantField
      ? { [entity.tenantField]: context.scope.tenantId }
      : {}),
    ...(entityScope?.kind === "application" && context.scope.kind === "application"
      ? { [entityScope.field]: context.scope.applicationKey }
      : {}),
    // Create is the first versioned state. Set it explicitly so the durable
    // idempotency receipt does not depend on a dialect/schema default.
    ...(entity.versionField ? { [entity.versionField]: 1 } : {}),
  } as unknown as Partial<TRow>
}
/**
 * Cache tags shared by reads and invalidations. Tenant tags use the tenant's
 * length-prefixed namespace (unambiguous for any tenant id), which is also what
 * a tenant-scoped atomic batch is allowed to advance. The bare global module
 * tag is reserved for genuinely global (platform/public) shared data.
 */
export function buildScopeCacheTags(tag: string, context: RequestContext): string[] {
  const tags = context.scope.kind === "tenant"
    ? [encodeTenantCacheTag(context.scope.tenantId, tag), encodeTenantCacheTag(context.scope.tenantId, "scope")]
    : [`${tag}:${context.scopeId}`, `scope:${context.scopeId}`, tag]
  // A module tag named "scope" would otherwise repeat the scope tag.
  return [...new Set(tags)]
}

export function createShared<
  TRow extends SelectableRow,
  A,
  B,
  L extends SelectableRow,
  D extends SelectableRow,
>(
  options: CrudOptions<TRow, A, B, L, D>,
  routes: CrudShared<TRow, A, B, L, D>["routes"],
  capabilityMode: CrudShared<TRow, A, B, L, D>["capabilityMode"]
): Pick<
  CrudShared<TRow, A, B, L, D>,
  | "buildReadTags"
  | "enforceReadRateLimit"
  | "enforceReadAccess"
  | "buildReadScope"
  | "resolveReadScopeForContext"
> {
  const deps = options.adapterDeps
  const buildReadTags = (context: RequestContext) => buildScopeCacheTags(options.cache.tag, context)
  const enforceReadRateLimit = async (
    route: "list" | "detail",
    config:
      import("@xonava/core/entity").EntityRateLimitSetting | undefined,
    request: Request,
    context: RequestContext
  ) => {
    if (!config) return
    const key = `${context.scopeId}:${context.identity.actor.id}:${options.moduleKey}:${route}:${getRequestIp(request, deps.resolveClientIp, deps.resolveHttpMetadata)}`
    const normalized = normalizeEntityRateLimitSetting(config)
    if (normalized.consistency === "atomic" && !options.getRateLimitStore) {
      throw new ConfigurationError("Atomic rate limiting requires an atomic rate-limit store")
    }
    const store: RateLimitStore = normalized.consistency === "atomic"
      ? await options.getRateLimitStore!()
      : new CacheBackedRateLimitStore(await options.getCacheAdapter())
    await enforceRateLimit({ store, key, ...normalized })
  }
  const enforceReadAccess = async (
    _request: Request,
    context: RequestContext
  ) => {
    let abacBundle
    if (
      context.identity.actor.kind !== "anonymous" &&
       !canUseOwnerBypass(deps, options.scope.scope, context)
    ) {
      abacBundle =
        (await deps.resolveAbacBundle({
          moduleKey: options.moduleKey,
          context,
        })) ?? undefined
      if (!abacBundle)
         throw new ForbiddenError("ABAC authorization bundle unavailable")
       assertVerifiedAbacBundle(abacBundle)
    } else if (context.identity.actor.kind === "anonymous" && capabilityMode.enabled)
      throw new ForbiddenError("This operation is not permitted")
    authorizeFrameworkModule({
      deps,
      moduleKey: options.moduleKey,
      action: "read",
      ...(capabilityMode.enabled ? { capabilityKey: capabilityMode.key! } : {}),
      context,
      ...(abacBundle !== undefined ? { bundle: abacBundle } : {}),
      evaluateAbacAction: false,
    })
    return abacBundle
  }
  const buildReadScope = (
    bundle: import("../../server").AbacBundle | undefined
  ) => {
    const scope = bundle
      ? createAbacAuthorizer(bundle).buildActionScope("read")
      : { filter: undefined, cacheScopeKey: undefined }
    return {
      filter: scope.filter,
      ...(scope.cacheScopeKey !== undefined
        ? { cacheScopeKey: scope.cacheScopeKey }
        : {}),
    }
  }
  const resolveReadScopeForContext = async (context: RequestContext) => {
    if (
      context.identity.actor.kind === "anonymous" ||
       canUseOwnerBypass(deps, options.scope.scope, context)
    )
      return { filter: undefined }
     const bundle = await deps.resolveAbacBundle({
         moduleKey: options.moduleKey,
         context,
      })
      if (!bundle) throw new ForbiddenError("ABAC authorization bundle unavailable")
      assertVerifiedAbacBundle(bundle)
      return buildReadScope(bundle)
  }
  return {
    buildReadTags,
    enforceReadRateLimit,
    enforceReadAccess,
    buildReadScope,
    resolveReadScopeForContext,
  }
}
