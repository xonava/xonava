import type { AnyPgTable, PgTransactionConfig } from "drizzle-orm/pg-core"
import type { InteractiveTransactionProvider, TransactionOptions, PersistenceProvider } from "core/persistence"
import type { PersistenceCapabilities } from "core/persistence"
import type { EntityDescriptor, UnversionedEntityDescriptor, UnversionedRepository, VersionedEntityDescriptor, VersionedRepository } from "core/persistence"
import type { DrizzleSessionLike } from "./drizzleRepository"
import { createDrizzleRepository } from "./drizzleRepository"
import type { DrizzleColumnMap } from "../drizzle-shared/predicateCompiler"
import { CachePrefixLedger, resolveRegistration, type RegistrableEntity } from "../drizzle-shared/entityRegistration"
import { ConfigurationError } from "core/domain"
import { sql } from "drizzle-orm"
import { classifyTransactionFailure, statementTimeoutMs } from "../drizzle-shared/transactionOutcome"
import { createPgSession, type PgDatabaseLike } from "./pgSession"

const sessionByProvider = new WeakMap<PersistenceProvider, DrizzleSessionLike>()

export function getDrizzleSession(provider: PersistenceProvider): DrizzleSessionLike {
  const session = sessionByProvider.get(provider)
  if (!session) throw new ConfigurationError("No Drizzle session found for this persistence provider")
  return session
}

export interface EntityMapping {
  table: AnyPgTable
  columnMap: DrizzleColumnMap
}

export class DrizzleEntityRegistry {
  private mappings = new Map<string, EntityMapping>()
  private cachePrefixes = new CachePrefixLedger()

  /**
   * Accepts a persistence descriptor or a compiled `defineEntity()` definition.
   * A compiled entity's resolved cache key prefix must be unique across the registry.
   */
  register<T>(input: RegistrableEntity<T>, table: AnyPgTable, columnMap: DrizzleColumnMap, namespace?: string): this {
    const { descriptor: entity, cachePrefix } = resolveRegistration(input)
    const key = namespace ? `${namespace}:${entity.name}` : entity.name
    validateEntityRegistration(entity, columnMap, key)
    if (this.mappings.has(key)) {
      throw new ConfigurationError(`Entity "${key}" is already registered in the Drizzle entity registry.`)
    }
    this.cachePrefixes.assertAvailable(cachePrefix)
    this.cachePrefixes.claim(cachePrefix)
    this.mappings.set(key, { table, columnMap })
    return this
  }

  get(entityName: string, namespace?: string): EntityMapping | undefined {
    const key = namespace ? `${namespace}:${entityName}` : entityName
    return this.mappings.get(key)
  }
}

function validateEntityRegistration<T>(
  entity: EntityDescriptor<T>,
  columnMap: DrizzleColumnMap,
  key: string,
): void {
  if (!entity || typeof entity.name !== "string" || entity.name.trim() === "") {
    throw new ConfigurationError(`Drizzle registry registration "${key}" requires a non-empty entity name.`)
  }
  if (!entity.fields || typeof entity.fields !== "object" || Object.keys(entity.fields).length === 0) {
    throw new ConfigurationError(`Entity "${key}" must declare fields before registration.`)
  }
  for (const mapKey of Object.keys(columnMap)) {
    if (mapKey === "") {
      throw new ConfigurationError(`Entity "${key}" declares an empty column map key.`)
    }
  }
  const declaredFields = Object.keys(entity.fields)
  const missingFields = declaredFields.filter((field) => !Object.prototype.hasOwnProperty.call(columnMap, field))
  if (missingFields.length > 0) {
    throw new ConfigurationError(`Entity "${key}" column map is missing fields: ${missingFields.join(", ")}.`)
  }
  const primaryKey = entity.primaryKey ?? ("id" as string)
  if (!declaredFields.includes(String(primaryKey))) {
    throw new ConfigurationError(`Entity "${key}" primary key "${String(primaryKey)}" is not a declared field.`)
  }
  if (entity.versionField !== undefined && !declaredFields.includes(String(entity.versionField))) {
    throw new ConfigurationError(`Entity "${key}" version field "${String(entity.versionField)}" is not a declared field.`)
  }
}

interface PgEntityRegistry {
  get(entityName: string, namespace?: string): EntityMapping | undefined
}

