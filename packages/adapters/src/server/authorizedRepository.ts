import { Predicate, ConfigurationError, ForbiddenError, assertFieldQueryAccess, assertVerifiedAbacBundle, resolveFieldQueryDenials, type PredicateNode } from "core/domain"
import { FIELD_READ_DEFAULT_KEY, projectResponseRecord, type AbacAuthorizer, type FieldReadOverride, type VerifiedAbacPolicyBundle } from "core/domain"
import { assertEntityVersion, type EntityVersion } from "core/serialization"
import type { EntityDescriptor, VersionedRepository } from "core/persistence"
import type { ListResult, SortSpec } from "core/query"
import type { OffsetPaginationPlan } from "core/query"

export interface AuthorizedRepository<TRow extends Record<string, unknown>, TId = string> {  findMany(args?: {
    filter?: PredicateNode
    pagination?: OffsetPaginationPlan
    sort?: SortSpec[]
  }): Promise<ListResult<TRow>>

  findById(id: TId): Promise<TRow | null>

  insert(input: Partial<TRow>): Promise<
    { applied: true; row: TRow } |
    { applied: true; reason: "CREATED_OUTSIDE_READ_SCOPE" }
  >

  update(
    id: TId,
    patch: Partial<TRow>,
    options: { expectedVersion: EntityVersion },
  ): Promise<
    { applied: true; row: TRow } |
    { applied: true; reason: "UPDATED_OUTSIDE_READ_SCOPE" } |
    { applied: false; reason: "NOT_FOUND" | "CONFLICT" }
  >

  delete(id: TId, options: { expectedVersion: EntityVersion }): Promise<{ applied: boolean; reason?: "NOT_FOUND" | "CONFLICT" }>
}

/** Collects every field referenced by a caller-supplied predicate. */
function collectPredicateFields(node: PredicateNode | undefined): string[] {
  if (!node) return []
  switch (node.kind) {
    case "condition":
      return [node.field]
    case "and":
    case "or":
      return node.filters.flatMap(collectPredicateFields)
    case "not":
      return collectPredicateFields(node.filter)
    case "literal":
      return []
  }
}

/** True when a read plan leaves `field` fully readable (not masked or omitted). */
function isFieldReadable(plan: Record<string, FieldReadOverride>, field: string): boolean {
  if (Object.hasOwn(plan, field) && field !== FIELD_READ_DEFAULT_KEY) return plan[field] === "allow"
  return !Object.hasOwn(plan, FIELD_READ_DEFAULT_KEY) || plan[FIELD_READ_DEFAULT_KEY] === "allow"
}

function assertFieldsReadable(plan: Record<string, FieldReadOverride>, fields: string[], mode: "filter" | "sort"): void {
  const denied = [...new Set(fields.filter((field) => !isFieldReadable(plan, field)))]
  assertFieldQueryAccess({ denied, fields, mode })
}

