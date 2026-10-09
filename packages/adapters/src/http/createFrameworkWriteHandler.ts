import type { ValidationSchema } from "core/kernel"
import { createOperationContext } from "core/operation"
import { CanonicalJsonError } from "core/serialization"
import { enforceRateLimit, type RateLimitConfig, type RateLimitStore } from "core/rate-limit"
import { isAtomicBatchIdempotencyPort, isDurableIdempotencyPort, isTransactionalIdempotencyPort, type IdempotencyCommitItem, type IdempotencyResourceIdentity } from "core/events"
import type { AbacWriteEnforcer } from "core/security"
import { emitTelemetry, explicitlySafeTelemetryAttributes } from "core/telemetry"
import { ConfigurationError, ConflictError, ForbiddenError, UnauthorizedError, ValidationError, assertVerifiedAbacBundle, createAbacAuthorizer, type RequestContext } from "core/domain"
import { redactPhiDeep } from "./redact"
import type { FrameworkAdapterDeps, FrameworkRequestNormalization } from "../server"
import { assertFrameworkAdapterDeps } from "../server"
import type { OperationDefinition } from "core/operation"
import { runOperation } from "core/operation"
import type { CapabilityCheckConfig } from "core/entity"
import type { AtomicBatchItem, PersistenceProvider } from "core/persistence"
import { createTenantScopedIdempotencyPort, createTenantScopedPersistenceProvider, encodeTenantIdempotencyScope } from "core/persistence"
import type { RuntimeCapabilities } from "core/bootstrap"
import { CacheBackedRateLimitStore } from "../cache"
import { CacheService } from "core/cache"
import { createFrameworkErrorHandler, frameworkJson } from "./handleFrameworkCoreError"
import { parseJsonBodySafely, parseUniqueQueryParameters, resolveRequestMetadata } from "./requestBody"
import type { CacheAdapter } from "core/cache"
import type { AuditSink, OutboxSink } from "core/events"
import { boundRateLimitKeyMaterial, buildIdempotencyScopeIdentity, buildIdempotencySecurityContext, deserializeResponse, fingerprintJson, legacyFingerprintJson, MAX_IDEMPOTENCY_KEY_LENGTH, serializeResponse, type SerializedResponse, type SerializedResponseIdempotencyPort } from "./idempotency"
import { authorizeFrameworkModule, normalizeCrudRequest, tenantIdFromContext } from "./crudHandlers/shared"

const frameworkErrorHandler = createFrameworkErrorHandler()

type InternalCommitMarker = {
  name: string
  commit?: (result: unknown, persistence: PersistenceProvider) => Promise<void>
  batchItem?: (result: unknown) => AtomicBatchItem<unknown> | undefined | Promise<AtomicBatchItem<unknown> | undefined>
}

export type ScopedFrameworkValidation = {
  params?: ValidationSchema
  query?: ValidationSchema
  body?: ValidationSchema
  bodyMaxBytes?: number
}

export type ScopedFrameworkValidatedContext = {
  validatedParams?: unknown
  validatedQuery?: unknown
  validatedBody?: unknown
}

export type CrudScopeConfig = {
  scope: "application" | "tenant" | "platform" | "system" | "public"
  sessionRequired?: boolean
  csrfRequired?: boolean
  idempotency?: { required?: boolean }
}

function getCookieValue(name: string, request: Request): string | null {
  const header = request.headers.get("cookie")
  if (!header) return null
  for (const part of header.split("; ")) {
    const eqIdx = part.indexOf("=")
    if (eqIdx === -1) continue
    if (part.slice(0, eqIdx).trim() === name) return part.slice(eqIdx + 1)
  }
  return null
}

/**
 * The client-sent material behind a validated request. Idempotency identity is
 * derived from this JSON-shaped input, never from schema output, which may hold
 * Dates, undefined members, or other values with no canonical JSON form.
 */
type RawClientMutation = {
  params?: unknown
  query?: unknown
  body?: unknown
}

