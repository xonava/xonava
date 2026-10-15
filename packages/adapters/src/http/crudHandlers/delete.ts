/* eslint-disable @typescript-eslint/require-await */
import type { OperationDefinition, MutationOperationContext, PreparationOperationContext, AuthorizationOperationContext } from "@xonava/core/operation"
import {
  ConfigurationError,
  ConflictError,
  NotFoundError,
  Predicate,
  projectResponseRecord,
} from "@xonava/core/domain"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import { frameworkJson } from "../handleFrameworkCoreError"
import type { CrudShared, DeleteOperationInput, SelectableRow } from "./types"
import { assertEntityVersion } from "@xonava/core/serialization"
import { internalRepositoryForDescriptor } from "../../repository/dynamicRepository"
import { parseIfMatchVersion } from "./update"
import {
  auditEmit,
  buildStructuralScope,
  loadExistingRecord,
  resolveOperationRequestContext,
  toAuditObject,
  toCrudContext,
  toCrudPostCommitContext,
  resolveActionScopeForContext,
} from "./shared"

export function createDeleteHandler<
  TRow extends SelectableRow,
  A,
  B,
  L extends SelectableRow,
  D extends SelectableRow,
>(shared: CrudShared<TRow, A, B, L, D>) {
  const { options, entity } = shared
  const auditActive = auditEmit(options, "delete")
  const definition: OperationDefinition<
    DeleteOperationInput<TRow>,
    { success: true }
  > = {
    key: `${options.moduleKey}.delete`,
    kind: "mutation",
    atomicity: { kind: "standard", mode: "required" },
    ...(options.crud?.delete?.beforeDelete
      ? {
          before: async ({ operation, input }: { operation: PreparationOperationContext; input: DeleteOperationInput<TRow> }) => {
            const session = resolveOperationRequestContext(operation)
              await options.crud!.delete!.beforeDelete!({
              existing: input.existing,
              context: toCrudContext(session, operation),
            })
          },
        }
      : {}),
    execute: async ({ operation, input }: { operation: MutationOperationContext; input: DeleteOperationInput<TRow> }) => {
      const session = resolveOperationRequestContext(operation)
      const filter = Predicate.eq(entity.primaryKey ?? "id", input.id)
      const structural = buildStructuralScope(
        entity,
        session,
        options.entityScope
      )
      const actionScope = await resolveActionScopeForContext(options, session, "delete")
      const repo = internalRepositoryForDescriptor(operation.persistence, entity)
      if (entity.deleteStrategy === "forbidden") throw new ConfigurationError(`Delete is forbidden for append-only entity ${entity.name}`)
      let deleteFilter = structural && actionScope
        ? Predicate.and(filter, structural, actionScope)
        : structural ? Predicate.and(filter, structural) : actionScope ? Predicate.and(filter, actionScope) : filter
      const versionField = options.optimisticConcurrency?.versionField ?? entity.versionField
      const current = repo.findOneWhere
        ? await repo.findOneWhere(deleteFilter)
        : (await repo.findMany({ filter: deleteFilter, pagination: { kind: "offset", page: 1, pageSize: 1 } })).rows[0] ?? null
      if (!current) throw new NotFoundError(`${entity.name} not found`)
      if (operation.enforceAbac)
        operation.enforceAbac.enforce("delete", toAuditObject(current))
      if (versionField) {
        if (input.expectedVersion === undefined) throw new ConflictError("Version is required for this delete")
        assertEntityVersion(input.expectedVersion)
        deleteFilter = Predicate.and(deleteFilter, Predicate.eq(versionField, input.expectedVersion))
      }
      const mutationOptions = versionField ? { optimisticConcurrency: { expectedVersion: input.expectedVersion! } } : undefined
      const affected = entity.deleteStrategy === "occ-soft"
        ? await (async () => {
            if (!entity.deletedAtField || !repo.updateOneWhereReturning) throw new ConfigurationError(`Soft delete for ${entity.name} requires a deletedAt field and updateOneWhereReturning support`)
            return (await repo.updateOneWhereReturning(deleteFilter, { [entity.deletedAtField]: new Date().toISOString() } as Partial<TRow>, mutationOptions as never)) ? 1 : 0
          })()
        : await (async () => {
            if (!repo.deleteWhere) throw new ConfigurationError(`Secure delete for ${entity.name} requires deleteWhere support`)
            return (await repo.deleteWhere(deleteFilter, mutationOptions)).deletedCount
          })()
      if (affected === 0) {
        if (versionField && input.expectedVersion !== undefined) throw new ConflictError("This record was modified by another user. Please reload and try again.")
        throw new NotFoundError(`${entity.name} not found`)
      }
      return { success: true as const }
    },
    atomicBatch: {
      prepare: async ({ operation, input }) => {
        const session = resolveOperationRequestContext(operation)
        const structural = buildStructuralScope(entity, session, options.entityScope)
        const actionScope = await resolveActionScopeForContext(options, session, "delete")
        const base = Predicate.eq(entity.primaryKey ?? "id", input.id)
        let filter = structural && actionScope
          ? Predicate.and(base, structural, actionScope)
          : structural ? Predicate.and(base, structural) : actionScope ? Predicate.and(base, actionScope) : base
        const versionField = options.optimisticConcurrency?.versionField ?? entity.versionField
        if (versionField) {
          if (input.expectedVersion === undefined) throw new ConflictError("Version is required for this delete")
          assertEntityVersion(input.expectedVersion)
           filter = Predicate.and(filter, Predicate.eq(versionField, input.expectedVersion))
        }
        return {
          commands: [entity.deleteStrategy === "occ-soft"
            ? { kind: "update" as const, entity: entity.name, ...(entity.namespace ? { namespace: entity.namespace } : {}), filter, values: { [entity.deletedAtField!]: new Date().toISOString() }, expectedAffectedRows: 1, ...(versionField ? { expectedVersion: input.expectedVersion } : {}) }
            : { kind: "delete" as const, entity: entity.name, ...(entity.namespace ? { namespace: entity.namespace } : {}), filter, expectedAffectedRows: 1, ...(versionField ? { expectedVersion: input.expectedVersion } : {}) }],
          // MUTATION INTENT, NOT DB-real post-state: the result is the
          // deterministic command-state projection of what the batch is about to
          // delete. No post-commit read is attempted inside audit; the projection
          // must stay stable across idempotent retries.
          result: { success: true as const },
          verify: ({ commandResults }) => {
            const result = commandResults[0] as { meta?: { changes?: number }; changes?: number; affectedRows?: number } | undefined
            const changes = result?.meta?.changes ?? result?.changes ?? result?.affectedRows
            if (changes === undefined) throw new ConfigurationError("Atomic delete did not return affected-row metadata")
            if (changes !== 1) {
              if (versionField && input.expectedVersion !== undefined) throw new ConflictError("This record was modified by another user. Please reload and try again.")
              throw new NotFoundError(`${entity.name} not found`)
            }
          },
        }
      },
    },
    ...(options.crud?.delete?.afterCommit
      ? {
          afterCommit: async ({ operation, input }) => {
            const session = resolveOperationRequestContext(operation)
            await options.crud!.delete!.afterCommit!({
              existing: input.existing,
              operation,
              context: toCrudPostCommitContext(session, operation),
            })
          },
        }
      : {}),
    authorization: {
      authorize: async ({ operation, input }: { operation: AuthorizationOperationContext; input: DeleteOperationInput<TRow> }) => {
        if (operation.enforceAbac)
          operation.enforceAbac.enforce("delete", toAuditObject(input.existing))
        return { allowed: true }
      },
    },
    ...(auditActive
      ? {
          audit: {
            action: `${options.audit?.resource ?? entity.name}.deleted`,
            resourceType: options.audit?.resource ?? entity.name,
            ...(options.audit?.fieldClassification ? { fieldClassification: options.audit.fieldClassification } : {}),
            ...(options.audit?.required !== undefined ? { required: options.audit.required } : {}),
            ...(options.audit?.auditGuarantee !== undefined ? { auditGuarantee: options.audit.auditGuarantee } : {}),
            ...(options.audit?.requiredStateSemantics !== undefined ? { requiredStateSemantics: options.audit.requiredStateSemantics } : {}),
            resolveResourceId: ({ input }) => input.id,
            ...(options.audit?.includeValues === true
              ? {
                  extractOldValue: ({
                    input,
                  }: {
                    input: DeleteOperationInput<TRow>
                  }) => projectResponseRecord({ entity, record: input.existing }),
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
    action: "delete",
    ...shared.writeCapabilityConfig,
    resolveResourceIdentity: ({ input }) => ({ entity: options.moduleKey, id: input.id }),
    recoverCommittedResponse: async (): Promise<{ success: true } | null> => ({ success: true }),
    validation: { params: shared.idParamsSchema },
    ...(options.rateLimit?.delete
       ? { rateLimit: { config: options.rateLimit.delete, consistency: options.rateLimit.delete.consistency, ...(options.rateLimit.delete.failureMode !== undefined ? { failureMode: options.rateLimit.delete.failureMode } : {}) } }
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
         await resolveActionScopeForContext(options, context, "delete")
       )
      if (!existing) throw new NotFoundError(`${entity.name} not found`)
      return existing
    },
     resolveInput: async ({ request, validated, existing }) => {
       const versionField = options.optimisticConcurrency?.versionField ?? entity.versionField
       if (!versionField) return { id: (validated.validatedParams as { id: string }).id, existing: existing as TRow }
       // If-Match is the ONLY concurrency transport for delete; a body version
       // field is never treated as the expected version.
       const expectedVersion = parseIfMatchVersion(request.headers.get("if-match"))
       if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) throw new ConflictError("Version must be a non-negative integer")
       return { id: (validated.validatedParams as { id: string }).id, existing: existing as TRow, ...(expectedVersion !== undefined ? { expectedVersion } : {}) }
     },
    ...(shared.invalidateTags ? { invalidateTags: shared.invalidateTags } : {}),
    toResponse: () => frameworkJson({ message: "Deleted" }),
  })
}