export function createAuthorizedRepository<TRow extends Record<string, unknown>, TId extends string | number = string>(args: {
  repository: VersionedRepository<TRow, TId>
  entity: EntityDescriptor<TRow>
  authorizer: AbacAuthorizer
  structuralScope: PredicateNode
  structuralInsertValues?: Partial<TRow>
  bundle?: VerifiedAbacPolicyBundle
}): AuthorizedRepository<TRow, TId> {
  // The verified brand is a runtime requirement, not just a type: a caller
  // that passes a forged-but-typed-as-verified bundle must be rejected before
  // it can drive query-denial decisions with unverified policies.
  if (args.bundle) assertVerifiedAbacBundle(args.bundle)
  // The authorized surface requires exact secure semantics; refuse to build it
  // when the backing repository cannot provide them.
  if (!args.repository.updateOneWhereReturning) {
    throw new ConfigurationError(`Authorized repository for "${args.entity.name}" requires updateOneWhereReturning support`)
  }
  if (!args.repository.deleteWhere) {
    throw new ConfigurationError(`Authorized repository for "${args.entity.name}" requires deleteWhere support`)
  }
  if (!args.entity.versionField) {
    throw new ConfigurationError(`Authorized repository for "${args.entity.name}" requires a versionField for optimistic concurrency`)
  }
  const primaryKey = (args.entity.primaryKey ?? "id")

  function buildAccessFilter(action: string, extraFilter?: PredicateNode, existingScope?: PredicateNode): PredicateNode {
    const actionScope = existingScope ?? args.authorizer.assertCollectionAction(action).scope
    const filters: PredicateNode[] = [args.structuralScope]
    if (actionScope) filters.push(actionScope)
    if (extraFilter) filters.push(extraFilter)
    return Predicate.and(...filters)
  }

  function redact(row: TRow): TRow {
    const overrides = args.authorizer.fieldReadPlan(row)
    return projectResponseRecord({ entity: args.entity, record: row, overrides })
  }

  return {
    async findMany(opts) {
      const collectionScope = args.authorizer.assertCollectionAction("read").scope
      // Field-level query security: caller filter/sort fields must not probe
      // fields ABAC masks or omits from responses. The authorizer exposes the
      // read plan per row; query capability is a static property of the module
      // bundle, so it is resolved from the bundle when provided.
      const filterFields = collectPredicateFields(opts?.filter)
      const sortFields = (opts?.sort ?? []).map((spec) => spec.field)
      if (args.bundle) {
        const queryDenials = resolveFieldQueryDenials({
          policies: args.bundle.policies,
          moduleKey: args.bundle.moduleKey,
        })
        assertFieldQueryAccess({ denied: queryDenials.filter, fields: filterFields, mode: "filter" })
        assertFieldQueryAccess({ denied: queryDenials.sort, fields: sortFields, mode: "sort" })
      } else if (filterFields.length > 0 || sortFields.length > 0) {
        // Without a bundle there are no static query grants, so fail closed on
        // the authorizer's read plan: a field the plan masks or omits cannot be
        // filtered or sorted on. The unconditional plan is checked up front;
        // row-conditional plans are re-checked on every returned row below.
        const basePlan = args.authorizer.fieldReadPlan({})
        assertFieldsReadable(basePlan, filterFields, "filter")
        assertFieldsReadable(basePlan, sortFields, "sort")
      }
      const filter = buildAccessFilter("read", opts?.filter, collectionScope)
       const result = await args.repository.findMany({
         filter,
         ...(opts?.pagination ? { pagination: opts.pagination } : {}),
         ...(opts?.sort ? { sort: opts.sort } : {}),
       })
      if (!args.bundle && (filterFields.length > 0 || sortFields.length > 0)) {
        for (const row of result.rows) {
          const plan = args.authorizer.fieldReadPlan(row)
          assertFieldsReadable(plan, filterFields, "filter")
          assertFieldsReadable(plan, sortFields, "sort")
        }
      }
      return {
        ...result,
        rows: result.rows.map(redact),
      }
    },

    async findById(id) {
      const collectionScope = args.authorizer.assertCollectionAction("read").scope
      const filter = buildAccessFilter("read", Predicate.eq(primaryKey, id), collectionScope)
      const result = await args.repository.findMany({ filter, pagination: { kind: "offset", page: 1, pageSize: 1 } })
      if (!result.rows[0]) return null
      return redact(result.rows[0])
    },

    async insert(input) {
      const prohibited = [...new Set([
        args.entity.primaryKey,
        args.entity.tenantField,
        args.entity.versionField,
        ...(args.entity.immutableFields ?? []),
      ].filter(Boolean))] as string[]

      const providedImmutable = prohibited.filter(f => Object.hasOwn(input as object, f))
      if (providedImmutable.length > 0) {
        throw new ForbiddenError(
          `Cannot set immutable fields on ${args.entity.name}: ${providedImmutable.join(", ")}`,
          { fields: providedImmutable },
        )
      }

      const safeInput = { ...input, ...args.structuralInsertValues }
      args.authorizer.assertWrite({ action: "create", record: safeInput, changedFields: Object.keys(safeInput) })

      const row = await args.repository.insert(safeInput)

      // Verify read scope without allowing a later write to become the
      // response row. The mutation result itself is the committed row.
      const insertedId = (row as unknown as Record<string, unknown>)[primaryKey] as string | number
      let postReadFilter = buildAccessFilter("read", Predicate.eq(primaryKey, insertedId))
         const versionField = args.entity.versionField
       const insertedVersion = versionField
         ? (row as unknown as Record<string, unknown>)[versionField]
         : undefined
       if (versionField && insertedVersion !== undefined) {
         assertEntityVersion(insertedVersion)
         postReadFilter = Predicate.and(postReadFilter, Predicate.eq(versionField, insertedVersion))
      }
      const verified = await args.repository.findMany({
        filter: postReadFilter,
        pagination: { kind: "offset", page: 1, pageSize: 1 },
      })

      if (!verified.rows[0]) {
        return { applied: true as const, reason: "CREATED_OUTSIDE_READ_SCOPE" as const }
      }

      return { applied: true as const, row: redact(row) }
    },

    async update(id, patch, options) {
      const safePatch = { ...patch } as Record<string, unknown>
      const prohibited = [...new Set([
        args.entity.primaryKey,
        args.entity.tenantField,
        args.entity.versionField,
        ...(args.entity.immutableFields ?? []),
      ].filter(Boolean))] as string[]

      const providedProhibited = prohibited.filter(f => Object.hasOwn(safePatch, f))
      if (providedProhibited.length > 0) {
        throw new ForbiddenError(
          `Cannot modify immutable or protected fields on ${args.entity.name}: ${providedProhibited.join(", ")}`,
          { fields: providedProhibited },
        )
      }

      let pkFilter: PredicateNode = Predicate.eq(primaryKey, id)
      if (options.expectedVersion !== undefined) {
        const versionField = args.entity.versionField
        if (!versionField) {
          throw new ConfigurationError(
            `Entity "${args.entity.name}" has no versionField declared. ` +
            "Add versionField to the entity descriptor to use expectedVersion.",
          )
        }
        pkFilter = Predicate.and(pkFilter, Predicate.eq(versionField, options.expectedVersion))
      }
      const filter = buildAccessFilter("update", pkFilter)

      // Without an OCC column there is no generic way to fence the
      // authorization snapshot against a concurrent policy-relevant write.
      // Refuse the unsafe operation rather than authorize stale state.
      if (!args.entity.versionField) {
        throw new ConfigurationError(
          `Authorized update for "${args.entity.name}" requires versionField optimistic concurrency`,
        )
      }

      const expectedVersion = options.expectedVersion
      assertEntityVersion(expectedVersion)

      const existing = await args.repository.findMany({ filter, pagination: { kind: "offset", page: 1, pageSize: 1 } })
      if (!existing.rows[0]) {
        return { applied: false, reason: "CONFLICT" } as const
      }
      const currentVersion = existing.rows[0][args.entity.versionField]
      assertEntityVersion(currentVersion)

      const candidate = { ...existing.rows[0], ...safePatch } as Record<string, unknown>
      args.authorizer.assertWrite({
        action: "update",
        record: candidate,
        changedFields: Object.keys(safePatch),
      })

       if (!args.repository.updateOneWhereReturning) {
         throw new ConfigurationError("Authorized repository requires updateOneWhereReturning support")
       }
       const updated = await args.repository.updateOneWhereReturning(
         filter,
         safePatch as Partial<TRow>,
         { optimisticConcurrency: { expectedVersion: currentVersion } },
       )

       if (!updated) {
         return { applied: false, reason: "CONFLICT" as const }
       }

        // Fence the read-scope verification to the row returned by the
        // conditional mutation. A concurrent writer must not replace it in
        // the response.
         const versionField = args.entity.versionField
          const committedVersion = versionField
            ? (updated as Record<string, unknown>)[versionField]
            : undefined
          if (versionField) assertEntityVersion(committedVersion)
          const postReadFilter = versionField
            ? Predicate.and(
                buildAccessFilter("read", Predicate.eq(primaryKey, id)),
                Predicate.eq(versionField, committedVersion as EntityVersion),
              )
           : buildAccessFilter("read", Predicate.eq(primaryKey, id))
       const verified = await args.repository.findMany({
         filter: postReadFilter,
         pagination: { kind: "offset", page: 1, pageSize: 1 },
       })
       if (!verified.rows[0]) {
         return { applied: true as const, reason: "UPDATED_OUTSIDE_READ_SCOPE" as const }
       }

        return { applied: true as const, row: redact(updated) }
    },

    async delete(id, options) {
      const versionField = args.entity.versionField
      if (!versionField) {
        throw new ConfigurationError(
          `Authorized delete for "${args.entity.name}" requires versionField optimistic concurrency`,
        )
      }
       const expectedVersion = options.expectedVersion
       assertEntityVersion(expectedVersion)
       const filter = buildAccessFilter("delete", Predicate.and(
         Predicate.eq(primaryKey, id),
         Predicate.eq(versionField, expectedVersion),
      ))

      const existing = await args.repository.findMany({ filter, pagination: { kind: "offset", page: 1, pageSize: 1 } })
      if (!existing.rows[0]) {
        return { applied: false, reason: "NOT_FOUND" as const }
      }

      args.authorizer.assertWrite({
        action: "delete",
        record: existing.rows[0],
      })

      if (!args.repository.deleteWhere) {
        throw new ConfigurationError("Authorized repository requires deleteWhere support")
      }
      const result = await args.repository.deleteWhere(filter, {
         optimisticConcurrency: { expectedVersion },
      })

      if (result.deletedCount === 0) {
        return { applied: false, reason: "CONFLICT" as const }
      }

      return { applied: true }
    },
  }
}
