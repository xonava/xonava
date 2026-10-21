import {
  ForbiddenError,
  Predicate,
  assertAbacSecurityDigest,
  createAbacAuthorizer,
  projectResponseRecord,
  resolveFieldReadOverrides,
  type FieldReadOverride,
  type RequestContext,
} from "@xonava/core/domain"
import type { EntityScopeDefinition } from "@xonava/core/entity"
import type { EntityDescriptor, PersistenceProvider } from "@xonava/core/persistence"
import { assertEntityVersion, type EntityVersion } from "@xonava/core/serialization"
import { internalRepositoryForDescriptor } from "../repository/dynamicRepository"
import type { FrameworkAdapterDeps } from "../server"
import { buildStructuralScope, withScopedPersistence } from "./crudHandlers/shared"

/**
 * Arguments for {@link readCommittedRecord}. Every field is something a custom
 * write handler already holds in its `after` hook (the request context comes
 * from `operation.request`) and in `recoverCommittedResponse` (the request
 * context is passed in, the id and version come from the resource identity).
 */
export type ReadCommittedRecordArgs<TRow extends Record<string, unknown> = Record<string, unknown>> = {
  /** Entity descriptor of the committed row. Its `versionField` drives the revision check and its fields drive projection. */
  entity: EntityDescriptor<TRow>
  /** Module key the ABAC bundle is resolved for (the same key the write handler was built with). */
  moduleKey: string
  /** The trusted request context of the write (`operation.request` in `after`, `context` in `recoverCommittedResponse`). */
  context: RequestContext
  /**
   * Persistence to read through, typically `createPersistence(context)`. Tenant
   * scoping is applied on top of it for tenant entities, exactly as built-in
   * CRUD does, so a plain provider is correct here.
   */
  persistence: PersistenceProvider
  /** Only `resolveAbacBundle` is used; pass the handler's `adapterDeps`. */
  adapterDeps: Pick<FrameworkAdapterDeps, "resolveAbacBundle">
  /** Structural scope declaration of the entity (tenant / application / platform filters). Pass what the entity was registered with; omit only for unscoped entities. */
  entityScope?: EntityScopeDefinition
  /** Primary key of the committed row. */
  id: string
  /**
   * Version the write committed (`resource.version` in recovery, the result
   * record's version field in `after`). When given, the stored row must carry
   * exactly this version, otherwise the result is `revision-unavailable`. Omit
   * it only for entities without optimistic concurrency.
   */
  committedVersion?: EntityVersion
}

/**
 * Result of {@link readCommittedRecord}.
 *
 * - `record`: the committed row, read under the caller's read scope and
 *   projected with the caller's field-read overrides (omit/mask) and the
 *   entity's declared fields. Safe to return to the caller.
 * - `outside-read-scope`: the row exists in the structural scope but the
 *   caller's read scope excludes it.
 * - `revision-unavailable`: the row is readable but its stored version differs
 *   from `committedVersion` (a later write superseded it, or the version cannot
 *   be verified). The newer revision is never substituted.
 * - `deleted`: no row with this id exists in the structural scope.
 *
 * These are internal outcomes, not HTTP responses. A caller MUST NOT let an
 * unauthorized client tell `outside-read-scope` from `deleted`: both must
 * produce the same externally visible response (built-in CRUD answers a
 * success acknowledgement without entity content for create/update).
 */
export type ReadCommittedRecordResult<TRow extends Record<string, unknown> = Record<string, unknown>> =
  | { kind: "record"; record: TRow }
  | { kind: "outside-read-scope" }
  | { kind: "revision-unavailable" }
  | { kind: "deleted" }

/** Internal result that also carries what built-in create/update need for their projection hooks. */
export type LoadedCommittedRecord<TRow extends Record<string, unknown>> =
  | { kind: "record"; record: TRow; readable: TRow; overrides: Record<string, FieldReadOverride> | undefined }
  | { kind: "outside-read-scope" }
  | { kind: "revision-unavailable" }
  | { kind: "deleted" }

/**
 * The single committed-read path shared by built-in create/update (initial
 * response and idempotent recovery) and the public {@link readCommittedRecord}.
 */
export async function loadCommittedRecord<TRow extends Record<string, unknown>>(
  args: ReadCommittedRecordArgs<TRow>,
): Promise<LoadedCommittedRecord<TRow>> {
  const { entity, context } = args
  const structural = buildStructuralScope(entity, context, args.entityScope)
  const requiresAbac = context.identity.actor.kind !== "anonymous"
  const bundle = requiresAbac
    ? await args.adapterDeps.resolveAbacBundle({ moduleKey: args.moduleKey, context })
    : undefined
  if (requiresAbac && !bundle) throw new ForbiddenError("ABAC authorization bundle unavailable")
  if (bundle) await assertAbacSecurityDigest(bundle)
  const readScope = bundle ? createAbacAuthorizer(bundle).authorizeCollection("read").scope : undefined
  const scope = structural && readScope ? Predicate.and(structural, readScope) : structural ?? readScope

  const primaryKey = entity.primaryKey ?? "id"
  const byId = Predicate.eq(primaryKey, args.id)
  const persistence = entity.tenantField ? withScopedPersistence(context, args.persistence) : args.persistence
  const repository = internalRepositoryForDescriptor(persistence, entity)
  const readOne = async (scoped: typeof scope) => (await repository.findMany({
    filter: scoped ? Predicate.and(byId, scoped) : byId,
    pagination: { kind: "offset", page: 1, pageSize: 1 },
  })).rows[0] ?? null

  const readable = await readOne(scope)
  if (!readable) {
    // Without a read scope the scoped read already was the structural read, so
    // a miss is a deletion. Otherwise ask the structural scope alone (never an
    // unscoped read, so tenant/application/active-row filters still apply)
    // whether the row exists.
    if (!readScope) return { kind: "deleted" }
    return (await readOne(structural)) ? { kind: "outside-read-scope" } : { kind: "deleted" }
  }

  if (args.committedVersion !== undefined) {
    const versionField = entity.versionField
    if (!versionField || readable[versionField] !== args.committedVersion) return { kind: "revision-unavailable" }
  }

  const overrides = bundle
    ? resolveFieldReadOverrides({ policies: bundle.policies, moduleKey: args.moduleKey, record: readable })
    : undefined
  return {
    kind: "record",
    readable,
    overrides,
    record: projectResponseRecord({ entity, record: readable, ...(overrides ? { overrides } : {}) }),
  }
}

/**
 * Re-reads a row a write just committed and returns it exactly as built-in
 * CRUD would respond: under the caller's read scope, with field-read overrides
 * and entity projection applied, and only if it is still the committed
 * revision. Use it from a custom write handler's `after` hook and from its
 * `recoverCommittedResponse`, so the initial response and an idempotent
 * recovery are built by the same code.
 *
 * Tenant/application structural scope is always applied; the function never
 * reads outside it, including the extra structural read that separates
 * `deleted` from `outside-read-scope`.
 */
export async function readCommittedRecord<TRow extends Record<string, unknown> = Record<string, unknown>>(
  args: ReadCommittedRecordArgs<TRow>,
): Promise<ReadCommittedRecordResult<TRow>> {
  if (args.committedVersion !== undefined) assertEntityVersion(args.committedVersion)
  const loaded = await loadCommittedRecord(args)
  return loaded.kind === "record" ? { kind: "record", record: loaded.record } : { kind: loaded.kind }
}
