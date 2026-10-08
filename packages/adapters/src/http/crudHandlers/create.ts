/* eslint-disable @typescript-eslint/require-await */
import { uuidv7 } from "uuidv7"
import type { AtomicBatchPreparationContext, OperationDefinition, MutationOperationContext, PreparationOperationContext, AuthorizationOperationContext } from "core/operation"
import { assertEntityVersion, type EntityVersion } from "core/serialization"
import { internalRepositoryForDescriptor } from "../../repository/dynamicRepository"
import {
  ConfigurationError,
  assertAbacSecurityDigest,
  projectResponseRecord,
  resolveFieldReadOverrides,
  type RequestContext,
} from "core/domain"
import { createFrameworkWriteHandler } from "../createFrameworkWriteHandler"
import { frameworkJson } from "../handleFrameworkCoreError"
import type { CrudShared, CreateOperationInput, MutationResult, SelectableRow } from "./types"
import {
  auditEmit,
  assertProtectedCreateFields,
  buildCommittedReadResponse,
  buildScopedCreateRecord,
  loadReadableMutationRecord,
  resolveOperationRequestContext,
  toAuditObject,
  toCrudContext,
  toCrudPostCommitContext,
  canUseOwnerBypass,
  enforceFinalWrite,
  withScopedPersistence,
} from "./shared"

export function createCreateHandler<
  TRow extends SelectableRow,
  A,
  B,
  L extends SelectableRow,
  D extends SelectableRow,
