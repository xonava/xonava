import { CacheService, buildKey, serializeCacheKeyPart } from "@xonava/core/cache"
import { buildAuditRecord } from "@xonava/core/events"
import { internalRepositoryForDescriptor } from "../../repository/dynamicRepository"
import {
  createOperationContext,
  runOperation,
  type OperationDefinition,
} from "@xonava/core/operation"
import {
  ConfigurationError,
  ForbiddenError,
  ValidationError,
  Predicate,
  markTrustedPredicate,
  projectResponseRecord,
  resolveFieldQueryDenials,
  resolveFieldReadOverrides,
  type PredicateNode,
} from "@xonava/core/domain"
import { DEFAULT_MAX_QUERY_JSON_BYTES, filtersToPredicate, parseSortString } from "../filterInterop"
import { fingerprintJson } from "../idempotency"
import { parseUniqueQueryParameters, resolveRequestMetadata } from "../requestBody"
import {
  frameworkJson,
  createFrameworkErrorHandler,
} from "../handleFrameworkCoreError"
import { defaultListQuerySchema, type CrudShared, type ReadQuery, type SelectableRow } from "./types"
import { assertCursorBinding, assertStableCursorSort, compileQueryBudget, decodeCursor, encodeCursor, validateQueryPlan, type CursorPageInfo, type CursorPayloadV1, type ProjectionSpec } from "@xonava/core/query"
import {
  buildStructuralScope,
  deriveSecurityCachePartition,
  getRequestIp,
  assertCrudRouteBinding,
  normalizeCrudRequest,
  toCrudReadContext,
  withScopedPersistence,
} from "./shared"

const frameworkErrorHandler = createFrameworkErrorHandler()

type ListReadResult<TRow> = {
  rows: TRow[]
  rowCount: number
  page: number
  pageSize: number
  pageInfo?: CursorPageInfo
}

function parseProjection(raw: string | undefined): ProjectionSpec | undefined {
  if (!raw) return undefined
  const fields = raw.split(",").map(field => field.trim())
  if (fields.some(field => !field) || new Set(fields).size !== fields.length) throw new ValidationError("fields must be a comma-separated list of unique field names")
  return { fields }
}

function applyProjection(row: SelectableRow, projection: ProjectionSpec | undefined): SelectableRow {
  if (!projection) return row
  return Object.fromEntries(projection.fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]]))
}

const STALE_CURSOR_MESSAGE = "Cursor is no longer valid; restart from the first page"

/** A cursor that cannot be used for this request; answered as a 400 with a restart hint. */
class StaleCursorError extends ValidationError {
  constructor(cause: unknown) {
    super(STALE_CURSOR_MESSAGE, cause)
  }
}

/**
 * The scope segment of a list cache key: security partition, request scope and
 * read-scope key. Encoded as a canonical cache key part (a JSON array), so it is
 * injective even when tenant ids, partitions or scope keys contain ":" — the
 * former `${partition}:${tenantId}:${cacheScopeKey}` concatenation let tenant
 * "a" with scope key "a:a" share a key with tenant "a:a:a" with scope key "a".
 * An absent scope key (null) is distinct from every string, including "global".
 */
export function listCacheScope(args: { partition: string; scope: { kind: string; tenantId?: string }; scopeId: string; cacheScopeKey?: string | undefined }): string {
  const owner = args.scope.kind === "tenant" ? ["tenant", args.scope.tenantId ?? null] : ["scope", args.scopeId]
  return serializeCacheKeyPart(["list-scope:v2", args.partition, ...owner, args.cacheScopeKey ?? null])
}

export function assertHttpPaginationParameters(raw: Record<string, unknown>, strategy: "offset" | "cursor"): void {
  const hasCursor = raw.cursor !== undefined || raw.before !== undefined || raw.limit !== undefined
  if (raw.cursor !== undefined && raw.before !== undefined) throw new ValidationError("cursor and before cannot be combined")
  if (hasCursor && strategy !== "cursor") throw new ValidationError("cursor parameters are not enabled for this route")
  if (strategy === "cursor" && hasCursor && (raw.page !== undefined || raw.pageSize !== undefined)) throw new ValidationError("cursor and offset pagination parameters cannot be combined")
}

