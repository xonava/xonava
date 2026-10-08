/* eslint-disable @typescript-eslint/require-await */
import type { OperationDefinition, MutationOperationContext, PreparationOperationContext, AuthorizationOperationContext } from "core/operation"
import {
  ConfigurationError,
  assertAbacSecurityDigest,
  ConflictError,
  hasRecordDependentFieldWrite,
  NotFoundError,
  Predicate,
  projectResponseRecord,
  resolveFieldReadOverrides,
  type PredicateNode,
} from "core/domain"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import { frameworkJson } from "../handleFrameworkCoreError"
import type { CrudShared, MutationResult, SelectableRow, UpdateOperationInput } from "./types"
import { assertEntityVersion, type EntityVersion } from "core/serialization"
import { internalRepositoryForDescriptor } from "../../repository/dynamicRepository"
import {
  auditEmit,
  buildCommittedReadResponse,
  buildStructuralScope,
  loadExistingRecord,
  resolveOperationRequestContext,
  toAuditObject,
  toCrudContext,
  toCrudPostCommitContext,
  assertProtectedUpdateFields,
  loadReadableMutationRecord,
  resolveActionScopeForContext,
  canUseOwnerBypass,
  enforceFinalWrite,
  withScopedPersistence,
} from "./shared"

/**
 * Canonical If-Match concurrency transport parser (RFC 7232 entity-tag).
 * RFC 7232 requires strong comparison for If-Match, so `W/` weak validators
 * are rejected. Only strong validators (`"1"`, `1`) are accepted. The inner
 * value must be a strict non-negative safe-integer decimal string inside (or
 * without) quotes. Absent/empty, weak, or non-canonical headers yield undefined
 * and the caller surfaces a 409 Conflict.
 */
export function parseIfMatchVersion(raw: string | null | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined
  const trimmed = String(raw).trim()
  if (trimmed === "") return undefined
  if (/^W\//i.test(trimmed)) return undefined
  let value = trimmed
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim()
  } else if (value.includes('"')) {
    return undefined
  }
  if (value === "") return undefined
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined
  if (value.length > 16) return undefined
  if (value.length === 16 && value > "9007199254740991") return undefined
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) return undefined
  return n
}

export function createUpdateHandler<
  TRow extends SelectableRow,
  A,
  B,
  L extends SelectableRow,
  D extends SelectableRow,