interface PgProviderArgs {
  db: PgDatabaseLike
  registry: PgEntityRegistry
  constraintMap?: Record<string, string>
  limits?: { maxPageSize?: number }
}

function validatePgConfiguredLimit(name: "maxPageSize", value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)) {
    throw new ConfigurationError(`PostgreSQL ${name} must be a finite positive integer`)
  }
  return value
}

export function createDrizzlePersistenceProvider(args: PgProviderArgs): InteractiveTransactionProvider {
  const maxPageSize = validatePgConfiguredLimit("maxPageSize", args.limits?.maxPageSize)
  const capabilities: PersistenceCapabilities = {
    interactiveTransactions: true,
    atomicBatch: false,
    returningInsert: true,
    readSessions: false,
    jsonQueries: true,
    // The supported application PG schema maps numeric columns to number mode.
     exactDecimal: false,
    persistentConnection: true,
    conditionalAbacUpdate: true,
    // TransactionOptions.timeoutMs is enforced with SET LOCAL statement_timeout.
    transactionTimeouts: true,
    maxPageSize: maxPageSize ?? 100,
    execution: Object.freeze({
      "transaction.interactive": { status: "proven", evidence: "framework-conformance/v1/pg-guarantees.json" },
      "transaction.atomicBatch": { status: "unsupported" },
      "locking.pessimistic": { status: "unsupported" },
      "bulk.versioned.atomic": { status: "unsupported" },
      "bulk.versioned.partial": { status: "unsupported" },
      "read.streaming": { status: "unsupported" },
      "read.boundedPagedScan": { status: "proven", evidence: "framework-conformance/q1/query-envelope-conformance.json" },
    }),
  }

  function createScopedProvider(txDb: PgDatabaseLike, inTransaction: boolean): InteractiveTransactionProvider {
    const session = createPgSession(txDb)
    function repository<T, TId = string>(entity: VersionedEntityDescriptor<T>): VersionedRepository<T, TId>
    function repository<T, TId = string>(entity: UnversionedEntityDescriptor<T>): UnversionedRepository<T, TId>
    function repository<T, TId = string>(entity: EntityDescriptor<T>): VersionedRepository<T, TId> | UnversionedRepository<T, TId> {
      const mapping = args.registry.get(entity.name, entity.namespace)
      if (!mapping) throw new ConfigurationError(`Entity "${entity.name}" is not registered in the Drizzle entity registry`)
      return createDrizzleRepository({
        db: session,
        table: mapping.table,
        entity,
        columnMap: mapping.columnMap,
        ...(capabilities.maxPageSize !== undefined ? { maxPageSize: capabilities.maxPageSize } : {}),
        ...(args.constraintMap !== undefined ? { constraintMap: args.constraintMap } : {}),
      }) as VersionedRepository<T, TId> | UnversionedRepository<T, TId>
    }
    const provider: InteractiveTransactionProvider = {
      dialect: "postgresql",
      capabilities: capabilities as PersistenceCapabilities & { interactiveTransactions: true },
      repository,

      async runInTransaction<TResult>(
        work: (scoped: InteractiveTransactionProvider) => Promise<TResult>,
        options?: TransactionOptions,
      ): Promise<TResult> {
        if (inTransaction) {
          throw new ConfigurationError("Nested PostgreSQL transactions are not supported by this adapter")
        }
         const transactionOptions: PgTransactionConfig = {}
         if (options?.isolationLevel !== undefined) transactionOptions.isolationLevel = options.isolationLevel
         if (options?.accessMode !== undefined) transactionOptions.accessMode = options.accessMode
        const timeoutMs = statementTimeoutMs(options?.timeoutMs)
        let callbackCompleted = false
        try {
          return await args.db.transaction(async (tx) => {
            // SET cannot take bind parameters; the value is a validated integer.
            if (timeoutMs !== undefined) await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${timeoutMs}`))
            const result = await work(createScopedProvider(tx, true))
            callbackCompleted = true
            return result
          }, transactionOptions)
        } catch (error) {
          throw classifyTransactionFailure(error, "postgresql", callbackCompleted)
        }
      },
    }
    sessionByProvider.set(provider, session)
    return provider
  }

  return createScopedProvider(args.db, false)
}