async function enrichValidatedContext(args: {
  request: Request
  context?: { params?: Promise<unknown> }
  validation?: ScopedFrameworkValidation
}): Promise<{ validated: ScopedFrameworkValidatedContext; raw: RawClientMutation }> {
  const raw: RawClientMutation = {}
  const rawParams = args.context?.params ? await args.context.params : undefined
  const validatedParams = args.validation?.params
    ? args.validation.params.parse(rawParams)
    : undefined
  if (args.validation?.params && rawParams !== undefined) raw.params = rawParams

  const queryObject = parseUniqueQueryParameters(args.request)
  const validatedQuery = args.validation?.query
    ? args.validation.query.parse(queryObject)
    : undefined
  if (args.validation?.query) raw.query = queryObject

  // Wrap the body schema to observe the parsed JSON before validation.
  const bodySchema = args.validation?.body
  const capturingSchema: ValidationSchema | undefined = bodySchema
    ? {
        parse: (value: unknown) => { raw.body = value; return bodySchema.parse(value) },
        parseAsync: (value: unknown) => { raw.body = value; return bodySchema.parseAsync(value) },
      }
    : undefined
  const validatedBody = await parseJsonBodySafely(args.request, capturingSchema, args.validation?.bodyMaxBytes)

  return { validated: { validatedParams, validatedQuery, validatedBody }, raw }
}

async function fingerprintClientMutation(value: unknown, fingerprint: (value: unknown) => Promise<string> = fingerprintJson): Promise<string> {
  try {
    return await fingerprint(value)
  } catch (error) {
    // The client controls this material; anything without a canonical JSON
    // form (e.g. a "__proto__" member or an unsafe integer) is a bad request.
    if (error instanceof CanonicalJsonError) throw new ValidationError("Request cannot be used with an Idempotency-Key")
    throw error
  }
}

function resolveSessionRequired(scope: CrudScopeConfig): boolean {
  return scope.sessionRequired ?? scope.scope !== "public"
}

function resolveCsrfRequired(scope: CrudScopeConfig): boolean {
  return scope.csrfRequired ?? scope.scope !== "public"
}

export function createFrameworkWriteHandler<
  TInput,
  TResult,
  TExisting extends object = { [key: string]: unknown },
