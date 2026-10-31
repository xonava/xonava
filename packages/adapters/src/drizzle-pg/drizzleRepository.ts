import { and, asc, count, desc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm"
import type { AnyPgTable } from "drizzle-orm/pg-core"
import { assertEntityVersion, assertEntityVersionCanIncrement } from "@xonava/core/serialization"
import { assertVersionedWriteHasExpectedVersion, type DeleteOptions, type EntityDescriptor, type UnversionedEntityDescriptor, type UnversionedRepository, type UpdateWhereOptions, type VersionedEntityDescriptor, type VersionedRepository } from "@xonava/core/persistence"
import type { ListResult, QueryOptions, SortSpec } from "@xonava/core/query"
import type { InternalDynamicRepository } from "../repository/dynamicRepository"
import { Predicate, type PredicateNode } from "@xonava/core/domain"
import type { DrizzleColumnMap, DrizzleWhereCompiler } from "../drizzle-shared/predicateCompiler"
import { DrizzlePredicateCompiler as DefaultDrizzlePredicateCompiler, compileWhereClause, sortExpression } from "../drizzle-shared/predicateCompiler"
import { ConflictError, NotFoundError, ValidationError, ConfigurationError, OptimisticConcurrencyError } from "@xonava/core/domain"
import { DEFAULT_MAX_PAGE_SIZE, resolvePagination } from "../drizzle-shared/pagination"
import { assertVersionFieldIsFrameworkManaged, assertVersionedInsertValue, requireMappedVersionColumn, requireOptimisticConcurrencyVersion } from "../drizzle-shared/versioning"
import { assertReadConsistencySupported, validateQueryPlan } from "@xonava/core/query"
import { compileCursorPredicate, executionSort, normalizeCursorWindow } from "../drizzle-shared/cursorPagination"
import { normalizeDrizzleError, rethrowNormalizedDrizzleError, violatedConstraintName } from "../drizzle-shared/errors"

export type SelectableRow = Record<string, unknown>

export interface DrizzleUpdateResult {
  affectedRows: number
}

export interface DrizzleSessionLike {
  atomicJobTransition?: (args: {
    updateTable: AnyPgTable
    updateSet: unknown
    updateWhere: SQL<unknown> | undefined
    historyTable: AnyPgTable
    historyValues: Record<string, unknown>
    historyWhere: SQL<unknown> | undefined
  }) => Promise<{ applied: boolean; historyId: string }>
  select: (...args: unknown[]) => {
    from: (table: AnyPgTable) => {
      where: (whereClause: SQL<unknown> | undefined) => {
        limit: (limit: number) => Promise<unknown[]>
        orderBy: (orderBy: SQL<unknown> | AnyColumn) => {
          limit: (limit: number) => {
            offset: (offset: number) => Promise<unknown[]>
          }
        }
      }
    }
  }
  insert: (table: AnyPgTable) => {
    values: (data: unknown) => Promise<unknown> & {
      onConflictDoNothing: (config?: { target: AnyColumn[] }) => Promise<unknown> & {
        returning: <TReturning>(columns?: unknown) => Promise<TReturning[]>
      }
      returning: <TReturning>(columns?: unknown) => Promise<TReturning[]>
    }
  }
  update: (table: AnyPgTable) => {
    set: (data: unknown) => {
      where: (whereClause: SQL<unknown> | undefined) => Promise<DrizzleUpdateResult> & {
        returning: <TReturning>(columns?: unknown) => Promise<TReturning[]>
      }
    }
  }
  delete: (table: AnyPgTable) => {
    where: (whereClause: SQL<unknown> | undefined) => Promise<DrizzleUpdateResult> & {
      returning: <TReturning>(columns?: unknown) => Promise<TReturning[]>
    }
  }
}

const DEFAULT_CONSTRAINT_MAP: Record<string, string> = {}

export interface CreateDrizzleRepositoryArgs<T> {
  db: DrizzleSessionLike
  table: AnyPgTable
  entity: EntityDescriptor<T>
  columnMap: DrizzleColumnMap
  /** Any `{ compile }`; `compileWhere`, when present, is used for WHERE clauses. */
  predicateCompiler?: DrizzleWhereCompiler
  maxPageSize?: number
  maxOffset?: number
  constraintMap?: Record<string, string>
}

function resolvePrimaryKey<T>(entity: EntityDescriptor<T>, columnMap: DrizzleColumnMap): keyof T & string {
  const primaryKey = entity.primaryKey ?? ("id" as keyof T & string)
  if (!columnMap[primaryKey]) throw new Error(`Entity ${entity.name} is missing primary key column \"${String(primaryKey)}\"`)
  return primaryKey
}

function resolveVersionField<T>(entity: EntityDescriptor<T>): (keyof T & string) | undefined {
  return entity.versionField
}

const SORT_OPTIONS = { dialect: "postgres" } as const

function compileOrderBy(
  sort: readonly SortSpec[] | undefined,
  columnMap: DrizzleColumnMap,
  fallbackColumn: AnyColumn,
  primaryKey: string,
  primaryKeyColumn: AnyColumn,
  /** Cursor pages need sort keys that order exactly like keyset predicates compare; offset pages keep native (index-friendly) order. */
  forCursor: boolean,
): SQL<unknown> {
  const sortKey = (column: AnyColumn) => (forCursor ? sortExpression(column, SORT_OPTIONS) : column)
  if (!sort || sort.length === 0) {
    return fallbackColumn === primaryKeyColumn ? sql`${fallbackColumn}` : sql`${asc(fallbackColumn)}, ${asc(primaryKeyColumn)}`
  }

  const clauses = sort.map((s) => {
    const column = columnMap[s.field]
    if (!column) throw new ValidationError(`Unknown sort field: "${s.field}"`)
    // Cursor sort keys order exactly like keyset predicates compare (code-point text).
    const key = sortKey(column)
    if (s.nulls) return sql`${key} ${sql.raw(s.direction === "desc" ? "DESC" : "ASC")} ${sql.raw(s.nulls === "first" ? "NULLS FIRST" : "NULLS LAST")}`
    return s.direction === "desc" ? desc(key) : asc(key)
  })

  if (!sort.some((s) => s.field === primaryKey)) {
    const direction = sort[sort.length - 1]!.direction
    const key = sortKey(primaryKeyColumn)
    clauses.push(direction === "desc" ? desc(key) : asc(key))
  }
  if (clauses.length === 1) return clauses[0]!
  return sql.join(clauses, sql`, `)
}

/**
 * Normalizes a write failure. When a unique violation names a constraint found
 * in `constraintMap`, the resulting ConflictError carries the mapped field in
 * its details; the constraint name and provider message are never exposed.
 */
function rethrowConstraintError(error: unknown, constraintMap: Record<string, string>): never {
  const normalized = normalizeDrizzleError(error, "postgresql")
  if (normalized instanceof ConflictError && !(error instanceof ConflictError)) {
    const constraint = violatedConstraintName(error)
    const field = constraint !== undefined && Object.prototype.hasOwnProperty.call(constraintMap, constraint) ? constraintMap[constraint] : undefined
    if (field !== undefined) throw new ConflictError(normalized.message, { ...(normalized.details as Record<string, unknown>), field })
  }
  throw normalized
}

/** Runs a read and normalizes provider failures so SQL text and parameters never escape. */
async function normalizedRead<R>(read: () => Promise<R>): Promise<R> {
  try {
    return await read()
  } catch (error) {
    rethrowNormalizedDrizzleError(error, "postgresql")
  }
}

function guardEmptyPredicate(filter: PredicateNode | undefined, operation: string, entityName: string): void {
  if (filter === undefined || filter === null) {
    throw new ValidationError(`${operation}: cannot execute on ${entityName} without a filter predicate — empty predicates would match all rows.`)
  }
}

function isAlwaysTruePredicate(node: PredicateNode): boolean {
  switch (node.kind) {
    case "literal":
      return node.value === true
    case "and":
      return node.filters.length === 0 || node.filters.every(isAlwaysTruePredicate)
    case "or":
      return node.filters.length > 0 && node.filters.some(isAlwaysTruePredicate)
    case "not":
      return isAlwaysFalsePredicate(node.filter)
    default:
      return false
  }
}

function isAlwaysFalsePredicate(node: PredicateNode): boolean {
  switch (node.kind) {
    case "literal":
      return node.value === false
    case "or":
      return node.filters.length === 0 || node.filters.every(isAlwaysFalsePredicate)
    case "and":
      return node.filters.length > 0 && node.filters.some(isAlwaysFalsePredicate)
    case "not":
      return isAlwaysTruePredicate(node.filter)
    default:
      return false
  }
}

function guardAllRowDestructive(filter: PredicateNode, operation: string, entityName: string): void {
  if (isAlwaysTruePredicate(filter)) {
    throw new ConfigurationError(
      `All-row ${operation} on entity "${entityName}" is forbidden.`,
    )
  }
}

async function fetchFirstByWhere<T>(args: {
  db: DrizzleSessionLike
  table: AnyPgTable
  whereClause: SQL<unknown> | undefined
}): Promise<T | null> {
  const [row] = await normalizedRead(() => args.db
    .select()
    .from(args.table)
    .where(args.whereClause)
    .limit(1))

  return (row as T | undefined) ?? null
}

async function fetchMatchingPrimaryKeys<T>(args: {
  db: DrizzleSessionLike
  table: AnyPgTable
  whereClause: SQL<unknown>
  primaryKeyColumn: AnyColumn
}): Promise<T[]> {
  const rows = await normalizedRead(() => args.db
    .select({ primaryKey: args.primaryKeyColumn })
    .from(args.table)
    .where(args.whereClause)
    .limit(2))
  return rows as T[]
}

export function createDrizzleRepository<T extends SelectableRow, TId = string>(
  args: CreateDrizzleRepositoryArgs<T> & { entity: VersionedEntityDescriptor<T> },
): VersionedRepository<T, TId>
export function createDrizzleRepository<T extends SelectableRow, TId = string>(
  args: CreateDrizzleRepositoryArgs<T> & { entity: UnversionedEntityDescriptor<T> },
): UnversionedRepository<T, TId>
export function createDrizzleRepository<T extends SelectableRow, TId = string>(args: CreateDrizzleRepositoryArgs<T>): InternalDynamicRepository<T, TId>
export function createDrizzleRepository<T extends SelectableRow, TId = string>(args: CreateDrizzleRepositoryArgs<T>): InternalDynamicRepository<T, TId> {
  const predicateCompiler = args.predicateCompiler ?? new DefaultDrizzlePredicateCompiler(args.columnMap, { dialect: "postgres" })
  const primaryKey = resolvePrimaryKey(args.entity, args.columnMap)
   const primaryKeyColumn = args.columnMap[primaryKey]!
  const versionField = resolveVersionField(args.entity)
  const fallbackSortColumn = args.columnMap.createdAt ?? primaryKeyColumn
  const maxPageSize = args.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE
   if (!Number.isSafeInteger(maxPageSize) || maxPageSize <= 0) {
    throw new ConfigurationError("PostgreSQL maxPageSize must be a finite positive integer")
  }
  const constraintMap = args.constraintMap ?? DEFAULT_CONSTRAINT_MAP
  if (args.maxOffset !== undefined && (!Number.isSafeInteger(args.maxOffset) || args.maxOffset < 0)) {
    throw new ConfigurationError("PostgreSQL maxOffset must be a finite non-negative integer")
  }

  const repository = {
    async findById(id: TId): Promise<T | null> {
      return fetchFirstByWhere<T>({
        db: args.db,
        table: args.table,
        whereClause: eq(primaryKeyColumn, id as never),
      })
    },
    async findOneWhere(filter: PredicateNode): Promise<T | null> {
      guardEmptyPredicate(filter, "findOneWhere", args.entity.name)
      return fetchFirstByWhere<T>({
        db: args.db,
        table: args.table,
        whereClause: compileWhereClause(predicateCompiler, filter),
      })
    },
    async countUpTo(filter: PredicateNode | undefined, limit: number): Promise<number> {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new ValidationError("countUpTo limit must be a positive integer")
      const probe = await args.db
        .select({ one: sql`1` })
        .from(args.table)
        .where(filter ? compileWhereClause(predicateCompiler, filter) : undefined)
        .limit(limit)
      return probe.length
    },
    async findMany(options?: QueryOptions): Promise<ListResult<T>> {
      validateQueryPlan({ ...(options?.filter ? { filter: options.filter } : {}), ...(options?.sort ? { sort: options.sort } : {}), ...(options?.projection ? { projection: options.projection } : {}), ...(options?.consistency ? { consistency: options.consistency } : {}) })
      if (options?.consistency) assertReadConsistencySupported(options.consistency, ["strong"])
      const requestedPagination = options?.pagination
      const cursor = requestedPagination?.kind === "cursor" ? requestedPagination : undefined
      const offsetPagination = requestedPagination?.kind === "offset" ? requestedPagination : undefined
      const sort = options?.sort
      if (cursor && (!sort || sort.length === 0)) throw new ValidationError("cursor pagination requires an explicit stable sort")
      const pagination = resolvePagination(cursor ? { kind: "offset", page: 1, pageSize: cursor.limit } : offsetPagination, maxPageSize, args.maxOffset)
      const filter = cursor
        ? (cursor.values ? (options?.filter ? Predicate.and(options.filter, compileCursorPredicate(sort!, { ...cursor, values: cursor.values })) : compileCursorPredicate(sort!, { ...cursor, values: cursor.values })) : options?.filter)
        : options?.filter
      const whereClause = filter ? compileWhereClause(predicateCompiler, filter) : undefined
      // The total is opt-in and offset-only. It counts the caller's filter (tenant/ABAC scope included), never the cursor predicate.
      let rowCount: number | undefined
      if (!cursor && offsetPagination?.includeTotal === true) {
        const totalWhere = options?.filter ? compileWhereClause(predicateCompiler, options.filter) : undefined
        const [countResult] = await args.db
          .select({ count: count() })
          .from(args.table)
          .where(totalWhere)
          .limit(1)
        rowCount = Number((countResult as { count?: number } | undefined)?.count ?? 0)
      }
       const effectiveSort = cursor ? executionSort(sort!, cursor.direction) : sort
       const orderBy = compileOrderBy(effectiveSort, args.columnMap, fallbackSortColumn, primaryKey, primaryKeyColumn, cursor !== undefined)
      const selection = options?.projection
        ? Object.fromEntries(options.projection.fields.map(field => {
            const column = args.columnMap[field]
            if (!column) throw new ValidationError(`Unknown projection field: "${field}"`)
            return [field, column]
          }))
        : undefined
      const fetched = await normalizedRead(() => args.db
        .select(...(selection ? [selection] : []))
        .from(args.table)
        .where(whereClause)
        .orderBy(orderBy)
        .limit(cursor ? pagination.pageSize + 1 : pagination.pageSize)
        .offset(pagination.offset))

      const window = cursor ? normalizeCursorWindow(fetched as T[], pagination.pageSize, cursor.direction, cursor.values !== undefined) : undefined

      return {
        rows: (window?.rows ?? fetched) as T[],
        ...(rowCount === undefined ? {} : { rowCount }),
        page: pagination.page,
        pageSize: pagination.pageSize,
        ...(window ? { pageInfo: { kind: "cursor" as const, hasNextPage: window.hasNextPage, hasPreviousPage: window.hasPreviousPage } } : {}),
      }
    },
    async insert(data: Partial<T>): Promise<T> {
      assertVersionedInsertValue(args.entity, data)
      try {
        const [inserted] = await args.db.insert(args.table).values(data).returning<T>()
        if (!inserted) {
          throw new ConfigurationError(`${args.entity.name} INSERT ... RETURNING returned no rows`)
        }
         if (versionField) assertEntityVersion((inserted as Record<string, unknown>)[versionField])
         return inserted
      } catch (error) {
        rethrowConstraintError(error, constraintMap)
      }
    },
    async update(id: TId, data: Partial<T>, options?: UpdateWhereOptions): Promise<T> {
      assertVersionedWriteHasExpectedVersion(args.entity, options)
      if (options?.optimisticConcurrency) assertEntityVersionCanIncrement(options.optimisticConcurrency.expectedVersion)
      requireOptimisticConcurrencyVersion(args.entity, options?.optimisticConcurrency !== undefined)
      const mappedVersionColumn = requireMappedVersionColumn(args.entity, versionField, args.columnMap)
      assertVersionFieldIsFrameworkManaged(args.entity, data)
      const setData = versionField
         ? { ...(data as Record<string, unknown>), [versionField]: sql`${args.columnMap[versionField]!} + 1` }
        : data
      const whereClause = options?.optimisticConcurrency && versionField
           ? sql`${eq(primaryKeyColumn, id as never)} AND ${mappedVersionColumn!} = ${options.optimisticConcurrency.expectedVersion as never} AND ${mappedVersionColumn!} < ${sql.raw(String(Number.MAX_SAFE_INTEGER))}`
        : eq(primaryKeyColumn, id as never)

      try {
        const [updated] = await args.db
          .update(args.table)
          .set(setData)
          .where(whereClause)
          .returning<T>()
        if (!updated) {
          if (options?.optimisticConcurrency) {
            throw new OptimisticConcurrencyError(
              `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`
            )
          }
          throw new NotFoundError(`${args.entity.name} record not found`)
        }
         if (versionField) assertEntityVersion((updated as Record<string, unknown>)[versionField])
         return updated
      } catch (error) {
        rethrowConstraintError(error, constraintMap)
      }
    },
     async updateOneWhere(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<{ updatedCount: number }> {
      guardEmptyPredicate(filter, "updateOneWhere", args.entity.name)
      guardAllRowDestructive(filter, "updateOneWhere", args.entity.name)
      assertVersionedWriteHasExpectedVersion(args.entity, options)
      if (options?.optimisticConcurrency) assertEntityVersionCanIncrement(options.optimisticConcurrency.expectedVersion)
      assertVersionFieldIsFrameworkManaged(args.entity, data)
      const mappedVersionColumn = requireMappedVersionColumn(args.entity, versionField, args.columnMap)

      if (options?.optimisticConcurrency) {
        if (!versionField) {
          throw new ConfigurationError(
            `Entity "${args.entity.name}" has no versionField configured. Optimistic concurrency requires a version column.`
          )
        }
      }

       const compiledFilter = compileWhereClause(predicateCompiler, filter)
       const matchingRows = await fetchMatchingPrimaryKeys<{ primaryKey: TId }>({
         db: args.db,
         table: args.table,
         whereClause: compiledFilter,
         primaryKeyColumn,
       })
       if (matchingRows.length > 1) {
         throw new ValidationError(`${args.entity.name} updateOneWhere matched multiple rows`)
       }
       if (matchingRows.length === 0) {
         if (options?.optimisticConcurrency) {
           throw new OptimisticConcurrencyError(
             `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`
           )
         }
         return { updatedCount: 0 }
       }
       const matchedPrimaryKey = matchingRows[0]!.primaryKey
       const oneRowFilter = sql`${compiledFilter} AND ${eq(primaryKeyColumn, matchedPrimaryKey as never)}`

       let setData = data as Record<string, unknown>

       if (versionField) {
          const versionColumn = mappedVersionColumn!
        setData = {
          ...setData,
          [versionField]: sql`${versionColumn} + 1`,
        }

         const combinedWhere = options?.optimisticConcurrency
             ? sql`${oneRowFilter} AND ${versionColumn} = ${options.optimisticConcurrency.expectedVersion as never} AND ${versionColumn} < ${sql.raw(String(Number.MAX_SAFE_INTEGER))}`
           : oneRowFilter
        try {
           const updated = await args.db
             .update(args.table)
             .set(setData)
             .where(combinedWhere)
            .returning<T>()
          const updatedCount = updated.length

          if (options?.optimisticConcurrency && updatedCount === 0) {
            throw new OptimisticConcurrencyError(
              `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`
            )
          }

          return { updatedCount }
        } catch (error) {
          if (error instanceof OptimisticConcurrencyError) throw error
          rethrowConstraintError(error, constraintMap)
        }
      }

      try {
        const updated = await args.db
          .update(args.table)
          .set(setData)
           .where(oneRowFilter)
          .returning<T>()
        return { updatedCount: updated.length }
      } catch (error) {
        rethrowConstraintError(error, constraintMap)
      }
    },
     async updateOneWhereReturning(filter: PredicateNode, data: Partial<T>, options?: UpdateWhereOptions): Promise<T | null> {
      guardEmptyPredicate(filter, "updateOneWhereReturning", args.entity.name)
      guardAllRowDestructive(filter, "updateOneWhereReturning", args.entity.name)
      assertVersionedWriteHasExpectedVersion(args.entity, options)
      if (options?.optimisticConcurrency) assertEntityVersionCanIncrement(options.optimisticConcurrency.expectedVersion)
      assertVersionFieldIsFrameworkManaged(args.entity, data)
      const mappedVersionColumn = requireMappedVersionColumn(args.entity, versionField, args.columnMap)
      if (options?.optimisticConcurrency && !versionField) {
        throw new ConfigurationError(
          `Entity "${args.entity.name}" has no versionField configured. Optimistic concurrency requires a version column.`
        )
      }

      const compiledFilter = compileWhereClause(predicateCompiler, filter)
      const matchingRows = await fetchMatchingPrimaryKeys<{ primaryKey: TId }>({
        db: args.db,
        table: args.table,
        whereClause: compiledFilter,
        primaryKeyColumn,
      })
      if (matchingRows.length > 1) {
        throw new ValidationError(`${args.entity.name} updateOneWhereReturning matched multiple rows`)
      }
      if (matchingRows.length === 0) {
        if (options?.optimisticConcurrency) {
          throw new OptimisticConcurrencyError(
             `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`
          )
        }
        return null
      }

      const matchedPrimaryKey = matchingRows[0]!.primaryKey
      const oneRowFilter = sql`${compiledFilter} AND ${eq(primaryKeyColumn, matchedPrimaryKey as never)}`
      let whereClause = oneRowFilter
      let setData = data as Record<string, unknown>
       const versionFieldName = args.entity.versionField
       if (versionFieldName) {
         const versionColumn = mappedVersionColumn!
         setData = { ...setData, [versionFieldName]: sql`${versionColumn} + 1` }
        if (options?.optimisticConcurrency) {
            whereClause = sql`${whereClause} AND ${versionColumn} = ${options.optimisticConcurrency.expectedVersion as never} AND ${versionColumn} < ${sql.raw(String(Number.MAX_SAFE_INTEGER))}`
        }
      }

      try {
        const [updated] = await args.db.update(args.table).set(setData).where(whereClause).returning<T>()
        if (!updated && options?.optimisticConcurrency) {
          throw new OptimisticConcurrencyError(
              `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`
          )
        }
         if (updated && versionField) assertEntityVersion((updated as Record<string, unknown>)[versionField])
         return updated ?? null
      } catch (error) {
        if (error instanceof OptimisticConcurrencyError) throw error
        rethrowConstraintError(error, constraintMap)
      }
    },
    async delete(id: TId, options?: DeleteOptions): Promise<void> {
      assertVersionedWriteHasExpectedVersion(args.entity, options, false)
        const mappedVersionColumn = requireMappedVersionColumn(args.entity, args.entity.versionField, args.columnMap)
      try {
         const versionColumn = mappedVersionColumn
        if (options?.optimisticConcurrency && !versionColumn) throw new ConfigurationError(`Optimistic concurrency for "${args.entity.name}" requires a mapped version field`)
        const deleted = await args.db
          .delete(args.table)
           .where(options?.optimisticConcurrency
             ? and(eq(primaryKeyColumn, id as never), eq(versionColumn!, options.optimisticConcurrency.expectedVersion as never))
             : eq(primaryKeyColumn, id as never))
          .returning<T>()

        if (deleted.length === 0) {
          if (options?.optimisticConcurrency) {
            const existing = await fetchMatchingPrimaryKeys({ db: args.db, table: args.table, whereClause: eq(primaryKeyColumn, id as never), primaryKeyColumn })
            if (existing.length > 0) {
              throw new OptimisticConcurrencyError(
                `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`
              )
            }
          }
          if (options?.idempotent !== true) throw new NotFoundError(`${args.entity.name} record not found`)
        }
      } catch (error) {
        if (error instanceof NotFoundError || error instanceof OptimisticConcurrencyError) throw error
        rethrowConstraintError(error, constraintMap)
      }
    },
     async deleteWhere(filter: PredicateNode, options?: DeleteOptions): Promise<{ deletedCount: number }> {
      guardEmptyPredicate(filter, "deleteWhere", args.entity.name)
      guardAllRowDestructive(filter, "deleteWhere", args.entity.name)
      assertVersionedWriteHasExpectedVersion(args.entity, options, false)
        const mappedVersionColumn = requireMappedVersionColumn(args.entity, args.entity.versionField, args.columnMap)
      try {
         const versionColumn = mappedVersionColumn
        if (options?.optimisticConcurrency && !versionColumn) {
          throw new ConfigurationError(`Optimistic concurrency for "${args.entity.name}" requires a mapped version field`)
        }
        let whereClause = compileWhereClause(predicateCompiler, filter)
        const unversionedWhere = whereClause
        if (options?.optimisticConcurrency) {
          const versionPredicate = eq(versionColumn!, options.optimisticConcurrency.expectedVersion as never)
          whereClause = whereClause ? (and(whereClause, versionPredicate) ?? versionPredicate) : versionPredicate
        }
        const deleted = await args.db
          .delete(args.table)
          .where(whereClause)
          .returning<T>()

        if (options?.optimisticConcurrency && deleted.length === 0) {
          const existing = await fetchMatchingPrimaryKeys({ db: args.db, table: args.table, whereClause: unversionedWhere!, primaryKeyColumn })
          if (existing.length > 0) {
            throw new OptimisticConcurrencyError(
               `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`,
            )
          }
          throw new NotFoundError(`${args.entity.name} record not found`)
        }
        return { deletedCount: deleted.length }
      } catch (error) {
        if (error instanceof OptimisticConcurrencyError || error instanceof NotFoundError || error instanceof ConfigurationError) throw error
        rethrowConstraintError(error, constraintMap)
      }
    },
   }
   return repository
}