>(shared: CrudShared<TRow, A, B, L, D>) {
  const { options, entity } = shared
  const auditActive = auditEmit(options, "create")
  // The authorization stage sees the request body; transformInput may then
  // add or rename fields. The FINAL record must pass the same protected-field
  // and ABAC create checks before it is written, on every execution path.
  const enforceTransformedCreate = async (
    operation: MutationOperationContext | AtomicBatchPreparationContext,
    input: CreateOperationInput<A>,
    session: RequestContext,
  ): Promise<void> => {
    assertProtectedCreateFields(entity, input.body as object)
    await enforceFinalWrite({
      options,
      operation,
      context: session,
      action: "create",
      record: toAuditObject(buildScopedCreateRecord(entity, input, toAuditObject(input.body as object), session, options.entityScope)),
      changedFields: Object.keys(input.body as object),
    })
  }
  const definition: OperationDefinition<CreateOperationInput<A>, MutationResult<TRow>> = {
    key: `${options.moduleKey}.create`,
    kind: "mutation",
    atomicity: { kind: "standard", mode: "required" },
    ...(options.crud?.create?.transformInput
      ? {
          before: async ({ operation, input }: { operation: PreparationOperationContext; input: CreateOperationInput<A> }) => {
            const session = resolveOperationRequestContext(operation)
              const body = await options.crud!.create!.transformInput!({
              input: input.body,
              context: toCrudContext(session, operation),
            })
            assertProtectedCreateFields(entity, (body ?? input.body) as object)
            return body
              ? { ...input, body, originalBody: input.originalBody }
              : input
          },
        }
      : {}),
    execute: async ({ operation, input }: { operation: MutationOperationContext; input: CreateOperationInput<A> }) => {
      const session = resolveOperationRequestContext(operation)
      await enforceTransformedCreate(operation, input, session)
       const record = await internalRepositoryForDescriptor(operation.persistence, entity).insert(
          buildScopedCreateRecord(
            entity,
            input,
            toAuditObject(input.body as object),
            session,
            options.entityScope
           ),
         )
       return { record }
     },
    atomicBatch: {
      prepare: async ({ operation, input }) => {
        const session = resolveOperationRequestContext(operation)
        await enforceTransformedCreate(operation, input, session)
        const values = buildScopedCreateRecord(entity, input, toAuditObject(input.body as object), session, options.entityScope)
        return {
        commands: [{
          kind: "insert",
          entity: entity.name,
          ...(entity.namespace ? { namespace: entity.namespace } : {}),
          values: { ...values },
        }],
        result: {
          record: { ...values } as unknown as TRow,
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
         const readable = await loadReadableMutationRecord(options, entity, session, input.id, readablePersistence, committedVersion as EntityVersion | undefined)
      if (!readable)
         return {
           success: true,
           reason: "CREATED_OUTSIDE_READ_SCOPE",
         }

        const bundle = session.identity.actor.kind !== "anonymous" && !canUseOwnerBypass(options.adapterDeps, options.scope.scope, session)
         ? await options.adapterDeps.resolveAbacBundle({ moduleKey: options.moduleKey, context: session })
         : undefined
        if (bundle) await assertAbacSecurityDigest(bundle)
        const overrides = bundle
          ? resolveFieldReadOverrides({ policies: bundle.policies, moduleKey: options.moduleKey, record: readable })
          : undefined
          const projectedReadable = projectResponseRecord({ entity, record: readable, ...(overrides ? { overrides } : {}) })
         const hookResult = options.crud?.create?.projectCommittedResult
           ? await options.crud.create.projectCommittedResult({
          input: input.body,
          originalInput: input.originalBody,
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
    ...(options.crud?.create?.afterCommit
      ? {
          afterCommit: async ({ operation, input, result }) => {
            const session = resolveOperationRequestContext(operation)
            await options.crud!.create!.afterCommit!({
              input: input.body,
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
      authorize: async ({ operation, input }: { operation: AuthorizationOperationContext; input: CreateOperationInput<A> }) => {
        const context = operation.request
        if (operation.enforceAbac && context)
          operation.enforceAbac.enforce(
            "create",
            toAuditObject(
              buildScopedCreateRecord(
                entity,
                input,
                toAuditObject(input.body as object),
                context,
                options.entityScope
              )
            ),
            Object.keys(input.body as object)
          )
        return { allowed: true }
      },
    },
    ...(auditActive
      ? {
          audit: {
            action: `${options.audit?.resource ?? entity.name}.created`,
            resourceType: options.audit?.resource ?? entity.name,
            ...(options.audit?.fieldClassification ? { fieldClassification: options.audit.fieldClassification } : {}),
            ...(options.audit?.required !== undefined ? { required: options.audit.required } : {}),
            ...(options.audit?.auditGuarantee !== undefined ? { auditGuarantee: options.audit.auditGuarantee } : {}),
            ...(options.audit?.requiredStateSemantics !== undefined ? { requiredStateSemantics: options.audit.requiredStateSemantics } : {}),
            resolveResourceId: ({ input }) => input.id,
            ...(options.audit?.includeValues === true
              ? {
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
    action: "create",
    ...shared.writeCapabilityConfig,
    ...(options.validation?.createBody
      ? { validation: { body: options.validation.createBody } }
      : {}),
    resolveResourceIdentity: ({ input }) => ({
      entity: options.moduleKey,
      id: input.id,
      ...(entity.versionField ? { version: 1 } : {}),
    }),
    recoverCommittedResponse: async ({ resource, context }) =>
      buildCommittedReadResponse({
        options,
        entity,
        context,
        id: resource.id,
        ...(resource.version !== undefined ? { resourceVersion: resource.version } : {}),
      }),
    ...(options.rateLimit?.create
       ? { rateLimit: { config: options.rateLimit.create, consistency: options.rateLimit.create.consistency, ...(options.rateLimit.create.failureMode !== undefined ? { failureMode: options.rateLimit.create.failureMode } : {}) } }
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
    resolveInput: async ({ validated }) => {
      const body = validated.validatedBody as A
      assertProtectedCreateFields(entity, body as object)
      return { body, originalBody: body, id: uuidv7() }
    },
    ...(shared.invalidateTags ? { invalidateTags: shared.invalidateTags } : {}),
     toResponse: (result) => frameworkJson("record" in result ? result.record : result, { status: 201 }),
  })
}
