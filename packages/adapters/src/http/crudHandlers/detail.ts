import { CacheService, buildKey, serializeCacheKeyPart } from "core/cache"
import { buildAuditRecord } from "core/events"
import { internalRepositoryForDescriptor } from "../../repository/dynamicRepository"
import {
  createOperationContext,
  runOperation,
  type OperationDefinition,
} from "core/operation"
import {
  Predicate,
  projectResponseRecord,
  resolveFieldReadOverrides,
  NotFoundError,
} from "core/domain"
import {
  frameworkJson,
  createFrameworkErrorHandler,
} from "../handleFrameworkCoreError"
import { resolveRequestMetadata } from "../requestBody"
import type { CrudShared, SelectableRow } from "./types"
import {
  buildStructuralScope,
  deriveSecurityCachePartition,
  getRequestIp,
  normalizeCrudRequest,
  toCrudReadContext,
  withScopedPersistence,
} from "./shared"

const frameworkErrorHandler = createFrameworkErrorHandler()

export function createDetailHandler<
  TRow extends SelectableRow,
  A,
  B,
  L extends SelectableRow,
  D extends SelectableRow,
>(shared: CrudShared<TRow, A, B, L, D>) {
  const { options, entity } = shared
  return async (
    request: Request,
    params: Record<string, string>
  ): Promise<Response> => {
    let requestMetadata: ReturnType<typeof resolveRequestMetadata> | undefined
    try {
      if (!shared.routes.detail)
        return frameworkJson({ error: "Method Not Allowed" }, { status: 405 })
      requestMetadata = resolveRequestMetadata(request, shared.deps.resolveClientIp, shared.deps.resolveHttpMetadata?.(request))
      const { id } = (
        options.validation?.idParams ??
        (await import("./types")).defaultIdParams
      ).parse(params) as { id: string }
      const requestContext = await normalizeCrudRequest({
        request,
        routeKey: "detail",
        normalization: options.requestNormalization,
        requestId: requestMetadata.requestId,
        correlationId: requestMetadata.correlationId,
        pathParameters: { id },
        metadata: { requestId: requestMetadata.requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent },
      })
      const abacBundle = await shared.enforceReadAccess(request, requestContext)
      const readScope = shared.buildReadScope(abacBundle)
      await shared.enforceReadRateLimit(
        "detail",
        options.rateLimit?.detail,
        request,
        requestContext
      )
      const basePersistence = options.createPersistence(requestContext)
      const persistence = entity.tenantField
        ? withScopedPersistence(requestContext, basePersistence)
        : basePersistence

      const readEnvironment = createOperationContext({
        persistence,
        runtimeCapabilities: shared.writeRuntimeCapabilities,
        request: requestContext,
        signal: request.signal,
      })

      const structural = buildStructuralScope(
        entity,
        requestContext,
        options.entityScope
      )
      const filter = readScope.filter
        ? structural
          ? Predicate.and(structural, readScope.filter)
          : readScope.filter
        : structural

      const definition: OperationDefinition<{ id: string }, SelectableRow> = {
        key: `${options.moduleKey}.detail`,
        kind: "read",
        atomicity: { kind: "standard", mode: "none" },
        execute: async ({ operation, input }) => {
          const repo = internalRepositoryForDescriptor(operation.persistence, entity)
          const row = filter
            ? repo.findOneWhere
              ? await repo.findOneWhere(
                  Predicate.and(
                    Predicate.eq(entity.primaryKey ?? "id", input.id),
                    filter
                  )
                )
              : ((
                  await repo.findMany({
                    filter: Predicate.and(
                      Predicate.eq(entity.primaryKey ?? "id", input.id),
                      filter
                    ),
                  })
                ).rows[0] ?? null)
            : await repo.findById(input.id)
          if (!row) throw new NotFoundError(`${entity.name} not found`)
          return row
        },
        after: async ({ operation, input: _input, result }) => {
          const durableRow = result
          const overrides = abacBundle
            ? resolveFieldReadOverrides({ policies: abacBundle.policies, moduleKey: options.moduleKey, record: durableRow })
            : undefined
          const projectedRow = projectResponseRecord({ entity, record: durableRow, ...(overrides ? { overrides } : {}) })
            const enriched = options.crud?.detail?.projectResult
              ? await options.crud.detail.projectResult({
                row: projectedRow as unknown as TRow,
                 context: toCrudReadContext(requestContext, operation),
              })
            : projectedRow
          return projectResponseRecord({
            entity,
            record: enriched,
            ...(overrides ? { overrides } : {}),
          })
        },
      }

      const resolveDetail = () =>
        runOperation<{ id: string }, SelectableRow>({
          operation: readEnvironment,
          definition,
          input: { id },
        })
      const scopeKey =
        requestContext.scope.kind === "tenant"
          ? readScope.cacheScopeKey
            ? `${requestContext.scope.tenantId}:${readScope.cacheScopeKey}`
            : requestContext.scope.tenantId
          : `${requestContext.scopeId}:${readScope.cacheScopeKey ?? "global"}`
      const cachePartition = deriveSecurityCachePartition({
        bundle: abacBundle,
        context: requestContext,
        cacheScopeKey: readScope.cacheScopeKey,
          hasRepresentationHook: typeof options.crud?.detail?.projectResult === "function",
        deps: options.adapterDeps,
        scope: options.scope.scope,
      })
      const useCache =
        options.cache.enabled === true && cachePartition.canCache
      const result =
        useCache
          ? await new CacheService({
              adapter: await options.getCacheAdapter(),
              correctnessCritical: Boolean(abacBundle),
            }).getOrSet(
              buildKey(
                options.cache.keyPrefix,
                `${cachePartition.partition}:${scopeKey}`,
                serializeCacheKeyPart({ type: "detail", id })
              ),
              resolveDetail,
              shared.buildReadTags(requestContext)
            )
          : await resolveDetail()
      if (
        result &&
        options.audit?.readAudit &&
        options.auditSinkFactory &&
        requestContext.identity.actor.kind !== "anonymous"
      )
        await options.auditSinkFactory(requestContext).write(
          buildAuditRecord({
            id: crypto.randomUUID(),
            occurredAt: new Date(),
            actor: requestContext.identity.actor,
            action: `${options.audit.resource}.read`,
            resourceType: options.audit.resource,
            resourceId: id,
            tenantId: requestContext.scope.kind === "tenant" ? requestContext.scope.tenantId : null,
            metadata: {
              ipAddress: getRequestIp(request, shared.deps.resolveClientIp, shared.deps.resolveHttpMetadata),
              userAgent: requestMetadata.userAgent,
              scopeId: requestContext.scopeId,
            },
          })
        )
      return withReadMetadata(frameworkJson(result), requestMetadata)
    } catch (error) {
      return frameworkErrorHandler(error, requestMetadata)
    }
  }
}

function withReadMetadata(
  response: Response,
  metadata: ReturnType<typeof resolveRequestMetadata> | undefined
): Response {
  if (!metadata) return response
  response.headers.set("x-request-id", metadata.requestId)
  if (metadata.correlationId)
    response.headers.set("x-correlation-id", metadata.correlationId)
  return response
}