export function createListHandler<
  TRow extends SelectableRow,
  A,
  B,
  L extends SelectableRow,
  D extends SelectableRow,
>(shared: CrudShared<TRow, A, B, L, D>) {
  const { options, entity } = shared
  if (shared.routes.list) assertCrudRouteBinding(options.requestNormalization, "list", options.moduleKey)
  const cursorTtlMs = options.pagination?.strategy === "cursor" ? options.pagination.cursorTtlMs : undefined
  if (cursorTtlMs !== undefined && !(Number.isSafeInteger(cursorTtlMs) && cursorTtlMs > 0))
    throw new ConfigurationError(`cursorTtlMs for ${options.moduleKey}.list must be a positive safe integer (milliseconds)`)
  // Query limits also carry pagination, count, search-fanout and JSON byte
  // limits, which are enforced separately below; the strict plan budget is
  // compiled once from the budget keys only.
  const queryBudget = compileQueryBudget(options.queryLimits)
  return async (request: Request): Promise<Response> => {
    let requestMetadata: ReturnType<typeof resolveRequestMetadata> | undefined
    try {
      if (!shared.routes.list)
        return frameworkJson({ error: "Method Not Allowed" }, { status: 405 })
      requestMetadata = resolveRequestMetadata(request, shared.deps.resolveClientIp, shared.deps.resolveHttpMetadata?.(request))
      const requestContext = await normalizeCrudRequest({
        request,
        routeKey: "list",
        normalization: options.requestNormalization,
        requestId: requestMetadata.requestId,
        correlationId: requestMetadata.correlationId,
        metadata: { requestId: requestMetadata.requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent },
      })
      const abacBundle = await shared.enforceReadAccess(request, requestContext)
      const readScope = shared.buildReadScope(abacBundle)
      await shared.enforceReadRateLimit(
        "list",
        options.rateLimit?.list,
        request,
        requestContext
      )
      // Field-level query gating: caller filter/search/sort must never touch
      // fields ABAC masks or omits from responses, or those values could be
      // probed via query predicates, search substrings, sort order, and
      // row-count inference. The effective allowlists are the entity-declared
      // lists minus the ABAC query denials.
      const entityFields = entity.fields ?? {}
      const queryDenials = abacBundle
        ? resolveFieldQueryDenials({
            policies: abacBundle.policies,
            moduleKey: options.moduleKey,
            // Every field a caller could reference: fields outside a read
            // allowlist are only denied when they are listed here.
            fields: [...new Set([...Object.keys(abacBundle.fieldCatalog ?? {}), ...Object.keys(entityFields)])],
          })
        : undefined
      const isEntityField = (field: string) => Object.hasOwn(entityFields, field)
      // An undeclared allowlist means NO caller-controlled field is allowed.
      // Every allowlist is intersected with the entity's own declared fields
      // (own-property check) so tenant/version/undeclared columns and
      // prototype keys can never reach a predicate, sort, or column lookup.
      const effectiveAllowlist = (declared: readonly string[] | undefined, denied: readonly string[] | undefined) =>
        [...new Set(declared ?? [])].filter((field) => isEntityField(field) && !(denied ?? []).includes(field))
      const effectiveFilterableColumns = effectiveAllowlist(options.filterableColumns, queryDenials?.filter)
      const effectiveSearchableColumns = effectiveAllowlist(options.searchableColumns, queryDenials?.search)
      const effectiveSortableColumns = effectiveAllowlist(options.sortableColumns, queryDenials?.sort)
      const defaultSortFields = (shared.resolveDefaultSort() ?? []).map((item) => item.field)
      const rawQuery = parseUniqueQueryParameters(request)
      const listQuerySchema = options.validation?.listQuery ?? defaultListQuerySchema
      const parsed = listQuerySchema.parse(rawQuery) as Partial<ReadQuery>
      assertHttpPaginationParameters(rawQuery, options.pagination?.strategy ?? "offset")
      const query: ReadQuery = {
        page: parsed.page ?? 1,
        pageSize: parsed.pageSize ?? 10,
        ...(parsed.sorting !== undefined ? { sorting: parsed.sorting } : {}),
        ...(parsed.filters !== undefined ? { filters: parsed.filters } : {}),
        ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
        ...(parsed.before !== undefined ? { before: parsed.before } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        ...(parsed.fields !== undefined ? { fields: parsed.fields } : {}),
        ...(parsed.consistency !== undefined ? { consistency: parsed.consistency } : {}),
      }
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

      const definition: OperationDefinition<
        { query: ReadQuery },
        ListReadResult<SelectableRow>
      > = {
        key: `${options.moduleKey}.list`,
        kind: "read",
        atomicity: { kind: "standard", mode: "none" },
        execute: async ({ operation, input }) => {
          // Mandatory scopes (structural + ABAC read scope) are trusted: they
          // are conjoined flat with the caller's filter so validateQueryPlan
          // charges only the caller's own predicate to the query budget.
          const structural = buildStructuralScope(
            entity,
            requestContext,
            options.entityScope
          )
          const mandatory: PredicateNode[] = [
            ...(structural ? [markTrustedPredicate(structural)] : []),
            ...(readScope.filter ? [readScope.filter] : []),
          ]
          let search: PredicateNode | undefined
          if (input.query.filters) {
            search = filtersToPredicate(
              input.query.filters,
              effectiveSearchableColumns,
              effectiveFilterableColumns,
              options.filterFieldMeta,
              options.queryLimits,
              options.searchStrategy,
            )
          }
          const conjuncts = [...mandatory, ...(search ? [search] : [])]
          const filter: PredicateNode | undefined = conjuncts.length > 1 ? Predicate.and(...conjuncts) : conjuncts[0]
          const sort =
            parseSortString(input.query.sorting, {
              allowedFields: effectiveSortableColumns,
              ...(options.queryLimits?.maxSortJsonBytes !== undefined ? { maxBytes: options.queryLimits.maxSortJsonBytes } : {}),
            }) ?? shared.resolveDefaultSort()
          const cursorConfig = options.pagination?.strategy === "cursor" ? options.pagination : undefined
          let cursorPayload: CursorPayloadV1 | undefined
          let cursorBindings: Pick<CursorPayloadV1, "routeHash" | "queryHash" | "scopeHash" | "sortHash"> | undefined
          let cursorExpiry: { expiresAt: number } | undefined
          let cursorNow: number | undefined
          if (cursorConfig) {
            if (!sort) throw new ValidationError("cursor pagination requires a configured stable sort")
            if (sort.some(item => !isEntityField(item.field) || (!effectiveSortableColumns.includes(item.field) && !defaultSortFields.includes(item.field)))) throw new ValidationError("cursor sort contains a non-queryable field")
            assertStableCursorSort(sort, cursorConfig.uniqueFields, cursorConfig.nullableFields)
            // Bind everything that changes which rows a page contains or how they
            // are shaped, so a cursor cannot be replayed against another entity
            // (same module, other name or persistence namespace), search/filter,
            // projection, consistency mode or security context.
            cursorBindings = {
              routeHash: await fingerprintJson({ moduleKey: options.moduleKey, entity: { name: entity.name, namespace: entity.namespace ?? null }, route: "list" }),
              queryHash: await fingerprintJson({ filters: input.query.filters ?? null, fields: input.query.fields ?? null, consistency: input.query.consistency ?? null }),
              scopeHash: await fingerprintJson({ scopeId: requestContext.scopeId, cacheScopeKey: readScope.cacheScopeKey ?? null, securityDigest: abacBundle?.securityDigest ?? null }),
              sortHash: await fingerprintJson(sort),
            }
            // Opt-in expiry: one clock read per request sets both the expiry on
            // issued cursors and the reference time used when decoding them.
            if (cursorConfig.cursorTtlMs !== undefined) {
              cursorNow = Date.now()
              cursorExpiry = { expiresAt: cursorNow + cursorConfig.cursorTtlMs }
            }
            const opaque = input.query.cursor ?? input.query.before
            if (opaque) {
              try {
                cursorPayload = await decodeCursor(opaque, cursorConfig.integrity, cursorConfig.maxCursorBytes, cursorNow === undefined ? undefined : { now: cursorNow })
                // With a TTL configured, a cursor issued before it was enabled carries no expiry and would never lapse.
                if (cursorNow !== undefined && cursorPayload.expiresAt === undefined) throw new ValidationError("cursor has no expiry")
                assertCursorBinding(cursorPayload, cursorBindings)
              } catch (error) {
                // Malformed, tampered, expired, signed by a retired key, or bound to
                // another entity/query/scope (including every cursor issued before
                // the bindings changed): the client can only start over.
                if (error instanceof ValidationError) throw new StaleCursorError(error)
                throw error
              }
              if (cursorPayload.direction !== (input.query.before ? "before" : "after")) throw new ValidationError("cursor direction does not match the request parameter")
            }
          }
          const requestedProjection = parseProjection(input.query.fields)
          validateQueryPlan({ ...(filter ? { filter } : {}), ...(sort ? { sort } : {}), ...(requestedProjection ? { projection: requestedProjection } : {}), ...(input.query.consistency ? { consistency: input.query.consistency } : {}) }, queryBudget)
          if (requestedProjection && requestedProjection.fields.some(field => !isEntityField(field) || queryDenials?.filter.includes(field) || queryDenials?.search.includes(field) || queryDenials?.sort.includes(field))) throw new ValidationError("projection contains a forbidden, hidden, or non-queryable field")
          const repositoryProjection = requestedProjection && !abacBundle && typeof options.crud?.list?.projectResult !== "function"
            ? { fields: [...new Set([...requestedProjection.fields, ...(cursorConfig ? (sort ?? []).map(item => item.field) : [])])] }
            : undefined
          const raw = await internalRepositoryForDescriptor(operation.persistence, entity).findMany({
            ...(filter ? { filter } : {}),
            ...(sort ? { sort } : {}),
            ...(repositoryProjection ? { projection: repositoryProjection } : {}),
            ...(input.query.consistency ? { consistency: input.query.consistency } : {}),
            pagination: cursorConfig
              ? { kind: "cursor", direction: cursorPayload?.direction ?? "after", ...(cursorPayload ? { values: cursorPayload.values } : {}), limit: input.query.limit ?? input.query.pageSize }
              : { kind: "offset", page: input.query.page, pageSize: input.query.pageSize },
          })
          if (options.queryLimits?.maxCount !== undefined && raw.rowCount > options.queryLimits.maxCount) {
            throw new ValidationError(`query result count exceeds the configured maximum of ${options.queryLimits.maxCount}`)
          }
          let pageInfo = raw.pageInfo?.kind === "cursor" ? raw.pageInfo : undefined
          if (cursorConfig && cursorBindings && raw.rows.length > 0 && sort) {
            const valuesFor = (row: Record<string, unknown>) => sort.map(item => {
              const value = row[item.field]
              if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
              if (value instanceof Date) return value.toISOString()
              throw new ValidationError(`cursor sort field '${item.field}' is not durable-codec serializable`)
            })
            const first = raw.rows[0] as Record<string, unknown>
            const last = raw.rows.at(-1) as Record<string, unknown>
            pageInfo = {
              kind: "cursor",
              hasNextPage: pageInfo?.hasNextPage ?? false,
              hasPreviousPage: pageInfo?.hasPreviousPage ?? false,
              startCursor: await encodeCursor({ format: "framework.cursor", version: 1, direction: "before", values: valuesFor(first), ...cursorBindings, ...cursorExpiry }, cursorConfig.integrity, cursorConfig.maxCursorBytes),
              endCursor: await encodeCursor({ format: "framework.cursor", version: 1, direction: "after", values: valuesFor(last), ...cursorBindings, ...cursorExpiry }, cursorConfig.integrity, cursorConfig.maxCursorBytes),
            }
          }
          return {
            rows: raw.rows as unknown as SelectableRow[],
            rowCount: raw.rowCount,
            page: raw.page,
            pageSize: raw.pageSize,
            ...(pageInfo ? { pageInfo } : {}),
          }
        },
        after: async ({ operation, input: _input, result }) => {
          const requestedProjection = parseProjection(_input.query.fields)
          if (requestedProjection && requestedProjection.fields.some(field => !isEntityField(field) || queryDenials?.filter.includes(field) || queryDenials?.search.includes(field) || queryDenials?.sort.includes(field))) {
            throw new ValidationError("projection contains a forbidden, hidden, or non-queryable field")
          }
          const primaryKey = entity.primaryKey ?? "id"
          // Decide each row's visibility from its trusted durable row so an
          // enrichment hook cannot rewrite policy-driving attributes. Durable
          // rows are authorized and projected BEFORE the representation hook
          // sees them, so a hook can never detach a row from its plan.
          const durableRows = result.rows
          // Internal identity tokens come from the trusted durable rows BEFORE
          // projection, so the order/cardinality contract never depends on
          // whether the ABAC plan happens to leave the primary key visible.
          const durableKeys = durableRows.map((row) => String(row[primaryKey]))
          const projectedRows = durableRows.map((durableRow) =>
            projectResponseRecord({
              entity,
              record: durableRow,
              // The visibility plan is decided against the trusted durable row.
              ...(abacBundle
                ? {
                    overrides: resolveFieldReadOverrides({
                      policies: abacBundle.policies,
                      moduleKey: options.moduleKey,
                      record: durableRow,
                    }),
                  }
                : {}),
            })
          )
           if (!options.crud?.list?.projectResult) {
            return { ...result, rows: projectedRows.map(row => applyProjection(row, requestedProjection)) }
          }
           const enriched = await options.crud.list.projectResult({
            result: {
              ...result,
              rows: projectedRows as unknown as L[],
            },
             context: toCrudReadContext(requestContext, operation),
          })
          // The hook must preserve the durable row set: same length and same
          // primary-key identity at every index. Reordering, adding, removing,
          // duplicating, or fabricating rows would otherwise escape the
          // already-applied field-visibility plan without re-authorization.
          if (enriched.rows.length !== durableRows.length)
            throw new ForbiddenError(
                `The 'projectResult' hook for ${options.moduleKey}.list returned ${enriched.rows.length} rows for ${durableRows.length} durable rows; list projection hooks must return the same row set`
            )
          for (let index = 0; index < durableRows.length; index += 1) {
            // Identity integrity beyond the primary key cannot be proven from
            // projected data — the hook only ever receives projected rows and
            // the internal durable tokens never leave this scope. The
            // enforceable contract is therefore (a) equal length and (b) the
            // hook did not falsify the primary key at index i when it is
            // visible. A masked/omitted primary key is allowed because the hook
            // cannot forge it from the projected payload.
            const hookKey = enriched.rows[index]?.[primaryKey]
            if (hookKey !== undefined && String(hookKey) !== durableKeys[index])
              throw new ForbiddenError(
                `The 'projectResult' hook for ${options.moduleKey}.list changed, reordered, duplicated, removed, or fabricated the row at index ${index}; list projection hooks must preserve row identity`
              )
          }
          return {
            ...enriched,
            rows: enriched.rows.map((row, index) => applyProjection(projectResponseRecord({
              entity,
              record: row,
              ...(abacBundle
                ? { overrides: resolveFieldReadOverrides({ policies: abacBundle.policies, moduleKey: options.moduleKey, record: durableRows[index]! }) }
                : {}),
            }), requestedProjection)),
          }
        },
      }
      if (options.queryLimits?.maxOffset !== undefined && (query.page - 1) * query.pageSize > options.queryLimits.maxOffset) {
        throw new ValidationError(`pagination offset exceeds the configured maximum of ${options.queryLimits.maxOffset}`)
      }

        const transformedQuery = options.crud?.list?.transformQuery
        ? (await runOperation<{ query: ReadQuery }, { query: ReadQuery }>({
            operation: readEnvironment,
            definition: {
              key: `${options.moduleKey}.list`,
              kind: "read",
              atomicity: { kind: "standard", mode: "none" },
              execute: async ({ operation, input }) => {
                  const hookResult = await options.crud!.list!.transformQuery!({
                  query: input.query,
                   context: toCrudReadContext(requestContext, operation),
                })
                return { query: hookResult?.query ? { ...input.query, ...hookResult.query } : input.query }
              },
            },
            input: { query },
          })).query
        : query

      // Hooks may return values that did not come from the request schema.
      // Normalize and bound the transformed query before caching or execution.
      const transformedParsed = listQuerySchema.parse(transformedQuery) as Partial<ReadQuery>
      const validatedTransformedQuery: ReadQuery = {
        page: transformedParsed.page ?? 1,
        pageSize: transformedParsed.pageSize ?? 10,
        ...(transformedParsed.sorting !== undefined ? { sorting: transformedParsed.sorting } : {}),
        ...(transformedParsed.filters !== undefined ? { filters: transformedParsed.filters } : {}),
        ...(transformedParsed.cursor !== undefined ? { cursor: transformedParsed.cursor } : {}),
        ...(transformedParsed.before !== undefined ? { before: transformedParsed.before } : {}),
        ...(transformedParsed.limit !== undefined ? { limit: transformedParsed.limit } : {}),
        ...(transformedParsed.fields !== undefined ? { fields: transformedParsed.fields } : {}),
        ...(transformedParsed.consistency !== undefined ? { consistency: transformedParsed.consistency } : {}),
      }
      parseProjection(validatedTransformedQuery.fields)
      if (
        options.queryLimits?.maxOffset !== undefined
        && (validatedTransformedQuery.page - 1) * validatedTransformedQuery.pageSize > options.queryLimits.maxOffset
      ) {
        throw new ValidationError(`pagination offset exceeds the configured maximum of ${options.queryLimits.maxOffset}`)
      }
      const maxFilterBytes = options.queryLimits?.maxFilterJsonBytes ?? DEFAULT_MAX_QUERY_JSON_BYTES
      if (validatedTransformedQuery.filters !== undefined && new TextEncoder().encode(validatedTransformedQuery.filters).byteLength > maxFilterBytes) {
        throw new ValidationError(`Filters JSON exceeds the maximum of ${maxFilterBytes} UTF-8 bytes`)
      }
      const maxSortBytes = options.queryLimits?.maxSortJsonBytes ?? DEFAULT_MAX_QUERY_JSON_BYTES
      if (validatedTransformedQuery.sorting !== undefined && new TextEncoder().encode(validatedTransformedQuery.sorting).byteLength > maxSortBytes) {
        throw new ValidationError(`Sorting JSON exceeds the maximum of ${maxSortBytes} UTF-8 bytes`)
      }

      const resolveList = () =>
        runOperation<{ query: ReadQuery }, ListReadResult<SelectableRow>>({
          operation: readEnvironment,
          definition,
           input: { query: validatedTransformedQuery },
        })
      const cachePartition = deriveSecurityCachePartition({
        bundle: abacBundle,
        context: requestContext,
        cacheScopeKey: readScope.cacheScopeKey,
          hasRepresentationHook: typeof options.crud?.list?.projectResult === "function",
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
                listCacheScope({ partition: cachePartition.partition, scope: requestContext.scope, scopeId: requestContext.scopeId, cacheScopeKey: readScope.cacheScopeKey }),
                serializeCacheKeyPart({ type: "list", query: validatedTransformedQuery })
              ),
              resolveList,
              shared.buildReadTags(requestContext)
            )
          : await resolveList()
      if (
        result &&
        options.audit?.readAudit &&
        options.auditSinkFactory &&
        requestContext.identity.actor.kind !== "anonymous"
      ) {
        try {
          await options.auditSinkFactory(requestContext).write(
            buildAuditRecord({
              id: crypto.randomUUID(),
              occurredAt: new Date(),
              actor: requestContext.identity.actor,
              action: `${options.audit.resource}.readList`,
              resourceType: options.audit.resource,
              resourceId: "",
              tenantId: requestContext.scope.kind === "tenant" ? requestContext.scope.tenantId : null,
              metadata: {
                ipAddress: getRequestIp(request, shared.deps.resolveClientIp, shared.deps.resolveHttpMetadata),
                userAgent: requestMetadata.userAgent,
                scopeId: requestContext.scopeId,
                page: result.page,
                pageSize: result.pageSize,
                resultCount: result.rowCount,
                // Bounded query fingerprint so audit records stay small and
                // never dump the caller's filter values or record set.
                 queryFingerprint: await fingerprintJson(validatedTransformedQuery),
              },
            })
          )
        } catch {
          // Best-effort read audit: a sink or hashing failure must not fail the read.
        }
      }
      return withReadMetadata(frameworkJson(result), requestMetadata)
    } catch (error) {
      if (error instanceof StaleCursorError) {
        const response = frameworkJson({ error: STALE_CURSOR_MESSAGE, code: "VALIDATION_ERROR" }, { status: 400 })
        if (requestMetadata?.requestId) response.headers.set("x-request-id", requestMetadata.requestId)
        if (requestMetadata?.correlationId) response.headers.set("x-correlation-id", requestMetadata.correlationId)
        return response
      }
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
