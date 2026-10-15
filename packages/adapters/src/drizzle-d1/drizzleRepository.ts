import { and, asc, count, desc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm"
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core"
import { assertEntityVersion } from "@xonava/core/serialization"
import { assertVersionedWriteHasExpectedVersion, type DeleteOptions, type EntityDescriptor, type UnversionedEntityDescriptor, type UnversionedRepository, type UpdateWhereOptions, type VersionedEntityDescriptor, type VersionedRepository } from "@xonava/core/persistence"
import type { ListResult, QueryOptions, SortSpec } from "@xonava/core/query"
import type { InternalDynamicRepository } from "../repository/dynamicRepository"
import { Predicate, type PredicateNode } from "@xonava/core/domain"
import type { DrizzleColumnMap, DrizzleWhereCompiler } from "../drizzle-shared/predicateCompiler"
import { DrizzlePredicateCompiler as DefaultDrizzlePredicateCompiler, compileWhereClause, sortExpression } from "../drizzle-shared/predicateCompiler"
import { NotFoundError, ValidationError, ConfigurationError, OptimisticConcurrencyError } from "@xonava/core/domain"
import { getAffectedRows } from "./d1Utils"
import { DEFAULT_MAX_PAGE_SIZE, resolvePagination } from "../drizzle-shared/pagination"
import { assertVersionCanIncrement, assertVersionFieldIsFrameworkManaged, assertVersionedInsertValue, requireMappedVersionColumn, requireOptimisticConcurrencyVersion } from "../drizzle-shared/versioning"
import { assertReadConsistencySupported, validateQueryPlan } from "@xonava/core/query"
import { compileCursorPredicate, executionSort, normalizeCursorWindow } from "../drizzle-shared/cursorPagination"
import { rethrowNormalizedDrizzleError } from "../drizzle-shared/errors"

type SelectableRow = Record<string, unknown>

export interface DrizzleUpdateResult {
  affectedRows: number
}

export interface DrizzleSessionLike {
  atomicJobTransition?: (args: {
    updateTable: AnySQLiteTable
    updateSet: unknown
    updateWhere: SQL<unknown> | undefined
    historyTable: AnySQLiteTable
    historyValues: Record<string, unknown>
    historyWhere: SQL<unknown> | undefined
  }) => Promise<{ applied: boolean; historyId: string }>
  select: (...args: unknown[]) => {
    from: (table: AnySQLiteTable) => {
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
  // Keep the executable Drizzle insert builder visible to D1 idempotency and outbox code.
  insert: (table: AnySQLiteTable) => { values: (data: unknown) => unknown }
  update: (table: AnySQLiteTable) => { set: (data: unknown) => { where: (whereClause: SQL<unknown> | undefined) => Promise<DrizzleUpdateResult> } }
  updateReturning?: (table: AnySQLiteTable, data: unknown, whereClause: SQL<unknown> | undefined) => Promise<unknown[]>
  delete: (table: AnySQLiteTable) => { where: (whereClause: SQL<unknown> | undefined) => Promise<DrizzleUpdateResult> }
}

const DEFAULT_CONSTRAINT_MAP: Record<string, string> = {}

export interface CreateDrizzleRepositoryArgs<T> {
  db: DrizzleSessionLike
  table: AnySQLiteTable
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

const SORT_OPTIONS = { dialect: "sqlite" } as const

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

  const clauses = sort
    .map((s) => {
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

function rethrowConstraintError(error: unknown, constraintMap: Record<string, string>): never {
  void constraintMap
  rethrowNormalizedDrizzleError(error,"d1")
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
  table: AnySQLiteTable
  whereClause: SQL<unknown> | undefined
}): Promise<T | null> {
  const [row] = await args.db
    .select()
    .from(args.table)
    .where(args.whereClause)
    .limit(1)

  return (row as T | undefined) ?? null
}

async function fetchMatchingPrimaryKeys<T>(args: {
  db: DrizzleSessionLike
  table: AnySQLiteTable
  whereClause: SQL<unknown>
  primaryKeyColumn: AnyColumn
}): Promise<T[]> {
  const rows = await args.db
    .select({ primaryKey: args.primaryKeyColumn })
    .from(args.table)
    .where(args.whereClause)
    .limit(2)
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
  const predicateCompiler = args.predicateCompiler ?? new DefaultDrizzlePredicateCompiler(args.columnMap, { dialect: "sqlite" })
  const primaryKey = resolvePrimaryKey(args.entity, args.columnMap)
   const primaryKeyColumn = args.columnMap[primaryKey]!
  const versionField = resolveVersionField(args.entity)
  const fallbackSortColumn = args.columnMap.createdAt ?? primaryKeyColumn
  const maxPageSize = args.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE
   if (!Number.isSafeInteger(maxPageSize) || maxPageSize <= 0) {
    throw new ConfigurationError("D1 maxPageSize must be a finite positive integer")
  }
  const constraintMap = args.constraintMap ?? DEFAULT_CONSTRAINT_MAP
  if (args.maxOffset !== undefined && (!Number.isSafeInteger(args.maxOffset) || args.maxOffset < 0)) {
    throw new ConfigurationError("D1 maxOffset must be a finite non-negative integer")
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
      const [countResult] = await args.db
        .select({ count: count() })
        .from(args.table)
        .where(whereClause)
        .limit(1)

      const rowCount = Number((countResult as { count?: number } | undefined)?.count ?? 0)
       const effectiveSort = cursor ? executionSort(sort!, cursor.direction) : sort
       const orderBy = compileOrderBy(effectiveSort, args.columnMap, fallbackSortColumn, primaryKey, primaryKeyColumn, cursor !== undefined)
      const selection = options?.projection
        ? Object.fromEntries(options.projection.fields.map(field => {
            const column = args.columnMap[field]
            if (!column) throw new ValidationError(`Unknown projection field: "${field}"`)
            return [field, column]
          }))
        : undefined
      const fetched = await args.db
        .select(...(selection ? [selection] : []))
        .from(args.table)
        .where(whereClause)
        .orderBy(orderBy)
        .limit(cursor ? pagination.pageSize + 1 : pagination.pageSize)
        .offset(pagination.offset)

      const window = cursor ? normalizeCursorWindow(fetched as T[], pagination.pageSize, cursor.direction, cursor.values !== undefined) : undefined

      return {
        rows: (window?.rows ?? fetched) as T[],
        rowCount,
        page: pagination.page,
        pageSize: pagination.pageSize,
        ...(window ? { pageInfo: { kind: "cursor" as const, hasNextPage: window.hasNextPage, hasPreviousPage: window.hasPreviousPage } } : {}),
      }
    },
    async insert(data: Partial<T>): Promise<T> {
      assertVersionedInsertValue(args.entity, data)
      try {
        await args.db.insert(args.table).values(data)
      } catch (error) {
        rethrowConstraintError(error, constraintMap)
      }

      const id = data[primaryKey] as TId | undefined
      if (id === undefined) throw new Error(`Inserted ${args.entity.name} record is missing primary key value`)
      const inserted = await fetchFirstByWhere<T>({
        db: args.db,
        table: args.table,
        whereClause: eq(primaryKeyColumn, id as never),
      })

      if (!inserted) throw new NotFoundError(`${args.entity.name} record not found after insert`)
       if (versionField) assertEntityVersion((inserted as Record<string, unknown>)[versionField])
       return inserted
    },
    async update(id: TId, data: Partial<T>, options?: UpdateWhereOptions): Promise<T> {
      assertVersionedWriteHasExpectedVersion(args.entity, options)
      if (options?.optimisticConcurrency) assertVersionCanIncrement(options.optimisticConcurrency.expectedVersion)
      requireMappedVersionColumn(args.entity, versionField, args.columnMap)
      if (!repository.updateOneWhereReturning) {
        throw new ConfigurationError(`Entity "${args.entity.name}" requires updateOneWhereReturning for update(id)`)
      }
      const updated = await repository.updateOneWhereReturning(Predicate.eq(primaryKey, id as never), data, options)
      if (!updated) throw new NotFoundError(`${args.entity.name} record not found`)
      return updated
    },
    async updateOneWhere(filter, data: Partial<T>, options?: UpdateWhereOptions): Promise<{ updatedCount: number }> {
      guardEmptyPredicate(filter, "updateOneWhere", args.entity.name)
      guardAllRowDestructive(filter, "updateOneWhere", args.entity.name)
      assertVersionedWriteHasExpectedVersion(args.entity, options)
      if (options?.optimisticConcurrency) assertVersionCanIncrement(options.optimisticConcurrency.expectedVersion)
      assertVersionFieldIsFrameworkManaged(args.entity, data)
      const mappedVersionColumn = requireMappedVersionColumn(args.entity, versionField, args.columnMap)

       requireOptimisticConcurrencyVersion(args.entity, options?.optimisticConcurrency !== undefined)

       let compiledFilter = compileWhereClause(predicateCompiler, filter)
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
       compiledFilter = sql`${compiledFilter} AND ${eq(primaryKeyColumn, matchingRows[0]!.primaryKey as never)}`

       let setData = data as Record<string, unknown>

       if (versionField) {
          const versionColumn = mappedVersionColumn!
        if (options?.optimisticConcurrency) {
          const expectedVersion = options.optimisticConcurrency.expectedVersion
           compiledFilter = sql`${compiledFilter} AND ${versionColumn} = ${expectedVersion as never} AND ${versionColumn} < ${Number.MAX_SAFE_INTEGER}`
        }
        setData = {
          ...setData,
          [versionField]: sql`${versionColumn} + 1`,
        }
      }

      try {
        const result = await args.db
          .update(args.table)
          .set(setData)
          .where(compiledFilter)
        const updatedCount = getAffectedRows(result)
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
    },
    async delete(id: TId, options?: DeleteOptions): Promise<void> {
      assertVersionedWriteHasExpectedVersion(args.entity, options, false)
      const mappedVersionColumn = requireMappedVersionColumn(args.entity, args.entity.versionField, args.columnMap)
      const versionColumn = mappedVersionColumn
      if (options?.optimisticConcurrency && !versionColumn) throw new ConfigurationError(`Optimistic concurrency for "${args.entity.name}" requires a mapped version field`)
      const result = await args.db
        .delete(args.table)
        .where(options?.optimisticConcurrency
          ? and(eq(primaryKeyColumn, id as never), eq(versionColumn!, options.optimisticConcurrency.expectedVersion as never))
          : eq(primaryKeyColumn, id as never))

      if (getAffectedRows(result) === 0 && options?.idempotent !== true) {
        throw new NotFoundError(`${args.entity.name} record not found`)
      }
    },
    async deleteWhere(filter, options?: DeleteOptions): Promise<{ deletedCount: number }> {
      guardEmptyPredicate(filter, "deleteWhere", args.entity.name)
      guardAllRowDestructive(filter, "deleteWhere", args.entity.name)
      assertVersionedWriteHasExpectedVersion(args.entity, options, false)
      const mappedVersionColumn = requireMappedVersionColumn(args.entity, args.entity.versionField, args.columnMap)
      const versionColumn = mappedVersionColumn
      if (options?.optimisticConcurrency && !versionColumn) {
        throw new ConfigurationError(`Optimistic concurrency for "${args.entity.name}" requires a mapped version field`)
      }
      const compiledWhere = compileWhereClause(predicateCompiler, filter)
      if (!compiledWhere) throw new Error(`Delete filter for ${args.entity.name} compiled to an empty where clause`)
      let whereClause = compiledWhere
      if (options?.optimisticConcurrency) {
        whereClause = and(whereClause, eq(versionColumn!, options.optimisticConcurrency.expectedVersion as never))!
      }
      const result = await args.db
        .delete(args.table)
        .where(whereClause)

      const deletedCount = getAffectedRows(result)
      if (options?.optimisticConcurrency && deletedCount === 0) {
        throw new OptimisticConcurrencyError(
           `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`,
        )
      }
      return { deletedCount }
    },
  } as InternalDynamicRepository<T, TId>

  if (versionField) delete repository.updateManyWhere

  const updateReturning = args.db.updateReturning
  if (updateReturning) {
    repository.updateOneWhereReturning = async (filter, data, options) => {
      guardEmptyPredicate(filter, "updateOneWhereReturning", args.entity.name)
      guardAllRowDestructive(filter, "updateOneWhereReturning", args.entity.name)
      assertVersionedWriteHasExpectedVersion(args.entity, options)
      assertVersionFieldIsFrameworkManaged(args.entity, data)
      const mappedVersionColumn = requireMappedVersionColumn(args.entity, versionField, args.columnMap)
       requireOptimisticConcurrencyVersion(args.entity, options?.optimisticConcurrency !== undefined)
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
             `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`,
          )
        }
        return null
      }

      let whereClause: SQL<unknown> = sql`${compiledFilter} AND ${eq(primaryKeyColumn, matchingRows[0]!.primaryKey)}`
      let setData = data as Record<string, unknown>
      if (versionField) {
         const versionColumn = mappedVersionColumn!
        if (options?.optimisticConcurrency) {
           whereClause = sql`${whereClause} AND ${versionColumn} = ${options.optimisticConcurrency.expectedVersion as never} AND ${versionColumn} < ${Number.MAX_SAFE_INTEGER}`
        }
        setData = { ...setData, [versionField]: sql`${versionColumn} + 1` }
      }

      try {
        const [updated] = await updateReturning(args.table, setData, whereClause)
        if (!updated && options?.optimisticConcurrency) {
          throw new OptimisticConcurrencyError(
             `${args.entity.name} version mismatch: expected version ${options.optimisticConcurrency.expectedVersion}`,
          )
        }
         if (updated && versionField) assertEntityVersion((updated as Record<string, unknown>)[versionField])
         return (updated as T | undefined) ?? null
      } catch (error) {
        if (error instanceof OptimisticConcurrencyError) throw error
        rethrowConstraintError(error, constraintMap)
      }
    }
  }

  return repository
}