>(shared: CrudShared<TRow, A, B, L, D>) {
  const { options, entity } = shared
  const auditActive = auditEmit(options, "update")
  const concurrency = () => {
    const field =
      options.optimisticConcurrency?.versionField ?? entity.versionField
    return field
      ? {
          versionField: field,
        }
      : null
  }
  const definition: OperationDefinition<UpdateOperationInput<TRow, B>, MutationResult<TRow>> = {
    key: `${options.moduleKey}.update`,
    kind: "mutation",
    atomicity: { kind: "standard", mode: "required" },
    ...(options.crud?.update?.transformInput
      ? {
          before: async ({ operation, input }: { operation: PreparationOperationContext; input: UpdateOperationInput<TRow, B> }) => {
            const session = resolveOperationRequestContext(operation)
            assertProtectedUpdateFields(entity, input.patch as object)
              const patch = await options.crud!.update!.transformInput!({
              existing: input.existing,
              patch: input.patch,
              context: toCrudContext(session, operation),
            })
            assertProtectedUpdateFields(entity, (patch ?? input.patch) as object)
            return patch
              ? { ...input, patch, originalPatch: input.originalPatch }
              : input
          },
        }
      : {}),
    execute: async ({ operation, input }: { operation: MutationOperationContext; input: UpdateOperationInput<TRow, B> }) => {
       const repo = internalRepositoryForDescriptor(operation.persistence, entity)
      const session = resolveOperationRequestContext(operation)
      const structural = buildStructuralScope(
        entity,
        session,
        options.entityScope
      )
      const actionScope = await resolveActionScopeForContext(options, session, "update")
      const patch = input.patch as Partial<TRow>
      let filter: PredicateNode = Predicate.eq(
        entity.primaryKey ?? "id",
        input.id
      )
      if (structural) filter = Predicate.and(filter, structural)
      if (actionScope) filter = Predicate.and(filter, actionScope)
      let updateOptions:
        | { optimisticConcurrency: { expectedVersion: EntityVersion } }
        | undefined
      const current = repo.findOneWhere
        ? await repo.findOneWhere(filter)
        : (await repo.findMany({ filter, pagination: { kind: "offset", page: 1, pageSize: 1 } })).rows[0] ?? null
      if (!current) throw new NotFoundError(`${entity.name} not found`)
      operation.enforceAbac?.enforce("update", {
        ...toAuditObject(current),
        ...toAuditObject(input.patch as object),
      }, Object.keys(input.patch as object))
      const config = concurrency()
      if (config) {
        const existingVersion = current[config.versionField]
        const incoming = input.expectedVersion
        if (typeof existingVersion !== "number")
          throw new ConfigurationError(
            `Optimistic concurrency for "${entity.name}" requires numeric version field "${config.versionField}"`
          )
        if (typeof incoming !== "number")
          throw new ConflictError("Version is required for this update")
        if (incoming !== existingVersion)
          throw new ConflictError(
            "This record was modified by another user. Please reload and try again."
          )
        filter = Predicate.and(
          filter,
          Predicate.eq(config.versionField, incoming)
        )
        updateOptions = { optimisticConcurrency: { expectedVersion: incoming } }
      }
      if (repo.updateOneWhereReturning) {
        const updated = await repo.updateOneWhereReturning(
            filter,
          patch,
          updateOptions
        )
        if (!updated) {
          if (updateOptions)
            throw new ConflictError(
              "This record was modified by another user. Please reload and try again."
            )
          throw new NotFoundError(`${entity.name} not found`)
        }
         return { record: updated }
      }
      throw new ConfigurationError(
        `Secure update for ${entity.name} requires updateOneWhereReturning support`
      )
    },
    atomicBatch: {
      prepare: async ({ operation, input }) => {
        const session = resolveOperationRequestContext(operation)
        // transformInput runs after the authorization stage; the FINAL patch
        // must pass the same protected-field and ABAC update checks that the
        // interactive execute path applies before the batch is prepared.
        assertProtectedUpdateFields(entity, input.patch as object)
        await enforceFinalWrite({
          options,
          operation,
          context: session,
          action: "update",
          record: { ...toAuditObject(input.existing), ...toAuditObject(input.patch as object) },
          changedFields: Object.keys(input.patch as object),
        })
        const structural = buildStructuralScope(entity, session, options.entityScope)
        const actionScope = await resolveActionScopeForContext(options, session, "update")
        let patch = input.patch as Partial<TRow>
        let filter: PredicateNode = Predicate.eq(entity.primaryKey ?? "id", input.id)
        if (structural) filter = Predicate.and(filter, structural)
        if (actionScope) filter = Predicate.and(filter, actionScope)
        const config = concurrency()
        if (config) {
          const existingVersion = input.existing[config.versionField]
          const incoming = input.expectedVersion
          if (typeof existingVersion !== "number") {
            throw new ConfigurationError(
              `Optimistic concurrency for "${entity.name}" requires numeric version field "${config.versionField}"`,
            )
          }
          if (typeof incoming !== "number") throw new ConflictError("Version is required for this update")
          if (incoming !== existingVersion) {
            throw new ConflictError("This record was modified by another user. Please reload and try again.")
          }
          patch = input.patch as Partial<TRow>
          filter = Predicate.and(filter, Predicate.eq(config.versionField, incoming))
        }
        const committedVersion = config && typeof input.expectedVersion === "number"
          ? input.expectedVersion + 1
          : undefined
        return {
          commands: [{ kind: "update", entity: entity.name, ...(entity.namespace ? { namespace: entity.namespace } : {}), filter, values: patch, expectedAffectedRows: 1, ...(config ? { expectedVersion: input.expectedVersion } : {}) }],
          // MUTATION INTENT, NOT DB-real post-state: the audit layer reads this
          // deterministic command-state projection of what the batch is about to
          // write. It intentionally never issues a post-commit read inside audit —
          // the batch may not have committed yet, and the projection must stay
          // stable across idempotent retries.
          result: {
            record: {
              ...input.existing,
              ...patch,
              ...(committedVersion !== undefined ? { [config!.versionField]: committedVersion } : {}),
            },
          },
          verify: ({ commandResults }) => {
            const result = commandResults[0] as { meta?: { changes?: number }; changes?: number; affectedRows?: number } | undefined
            const changes = result?.meta?.changes ?? result?.changes ?? result?.affectedRows
            if (changes === undefined) throw new ConfigurationError("Atomic update did not return affected-row metadata")
            if (changes !== 1) throw new ConflictError("This record was modified by another user. Please reload and try again.")
          },
        }
      },
    },
    after: async ({ operation, input, result }) => {
      const session = resolveOperationRequestContext(operation)
      if (!("record" in result)) throw new ConfigurationError("Mutation result record is unavailable")
       const readablePersistence = withScopedPersistence(session, options.createPersistence(session))
         const committedVersion = entity.versionField ? result.record[entity.versionField] : undefined
         if (committedVersion !== undefined) assertEntityVersion(committedVersion)
       const readable = await loadReadableMutationRecord(
        options,
        entity,
        session,
         input.id,
         readablePersistence,
           committedVersion as EntityVersion | undefined,
       )
      if (!readable)
        return {
          success: true,
          reason: "UPDATED_OUTSIDE_READ_SCOPE",
         }

         const bundle = session.identity.actor.kind !== "anonymous" && !canUseOwnerBypass(options.adapterDeps, options.scope.scope, session)
         ? await options.adapterDeps.resolveAbacBundle({ moduleKey: options.moduleKey, context: session })
         : undefined
         if (bundle) await assertAbacSecurityDigest(bundle)
         const overrides = bundle
           ? resolveFieldReadOverrides({ policies: bundle.policies, moduleKey: options.moduleKey, record: readable })
           : undefined
          const projectedReadable = projectResponseRecord({ entity, record: readable, ...(overrides ? { overrides } : {}) })
         const projectedExisting = projectResponseRecord({ entity, record: input.existing, ...(overrides ? { overrides } : {}) })
           const hookResult = options.crud?.update?.projectCommittedResult
           ? await options.crud.update.projectCommittedResult({
           existing: projectedExisting,
          patch: input.patch,
          originalPatch: input.originalPatch,
            result: projectedReadable,
             context: toCrudContext(session, operation, readablePersistence),
        })
        : undefined

          const candidate = hookResult ?? projectedReadable
         return { record: projectResponseRecord({
        entity,
          record: candidate,
        ...(bundle
          ? {
               overrides: overrides!,
            }
          : {}),
       }) }
    },
    ...(options.crud?.update?.afterCommit
      ? {
          afterCommit: async ({ operation, input, result }) => {
            const session = resolveOperationRequestContext(operation)
            await options.crud!.update!.afterCommit!({
              existing: input.existing,
              patch: input.patch,
              // A committed mutation outside the read scope has no readable
              // record; the after-commit hook receives the durable identity so
              // it still runs instead of failing on an unavailable record.
              result: "record" in result ? result.record : { [entity.primaryKey ?? "id"]: input.id } as TRow,
              operation,
              context: toCrudPostCommitContext(session, operation),
            })
          },
        }
      : {}),
    authorization: {
      authorize: async ({ operation, input }: { operation: AuthorizationOperationContext; input: UpdateOperationInput<TRow, B> }) => {
        // The execute-stage check uses the transaction-current row. This check
        // also covers the D1 atomic fallback before its conditional write.
        if (operation.enforceAbac) {
          operation.enforceAbac.enforce(
            "update",
            {
              ...toAuditObject(input.existing),
              ...toAuditObject(input.patch as object),
            },
            Object.keys(input.patch as object)
          )
          const session = resolveOperationRequestContext(operation)
          if (session.identity.actor.kind !== "anonymous" && !canUseOwnerBypass(options.adapterDeps, options.scope.scope, session)) {
            const bundle = await options.adapterDeps.resolveAbacBundle({
              moduleKey: options.moduleKey,
              context: session,
            })
            if (bundle) {
              await assertAbacSecurityDigest(bundle)
              // Record-dependent field-write decisions must be fenced by
              // optimistic concurrency or the row can change between the field
              // decision and the mutation.
              if (hasRecordDependentFieldWrite(bundle.policies, options.moduleKey, "update")) {
                const versionField = options.optimisticConcurrency?.versionField ?? entity.versionField
                if (!versionField || input.expectedVersion === undefined) {
                  throw new ConfigurationError(`Record-dependent field-write ABAC on "${entity.name}" requires optimistic concurrency`)
                }
              }
            }
          }
        }
        return { allowed: true }
      },
    },
    ...(auditActive
      ? {
          audit: {
            action: `${options.audit?.resource ?? entity.name}.updated`,
            resourceType: options.audit?.resource ?? entity.name,
            ...(options.audit?.fieldClassification ? { fieldClassification: options.audit.fieldClassification } : {}),
            ...(options.audit?.required !== undefined ? { required: options.audit.required } : {}),
            ...(options.audit?.auditGuarantee !== undefined ? { auditGuarantee: options.audit.auditGuarantee } : {}),
            ...(options.audit?.requiredStateSemantics !== undefined ? { requiredStateSemantics: options.audit.requiredStateSemantics } : {}),
             resolveResourceId: ({ input, result }) =>
               "record" in result
                 ? String(result.record[entity.primaryKey ?? "id"])
                 : input.id,
            ...(options.audit?.includeValues === true
              ? {
                  extractOldValue: ({
                    input,
                  }: {
                    input: UpdateOperationInput<TRow, B>
                  }) => projectResponseRecord({ entity, record: input.existing }),
                   extractNewValue: ({ result }: { result: MutationResult<TRow> }) =>
                     projectResponseRecord({ entity, record: "record" in result ? result.record : {} }),
                }
              : {}),
          },
        }
      : {}),
  }
  return createFrameworkWriteHandler({
    adapterDeps: shared.deps,
    requestNormalization: options.requestNormalization,
    scope: options.scope,
    moduleKey: options.moduleKey,
    action: "update",
    ...shared.writeCapabilityConfig,
    resolveResourceIdentity: ({ input }) => {
      const versionField = options.optimisticConcurrency?.versionField ?? entity.versionField
      const previousVersion = versionField ? input.existing[versionField] : undefined
       const committedVersion = typeof previousVersion === "number" ? previousVersion + 1 : undefined
       return { entity: options.moduleKey, id: input.id, ...(committedVersion !== undefined ? { version: committedVersion } : {}) }
    },
    recoverCommittedResponse: async ({ resource, context }) =>
      buildCommittedReadResponse({ options, entity, context, id: resource.id, ...(resource.version !== undefined ? { resourceVersion: resource.version } : {}) }),
    validation: options.validation?.updateBody
      ? { params: shared.idParamsSchema, body: options.validation.updateBody }
      : { params: shared.idParamsSchema },
    ...(options.rateLimit?.update
       ? { rateLimit: { config: options.rateLimit.update, consistency: options.rateLimit.update.consistency, ...(options.rateLimit.update.failureMode !== undefined ? { failureMode: options.rateLimit.update.failureMode } : {}) } }
      : {}),
    getCacheAdapter: options.getCacheAdapter,
    ...(options.getRateLimitStore ? { getRateLimitStore: options.getRateLimitStore } : {}),
    runtimeCapabilities: shared.writeRuntimeCapabilities,
    ...(auditActive && options.auditSinkFactory
      ? { auditSinkFactory: options.auditSinkFactory }
      : {}),
    ...(options.outboxSinkFactory ? { outboxSinkFactory: options.outboxSinkFactory } : {}),
    createPersistence: options.createPersistence,
    definition,
    resolveExistingRecord: async ({ validated, context }) => {
      const id = (validated.validatedParams as { id: string }).id
      const existing = await loadExistingRecord(
        options,
        id,
        context,
        await resolveActionScopeForContext(options, context, "update")
      )
      if (!existing) throw new NotFoundError(`${entity.name} not found`)
      return existing
    },
    resolveInput: async ({ request, validated, existing }) => {
       const rawPatch = { ...(validated.validatedBody as Record<string, unknown>) }
       const config = concurrency()
       // If-Match is the ONLY concurrency transport. A body `version` field is
       // never treated as the expected version; it is a protected field and is
       // rejected below (or by the validation schema).
       const headerValue = config ? request.headers.get("if-match") : null
       const expectedVersion = config ? parseIfMatchVersion(headerValue) : undefined
       if (config && (expectedVersion === undefined || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0))
         throw new ConflictError("Version is required for this update")
       const patch = rawPatch as B
       assertProtectedUpdateFields(entity, patch as object)
       return {
        id: (validated.validatedParams as { id: string }).id,
        patch,
         originalPatch: patch,
         existing: existing as TRow,
         ...(expectedVersion !== undefined ? { expectedVersion } : {}),
       }
    },
    ...(shared.invalidateTags ? { invalidateTags: shared.invalidateTags } : {}),
     toResponse: (result) => frameworkJson("record" in result ? result.record : result),
   })
}