>(args: {
  adapterDeps: FrameworkAdapterDeps
  requestNormalization: FrameworkRequestNormalization
  scope: CrudScopeConfig
  moduleKey: string
  action: "create" | "update" | "delete"
  validation?: ScopedFrameworkValidation
   rateLimit?: { config: RateLimitConfig; consistency?: "atomic" | "best-effort"; failureMode?: import("core/rate-limit").RateLimitFailureMode; key?: (request: Request, context: RequestContext) => string }
   getRateLimitStore?: () => Promise<RateLimitStore>
  getCacheAdapter?: () => Promise<CacheAdapter>
   runtimeCapabilities?: RuntimeCapabilities
    auditSinkFactory?: (context: RequestContext, persistence?: PersistenceProvider) => AuditSink
  outboxSinkFactory?: (context: RequestContext, persistence?: PersistenceProvider) => OutboxSink
  invalidateTags?: (validated: ScopedFrameworkValidatedContext, context: RequestContext) => string[] | Promise<string[]>
  createPersistence: (context: RequestContext) => PersistenceProvider
  definition: OperationDefinition<TInput, TResult>
  resolveInput: (args: {
    request: Request
    validated: ScopedFrameworkValidatedContext
    context: RequestContext
    existing?: TExisting
  }) => Promise<TInput>
  resolveExistingRecord?: (args: {
    request: Request
    validated: ScopedFrameworkValidatedContext
    context: RequestContext
  }) => Promise<TExisting | undefined>
  /** Stable resource identity used to build the durable commit receipt. */
  resolveResourceIdentity?: (args: {
    input: TInput
    context: RequestContext
  }) => IdempotencyResourceIdentity
  /**
   * Rebuilds a safe committed response for a business-committed row that lost
   * its in-flight finalization, by rereading the resource under the current
   * verified security context. Generic operations may omit this and receive a
   * deterministic business-committed outcome instead.
   */
  recoverCommittedResponse?: (args: {
    resource: IdempotencyResourceIdentity
    context: RequestContext
  }) => Promise<TResult | null>
  toResponse?: (result: TResult) => Response
} & CapabilityCheckConfig) {
  assertFrameworkAdapterDeps(args.adapterDeps)

  // Correctness-critical cache invalidation requires a durable obligation, which
  // is only available when the mutation participates in idempotency.
  if (args.invalidateTags && args.scope.idempotency?.required !== true) {
    throw new ConfigurationError(
      `"${args.moduleKey}" configures correctness-critical invalidateTags without required idempotency; durable cache invalidation needs idempotency`,
    )
  }
  if (args.invalidateTags && !args.getCacheAdapter) {
    throw new ConfigurationError(
      `"${args.moduleKey}" configures invalidateTags without a cache adapter provider`,
    )
  }
  if (args.definition.audit?.auditGuarantee === "durable" && !args.outboxSinkFactory) {
    throw new ConfigurationError(
      `"${args.moduleKey}" configures durable audit guarantee without an outboxSinkFactory`,
    )
  }
  // A durable commit receipt can outlive the request that produced it. Every
  // handler that can create one must therefore have a safe, non-mutating way
  // to rebuild the committed response after a crash.
  if (args.scope.idempotency?.required === true && (!args.resolveResourceIdentity || !args.recoverCommittedResponse)) {
    throw new ConfigurationError(
      `Idempotent write handler "${args.moduleKey}" requires a resource identity and recoverCommittedResponse`,
    )
  }
  return async (request: Request, context?: { params?: Promise<unknown> }) => {
    let requestMetadata = resolveRequestMetadata(request)
    const responseWithMetadata = (response: Response, metadata: ReturnType<typeof resolveRequestMetadata>): Response => {
      response.headers.set("x-request-id", metadata.requestId)
      if (metadata.correlationId) response.headers.set("x-correlation-id", metadata.correlationId)
      response.headers.set("cache-control", "no-store")
      return response
    }
    try {
      const deps = args.adapterDeps
       requestMetadata = resolveRequestMetadata(request, deps.resolveClientIp, deps.resolveHttpMetadata?.(request))
      const capabilityMode = args.skipCapabilityCheck === true
        ? { enabled: false as const, key: undefined }
        : args.customCapabilityKey
          ? { enabled: true as const, key: args.customCapabilityKey }
          : null

      if (!capabilityMode) {
        throw new ConfigurationError(
          `Write handler for "${args.moduleKey}" must either declare customCapabilityKey or set skipCapabilityCheck: true`,
        )
      }

      const { validated, raw: rawClientMutation } = await enrichValidatedContext({ request, ...(context ? { context } : {}), ...(args.validation ? { validation: args.validation } : {}) })
      const validatedParams = validated.validatedParams && typeof validated.validatedParams === "object"
        ? Object.fromEntries(Object.entries(validated.validatedParams as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
        : undefined
      const requestContext = await normalizeCrudRequest({
        request,
        routeKey: args.action,
        normalization: args.requestNormalization,
        requestId: requestMetadata.requestId,
        correlationId: requestMetadata.correlationId,
        ...(validatedParams === undefined ? {} : { pathParameters: validatedParams }),
        metadata: { requestId: requestMetadata.requestId, ipAddress: requestMetadata.ipAddress, userAgent: requestMetadata.userAgent },
      })
      if (resolveCsrfRequired(args.scope)) deps.assertValidCsrf(request)
      if (requestContext.identity.actor.kind === "anonymous") throw new UnauthorizedError()

      let abacBundle = null

       {
         abacBundle = await deps.resolveAbacBundle({
          moduleKey: args.moduleKey,
          context: requestContext,
        })

        if (!abacBundle) {
          throw new ForbiddenError("ABAC authorization bundle unavailable")
        }
        assertVerifiedAbacBundle(abacBundle)
       }

       authorizeFrameworkModule({
         deps,
         moduleKey: args.moduleKey,
         action: args.action,
         ...(capabilityMode.enabled ? { capabilityKey: capabilityMode.key } : {}),
         context: requestContext,
         bundle: abacBundle,
       })

        const rateLimitConsistency = args.rateLimit?.consistency ?? args.rateLimit?.config.consistency ?? "atomic"
        const needsCache = Boolean(args.invalidateTags || (args.rateLimit && rateLimitConsistency !== "atomic"))
        const cacheAdapter = needsCache && args.getCacheAdapter ? await args.getCacheAdapter() : null
        if (args.invalidateTags && !cacheAdapter) {
          throw new ConfigurationError(`Cache invalidation for "${args.moduleKey}" requires an available cache adapter`)
        }

       if (args.rateLimit) {
         if (rateLimitConsistency !== "atomic" && !cacheAdapter) {
           throw new ConfigurationError(
             `Rate limit configured for "${args.moduleKey}" but no cache adapter is available`,
           )
         }

          const consistency = rateLimitConsistency
          const rateLimitStore = consistency === "atomic"
            ? args.getRateLimitStore ? await args.getRateLimitStore() : null
             : new CacheBackedRateLimitStore(cacheAdapter!)
          if (!rateLimitStore) {
            throw new ConfigurationError(`Atomic rate limit for "${args.moduleKey}" requires an atomic rate-limit store`)
          }
         const customKey = args.rateLimit.key?.(request, requestContext)
         const customMaterial = customKey !== undefined ? await boundRateLimitKeyMaterial(customKey) : undefined
         // Always namespace by module and action so a custom key cannot collide
         // across endpoints; the bounded custom segment is appended last.
         const rateKey = `${requestContext.scopeId}:${args.moduleKey}:${args.action}:${customMaterial ?? `${requestContext.identity.actor.id}:${requestMetadata.ipAddress}`}`
         await enforceRateLimit({
           store: rateLimitStore,
           key: rateKey,
           config: args.rateLimit.config,
             consistency,
            ...(args.rateLimit.failureMode !== undefined ? { failureMode: args.rateLimit.failureMode } : {}),
         })
      }

      const authorizer = abacBundle ? createAbacAuthorizer(abacBundle) : null
      const enforceAbac: AbacWriteEnforcer | undefined = authorizer
         ? { enforce: (action: string, record: Record<string, unknown>, changedFields?: string[]) => authorizer.assertWrite({ action: action as "create" | "update" | "delete", record, ...(changedFields ? { changedFields } : {}) }) }
        : undefined

       const basePersistence = args.createPersistence(requestContext)
        const operationPersistence = requestContext.scope.kind === "tenant"
          ? createTenantScopedPersistenceProvider(basePersistence, requestContext.scope.tenantId)
          : basePersistence
         const auditSinkFactory = args.auditSinkFactory
           ? { create: (persistence: PersistenceProvider) => args.auditSinkFactory!(requestContext, persistence) }
           : undefined
         const outboxSinkFactory = args.outboxSinkFactory
           ? { create: (persistence: PersistenceProvider) => args.outboxSinkFactory!(requestContext, persistence) }
           : undefined

        const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || undefined
        if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
          throw new ValidationError("Idempotency-Key is too long")
        }
         if (args.scope.idempotency?.required && !idempotencyKey) {
           throw new ValidationError("Idempotency-Key header is required")
         }
         if (idempotencyKey && (!args.resolveResourceIdentity || !args.recoverCommittedResponse)) {
           throw new ConfigurationError(
             `Idempotent write handler "${args.moduleKey}" requires a resource identity and recoverCommittedResponse`,
           )
         }

        const serializeBusinessResult = async (businessResult: TResult): Promise<SerializedResponse> => {
          const response = args.toResponse ? args.toResponse(businessResult) : frameworkJson(businessResult)
          return serializeResponse(response.clone())
        }
        // The invalidation obligation is computed once and persisted with the
        // durable idempotency marker, so physical cache invalidation is retried
        // (replay + finalizer) even if the original request never returns.
        const invalidationTags: string[] | undefined = args.invalidateTags
          ? await args.invalidateTags(validated, requestContext)
          : undefined
        const atomicCacheGeneration = invalidationTags !== undefined && operationPersistence.capabilities.atomicBatchCacheGeneration === true
        if (invalidationTags) {
          const MAX_INVALIDATION_TAGS = 50
          const MAX_TAG_BYTES = 255
          if (invalidationTags.length > MAX_INVALIDATION_TAGS) {
            throw new ConfigurationError(`Invalidation tag count ${invalidationTags.length} exceeds maximum ${MAX_INVALIDATION_TAGS}`)
          }
          for (const tag of invalidationTags) {
            if (new TextEncoder().encode(tag).length > MAX_TAG_BYTES) {
              throw new ConfigurationError(`Invalidation tag "${tag}" exceeds maximum byte length of ${MAX_TAG_BYTES}`)
            }
          }
        }
        const invalidateAfterCommit = async (): Promise<void> => {
          if (!invalidationTags || atomicCacheGeneration) return
          if (!cacheAdapter) throw new ConfigurationError(`Cache invalidation for "${args.moduleKey}" requires an available cache adapter`)
          await new CacheService({ adapter: cacheAdapter, correctnessCritical: true }).invalidateTags(invalidationTags)
        }

        let idempotency: { port: SerializedResponseIdempotencyPort; request: { scope: string; key: string; fingerprint: string; leaseDurationMs: number }; token: string } | undefined
        if (idempotencyKey) {
          if (!deps.createIdempotencyPort) {
            throw new ConfigurationError(`Idempotency is not configured for "${args.moduleKey}"`)
          }
          const securityContext = buildIdempotencySecurityContext(requestContext)
          const scopeIdentity = buildIdempotencyScopeIdentity(requestContext)
           const tenantId = tenantIdFromContext(requestContext)
           const scope = tenantId
             ? `${encodeTenantIdempotencyScope(tenantId)}:${args.moduleKey}:${args.action}:principal:${scopeIdentity}`
             : `${requestContext.scopeId}:${args.moduleKey}:${args.action}:principal:${scopeIdentity}`
           const fingerprintMaterial = {
              moduleKey: args.moduleKey,
              action: args.action,
              securityContext,
              // What the client sent (raw JSON body, path params, query). Raw
              // equality implies validated equality for a deterministic schema.
              clientMutation: {
                ...(rawClientMutation.params !== undefined ? { params: rawClientMutation.params } : {}),
                ...(rawClientMutation.query !== undefined ? { query: rawClientMutation.query } : {}),
                ...(rawClientMutation.body !== undefined ? { body: rawClientMutation.body } : {}),
              },
              // Semantic concurrency preconditions must be part of the identity.
              preconditions: {
                ...(request.headers.get("if-match") ? { ifMatch: request.headers.get("if-match") } : {}),
                ...(request.headers.get("if-none-match") ? { ifNoneMatch: request.headers.get("if-none-match") } : {}),
              },
              // A replay is only valid under the exact policy bundle that
              // authorized the original mutation.
              abacSecurityDigest: abacBundle?.securityDigest ?? null,
            }
           const idempotencyRequest = {
             scope,
             key: idempotencyKey,
            fingerprint: await fingerprintClientMutation(fingerprintMaterial),
            leaseDurationMs: 30_000,
          }
          const port: import("core/events").IdempotencyPort<SerializedResponse> = tenantId
            ? (() => {
               return createTenantScopedIdempotencyPort(
                 deps.createIdempotencyPort<SerializedResponse>({ context: requestContext }),
                 tenantId,
               )
            })()
            : deps.createIdempotencyPort<SerializedResponse>({ context: requestContext })
          // A mutation may only run when the port can join the business commit
          // boundary (transaction or atomic batch). A port that can only mark
          // committed afterward recreates the exactly-once crash window.
          if (!isDurableIdempotencyPort(port)) {
            throw new ConfigurationError(
              `Idempotency for "${args.moduleKey}" requires a transaction- or atomic-batch-integrated idempotency port`,
            )
          }
          let acquired = await port.acquire(idempotencyRequest)
          if (acquired.outcome === "conflict") {
            // A record written before the RFC 8785 key-order fix carries the v2
            // fingerprint of the same request. Retry once with it so a retry
            // across that deploy replays instead of conflicting; the lease then
            // keeps the stored fingerprint for renew/complete.
            const legacyFingerprint = await fingerprintClientMutation(fingerprintMaterial, legacyFingerprintJson)
            if (legacyFingerprint !== idempotencyRequest.fingerprint) {
              const legacy = await port.acquire({ ...idempotencyRequest, fingerprint: legacyFingerprint })
              if (legacy.outcome !== "conflict") {
                idempotencyRequest.fingerprint = legacyFingerprint
                acquired = legacy
              }
            }
          }
          if (acquired.outcome === "replay") {
            return responseWithMetadata(deserializeResponse(acquired.result), requestMetadata)
          }
          if (acquired.outcome === "business-committed") {
            const resource = acquired.resource
            // Replay the durable receipt, never tags recomputed for this retry.
            // Replay the receipt's obligations before rebuilding the response.
             if (acquired.invalidations && !atomicCacheGeneration) {
              if (!cacheAdapter) {
                throw new ConfigurationError(`Cache invalidation for "${args.moduleKey}" requires an available cache adapter`)
              }
              await new CacheService({ adapter: cacheAdapter, correctnessCritical: true }).invalidateTags([...acquired.invalidations])
            }
            if (resource && args.recoverCommittedResponse) {
              const recovered = await args.recoverCommittedResponse({ resource, context: requestContext })
              if (recovered !== null) {
                const serialized = await serializeBusinessResult(recovered)
                // Complete the row to establish stable replay for future retries
                await port.complete({
                  ...idempotencyRequest,
                  token: acquired.token,
                  result: serialized,
                  ...(resource ? { resource } : {}),
                  ...(acquired.invalidations ? { invalidations: acquired.invalidations } : {}),
                })
                return responseWithMetadata(deserializeResponse(serialized), requestMetadata)
              }
              // A null result is a terminal, authorized recovery outcome (for
              // example, the committed resource was deleted). Persist a stable
              // response so this receipt is replayable on every later retry.
              const terminalResponse = frameworkErrorHandler(
                new ConflictError("The committed resource is no longer available"),
                requestMetadata,
              )
              const serialized = await serializeResponse(terminalResponse.clone())
              await port.complete({
                ...idempotencyRequest,
                token: acquired.token,
                result: serialized,
                ...(resource ? { resource } : {}),
                ...(acquired.invalidations ? { invalidations: acquired.invalidations } : {}),
              })
              return responseWithMetadata(deserializeResponse(serialized), requestMetadata)
            }
            throw new ConflictError("The mutation for this Idempotency-Key committed without a replayable response")
          }
          if (acquired.outcome === "conflict") throw new ConflictError("Idempotency-Key was reused for a different mutation")
          if (acquired.outcome === "in-progress") throw new ConflictError("The mutation for this Idempotency-Key is already in progress")
          idempotency = { port, request: idempotencyRequest, token: acquired.token }
        }

        // Resource identity is resolved only AFTER the idempotency decision. A
        // retry of a committed DELETE/UPDATE must replay the stored response
        // even when the row is now gone, soft-deleted, or out of scope; the
        // fingerprint above depends only on validated request material, the
        // preconditions, and the ABAC digest, never on the current row.
        // A failure before commit releases the reservation so an immediate
        // retry is not blocked as "in progress" until the lease lapses. The
        // port only deletes an uncommitted reservation it still owns.
        const abandonIdempotency = async (): Promise<void> => {
          if (!idempotency?.port.abandon) return
          try {
            await idempotency.port.abandon({ ...idempotency.request, token: idempotency.token })
          } catch (error) {
            if (deps.telemetry) emitTelemetry(deps.telemetry, { name: "idempotency.abandon.failure", severity: "warn", timestamp: new Date(), attributes: explicitlySafeTelemetryAttributes({ phase: "idempotency-abandon", errorType: error instanceof Error ? error.name : "unknown" }) })
          }
        }
        let existing: Awaited<ReturnType<NonNullable<typeof args.resolveExistingRecord>>> | undefined
        let input: TInput
        try {
          existing = args.resolveExistingRecord
            ? await args.resolveExistingRecord({ request, validated, context: requestContext })
            : undefined
          input = await args.resolveInput({ request, validated, context: requestContext, ...(existing !== undefined ? { existing } : {}) })
        } catch (error) {
          await abandonIdempotency()
          throw error
        }

        // The durable receipt joins the business commit boundary: in-transaction
        // for transactional adapters, in-batch for atomic-batch adapters. The
        // receipt never carries a replayable response.
        const useInBatchMarker = idempotency !== undefined &&
          isAtomicBatchIdempotencyPort(idempotency.port) &&
          operationPersistence.capabilities.atomicBatchIdempotency === true
        if (idempotency && isAtomicBatchIdempotencyPort(idempotency.port) && !useInBatchMarker) {
          throw new ConfigurationError(
            `"${args.moduleKey}" requires atomic-batch idempotency persistence for the configured D1 idempotency port`,
          )
        }

        const resourceIdentity = args.resolveResourceIdentity
          ? args.resolveResourceIdentity({ input, context: requestContext })
          : undefined

        const cacheGenerationMarkers: InternalCommitMarker[] = atomicCacheGeneration
          ? invalidationTags.map((tag): InternalCommitMarker => ({
              name: `cache-generation:${tag}`,
              batchItem: () => ({ kind: "cache-generation", tag }),
            }))
          : []
        const commitMarkers: InternalCommitMarker[] = [
          ...cacheGenerationMarkers,
          ...(idempotency
          ? (() => {
              const idemPort = idempotency.port
              const lease = { request: idempotency.request, token: idempotency.token }
              const receipt: IdempotencyCommitItem = {
                scope: idempotency.request.scope,
                key: idempotency.request.key,
                fingerprint: idempotency.request.fingerprint,
                token: lease.token,
                ...(resourceIdentity ? { resource: resourceIdentity } : {}),
                ...(!atomicCacheGeneration && invalidationTags ? { invalidations: invalidationTags } : {}),
              }
              const marker: InternalCommitMarker = { name: "idempotency-commit" }
              if (isTransactionalIdempotencyPort(idemPort)) {
                marker.commit = async (_businessResult, persistence) => {
                  await idemPort.markCommittedInTransaction.call(idemPort, receipt, persistence)
                }
              } else if (isAtomicBatchIdempotencyPort(idemPort)) {
                marker.batchItem = () => idemPort.createCommitBatchItem.call(idemPort, receipt)
              }
              return [marker]
            })()
           : []),
        ]

        const operationContext = createOperationContext({
          ...(commitMarkers.length > 0 ? { commitMarkers } : {}),
          persistence: operationPersistence,
         runtimeCapabilities: args.runtimeCapabilities ?? (() => {
           throw new ConfigurationError(`Runtime capabilities are required for "${args.moduleKey}"`)
         })(),
        request: requestContext,
        signal: request.signal,
           ...(args.auditSinkFactory ? { auditSink: args.auditSinkFactory(requestContext, operationPersistence) } : {}),
           ...(auditSinkFactory ? { auditSinkFactory } : {}),
           ...(outboxSinkFactory ? { outboxSinkFactory } : {}),
          ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
         auditSanitizer: redactPhiDeep,
         ...(enforceAbac ? { enforceAbac } : {}),
      })

          let serializedResponse: SerializedResponse | undefined
          let businessResponse: Response | undefined
          let result: TResult
          const heartbeat = idempotency
            ? setInterval(() => {
                void idempotency?.port.renew({ ...idempotency.request, token: idempotency.token }).catch((error: unknown) => {
                  // A lost heartbeat is a liveness signal, not the ownership
                  // fence (the commit boundary asserts ownership). Report it so
                  // lease-loss is operationally visible rather than swallowed.
                  if (deps.telemetry) emitTelemetry(deps.telemetry, { name: "idempotency.heartbeat.failure", severity: "error", timestamp: new Date(), attributes: explicitlySafeTelemetryAttributes({ phase: "idempotency-heartbeat", effectName: "renew", errorType: error instanceof Error ? error.name : "unknown" }) })
                })
              }, Math.max(1_000, Math.floor((idempotency.request.leaseDurationMs ?? 30_000) / 3)))
            : undefined
          try {
            result = await runOperation<TInput, TResult>({
              operation: operationContext,
              definition: args.definition,
              input,
              onBusinessResult: (businessResult) => {
                businessResponse = args.toResponse ? args.toResponse(businessResult) : frameworkJson(businessResult)
                return Promise.resolve()
              },
            })
          } catch (error) {
            if (!idempotency && error && typeof error === "object" && "committed" in error && (error as { committed?: unknown }).committed === true && businessResponse) return businessResponse
            await abandonIdempotency()
            throw error
          } finally {
            if (heartbeat) clearInterval(heartbeat)
          }

          // The durable commit receipt is atomic with the business mutation
          // (in-transaction for transactional adapters, in-batch for
          // non-transactional adapters) and never carries a replayable response.
          // The safe response is produced by the operation's own committed
          // reread/projection phase, serialized here, and written by complete().
          // Physical invalidation runs before finalization so the durable
          // obligation is only cleared after a successful invalidation.
          if (idempotency) {
            try {
              const serialized = await serializeBusinessResult(result)
              serializedResponse = serialized
              await invalidateAfterCommit()
              await idempotency.port.complete({
                ...idempotency.request,
                token: idempotency.token,
                result: serialized,
                ...(resourceIdentity ? { resource: resourceIdentity } : {}),
                ...(!atomicCacheGeneration && invalidationTags ? { invalidations: invalidationTags } : {}),
              })
             } catch (error) {
               // The durable business-committed marker is already present; do
               // not mutate it when response finalization fails.
               throw error
             }
          } else {
            await invalidateAfterCommit()
          }

          const response = serializedResponse ? deserializeResponse(serializedResponse) : businessResponse ?? (args.toResponse ? args.toResponse(result) : frameworkJson(result))
          return responseWithMetadata(response, requestMetadata)
     } catch (error) {
       return frameworkErrorHandler(error, requestMetadata)
    }
  }
}
