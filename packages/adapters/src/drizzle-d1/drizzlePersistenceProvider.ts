import { and, eq, getTableName, sql, type AnyColumn } from "drizzle-orm"
import { sqliteTable, text, type AnySQLiteTable } from "drizzle-orm/sqlite-core"
import type { RunnableQuery } from "drizzle-orm/runnable-query"
import type { DrizzleD1Database } from "drizzle-orm/d1"
import { assertEntityVersionCanIncrement, type EntityVersion } from "@xonava/core/serialization"
import type { PersistenceCapabilities } from "@xonava/core/persistence"
import type { AtomicBatchPlan, AtomicBatchProvider, AtomicBatchResult, EntityDescriptor, PersistenceProvider, TenantScopedAtomicBatchCommandEncoder, TenantScopedWriteCommand, UnversionedEntityDescriptor, UnversionedRepository, VersionedEntityDescriptor, VersionedRepository } from "@xonava/core/persistence"
import type { AuditRecord, OutboxRecord } from "@xonava/core/events"
import type { DrizzleD1Adapter } from "./d1Session"
import type { DrizzleSessionLike } from "./drizzleRepository"
import { createDrizzleD1Adapter } from "./d1Session"
import { createDrizzleRepository } from "./drizzleRepository"
import type { DrizzleColumnMap } from "../drizzle-shared/predicateCompiler"
import { ConfigurationError, ConflictError, FrameworkCoreError, ImmutableFieldViolationError, TenantScopeViolationError } from "@xonava/core/domain"
import { assertOutboxScope } from "@xonava/core/events"
import { normalizeDrizzleError } from "../drizzle-shared/errors"
import { Predicate } from "@xonava/core/domain"
import { DrizzlePredicateCompiler, type PredicateCompilerOptions } from "../drizzle-shared/predicateCompiler"
import { CachePrefixLedger, resolveRegistration, type RegistrableEntity } from "../drizzle-shared/entityRegistration"

const SQLITE_PREDICATES: PredicateCompilerOptions = Object.freeze({ dialect: "sqlite" })
import { assertD1BatchLimits, estimateD1Statement } from "./d1BatchLimits"
import { d1CurrentEpochMilliseconds, getAffectedRows } from "./d1Utils"
import { assertOutboxFingerprintMatches, assertOutboxProtectedFields, fingerprintOutboxRecord, outboxProvenanceColumn } from "../drizzle-shared/outbox"
import { validateD1AtomicOutboxColumns } from "./d1OutboxSchema"
import { serializeInvalidations } from "../drizzle-shared/idempotency"

const sessionByProvider = new WeakMap<PersistenceProvider, DrizzleSessionLike>()

export const PLATFORM_IDEMPOTENCY_SCOPE = "__platform__"

/**
 * The assertion table is only safe when its documented BEFORE INSERT
 * ownership-fence trigger (or an equivalent aborting mechanism) is installed.
 * Schema modules attach this adapter-owned token to the table. A string or
 * caller-defined property is never accepted as proof.
 */
export const D1_IDEMPOTENCY_ASSERTION_CAPABILITY = Object.freeze({
  kind: "ownership-fence-trigger",
})
export type D1IdempotencyAssertionCapability = typeof D1_IDEMPOTENCY_ASSERTION_CAPABILITY

const sqliteMaster = sqliteTable("sqlite_master", {
  type: text("type"),
  name: text("name"),
  tblName: text("tbl_name"),
  sql: text("sql"),
})

function getD1IdempotencyAssertionCapability(table: AnySQLiteTable | undefined): D1IdempotencyAssertionCapability | undefined {
  const capability = (table as AnySQLiteTable & { idempotencyAssertionCapability?: unknown } | undefined)?.idempotencyAssertionCapability
  return capability === D1_IDEMPOTENCY_ASSERTION_CAPABILITY ? D1_IDEMPOTENCY_ASSERTION_CAPABILITY : undefined
}

function isD1IdempotencyOwnershipFenceTrigger(triggerSql: unknown, assertionTableName: string, idempotencyTableName: string): boolean {
  if (typeof triggerSql !== "string") return false
  const normalized = triggerSql.replace(/\s+/g, " ").trim().toLowerCase()
  return normalized.includes("before insert") &&
    (normalized.includes(`on \`${assertionTableName.toLowerCase()}\``) ||
      normalized.includes(`on "${assertionTableName.toLowerCase()}"`) ||
      normalized.includes(`on ${assertionTableName.toLowerCase()}`)) &&
    normalized.includes(idempotencyTableName.toLowerCase()) &&
    normalized.includes("new.scope") &&
    normalized.includes("new.key") &&
    normalized.includes("new.fingerprint") &&
    normalized.includes("new.token") &&
    normalized.includes("status = 'in-progress'") &&
    normalized.includes("raise(abort")
}

async function verifyD1IdempotencyOwnershipFence(
  adapter: DrizzleD1Adapter,
  assertionTable: AnySQLiteTable,
  idempotencyTable: AnySQLiteTable,
): Promise<void> {
  const tableName = (assertionTable as AnySQLiteTable & { name?: string }).name ?? getTableName(assertionTable)
  const idempotencyTableName = (idempotencyTable as AnySQLiteTable & { name?: string }).name ?? getTableName(idempotencyTable)
  const rows = await adapter.raw
    .select({ triggerSql: sqliteMaster.sql })
    .from(sqliteMaster)
    .where(and(
      eq(sqliteMaster.type, "trigger"),
      eq(sqliteMaster.tblName, tableName),
    ))
    .limit(100)
  const hasFence = rows.some((row) => isD1IdempotencyOwnershipFenceTrigger(
    (row as { triggerSql?: unknown }).triggerSql,
    tableName,
    idempotencyTableName,
  ))
  if (!hasFence) {
    throw new ConfigurationError(
      `D1 atomic idempotency requires an ownership-fence trigger on ${tableName}`,
    )
  }
}

export { fingerprintOutboxRecord }

export function getDrizzleSession(provider: PersistenceProvider): DrizzleSessionLike {
  const session = sessionByProvider.get(provider)
  if (!session) throw new ConfigurationError("No Drizzle session found for this persistence provider")
  return session
}

export interface EntityMapping {
  table: AnySQLiteTable
  columnMap: DrizzleColumnMap
  entity: EntityDescriptor<Record<string, unknown>>
}

export type AuditRecordMapper = (record: AuditRecord) => Record<string, unknown>

export class DrizzleEntityRegistry {
  private mappings = new Map<string, EntityMapping>()
  private cachePrefixes = new CachePrefixLedger()

  /**
   * Accepts a persistence descriptor or a compiled `defineEntity()` definition.
   * A compiled entity's resolved cache key prefix must be unique across the registry.
   */
  register<T>(input: RegistrableEntity<T>, table: AnySQLiteTable, columnMap: DrizzleColumnMap, namespace?: string): this {
    const { descriptor: entity, cachePrefix } = resolveRegistration(input)
    const key = namespace ? `${namespace}:${entity.name}` : entity.name
    validateEntityRegistration(entity, columnMap, key)
    if (this.mappings.has(key)) {
      throw new ConfigurationError(`Entity "${key}" is already registered in the Drizzle entity registry.`)
    }
    this.cachePrefixes.assertAvailable(cachePrefix)
    this.cachePrefixes.claim(cachePrefix)
    this.mappings.set(key, { table, columnMap, entity })
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

export interface DrizzlePersistenceProviderArgs {
  db: DrizzleD1Database<Record<string, never>> | DrizzleSessionLike | DrizzleD1Adapter
  registry: DrizzleEntityRegistry
  auditTable?: AnySQLiteTable
  outboxTable?: AnySQLiteTable
  /** Enables atomic idempotency commit receipts inside batches. */
  idempotencyTable?: AnySQLiteTable
  /**
   * Table used by the in-batch DB-enforced ownership assertion. A BEFORE INSERT
   * trigger on this table RAISEs when the exact reservation token is no longer
   * valid, which aborts the whole atomic batch.
   */
  idempotencyAssertionTable?: AnySQLiteTable
  /** Shared tag-generation table. When present, cache-generation items join D1 batches. */
  tagGenerationTable?: AnySQLiteTable
  /** Table with expected_affected_rows/actual_affected_rows CHECK constraint. */
  mutationAssertionTable?: AnySQLiteTable
  mapOutboxRecord?: (record: OutboxRecord) => Record<string, unknown>
  mapAuditRecord?: AuditRecordMapper
  limits?: { maxPageSize?: number; maxBindParams?: number; maxStatementBytes?: number; maxBatchItems?: number }
  constraintMap?: Record<string, string>
}

type D1ConfiguredLimit = "maxPageSize" | "maxBindParams" | "maxStatementBytes" | "maxBatchItems"

function validateD1ConfiguredLimit(name: D1ConfiguredLimit, value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)) {
    throw new ConfigurationError(`D1 ${name} must be a finite positive integer`)
  }
  return value
}

type EncodedD1Command = { readonly kind: "statement"; readonly statement: RunnableQuery<unknown, "sqlite">; readonly expectedAffectedRows?: number }
export type DrizzleD1Command = RunnableQuery<unknown, "sqlite"> | TenantScopedWriteCommand | EncodedD1Command

/**
 * A versioned update/delete that matches zero rows must abort the whole batch
 * (audit, outbox, cache-generation and idempotency items included), so an
 * expectedVersion on a versioned entity implies expectedAffectedRows = 1
 * unless the caller says otherwise.
 */
function effectiveExpectedAffectedRows(command: Extract<TenantScopedWriteCommand, { kind: "update" | "delete" }>, mapping: EntityMapping): { expectedAffectedRows?: number } {
  if (command.expectedAffectedRows !== undefined) return { expectedAffectedRows: command.expectedAffectedRows }
  return mapping.entity.versionField && command.expectedVersion !== undefined ? { expectedAffectedRows: 1 } : {}
}

function isEncodedD1Command(command: unknown): command is EncodedD1Command {
  return typeof command === "object" && command !== null && (command as { kind?: unknown }).kind === "statement"
}

function isTenantWriteCommand(command: DrizzleD1Command): command is TenantScopedWriteCommand {
  return typeof command === "object" && command !== null && "kind" in command &&
    (command.kind === "insert" || command.kind === "update" || command.kind === "delete")
}

function drizzleValues(command: TenantScopedWriteCommand, mapping: EntityMapping, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(values)) {
    const column = mapping.columnMap[field]
    if (!column) throw new ConfigurationError(`Entity "${command.entity}" does not map field "${field}"`)
    result[field] = value
  }
  return result
}

function assertProtectedUpdateFields(command: Extract<TenantScopedWriteCommand, { kind: "update" }>, mapping: EntityMapping): void {
  const protectedFields = new Set<string>([
    mapping.entity.primaryKey ?? "id",
    ...(mapping.entity.versionField ? [mapping.entity.versionField] : []),
    ...(mapping.entity.immutableFields ?? []),
  ])
  const tenantField = mapping.entity.tenantField
  if (tenantField) protectedFields.add(tenantField)
  const provided = Object.keys(command.values).filter((field) => protectedFields.has(field))
  if (provided.length === 0) return
  if (tenantField && provided.includes(tenantField)) {
    throw new TenantScopeViolationError(`Cannot mutate tenant field "${tenantField}" on entity "${command.entity}" through update operations.`)
  }
  throw new ImmutableFieldViolationError(`Cannot mutate protected fields on entity "${command.entity}": ${provided.join(", ")}`)
}

function encodeResourceVersion(version: EntityVersion): string {
  return JSON.stringify({ type: "number", value: version })
}

function createTenantCommandEncoder(
  adapter: DrizzleD1Adapter,
  registry: DrizzleEntityRegistry,
  tenantId: string,
): TenantScopedAtomicBatchCommandEncoder<DrizzleD1Command> {
  return {
    tenantId,
    encode(command) {
      if (!isTenantWriteCommand(command)) {
        throw new ConfigurationError("Tenant-scoped D1 batches reject opaque Drizzle queries")
      }
       const qualifiedCommand = command as TenantScopedWriteCommand & { namespace?: string }
       const mapping = registry.get(command.entity, qualifiedCommand.namespace)
      if (!mapping?.entity.tenantField) {
        throw new ConfigurationError(`Tenant-scoped command entity "${command.entity}" is not tenant-scoped`)
      }
      const tenantField = mapping.entity.tenantField
      if (command.kind === "insert") {
        const suppliedTenant = command.values[tenantField]
        if (suppliedTenant !== undefined && suppliedTenant !== tenantId) {
          throw new ConfigurationError(`Tenant-scoped insert for "${command.entity}" targets another tenant`)
        }
         const insertValues = mapping.entity.versionField
           ? { ...command.values, [mapping.entity.versionField]: 1 }
           : command.values
         return adapter.raw.insert(mapping.table).values(
          drizzleValues(command, mapping, { ...insertValues, [tenantField]: tenantId }),
        ) as DrizzleD1Command
      }
      const filter = Predicate.and(command.filter, Predicate.eq(tenantField, tenantId))
      if (command.kind === "update") {
        assertProtectedUpdateFields(command, mapping)
        const versionField = mapping.entity.versionField
        if (versionField && command.expectedVersion === undefined) {
          throw new ConfigurationError(`Atomic update for versioned entity "${command.entity}" requires expectedVersion`)
        }
        const expectedVersion = command.expectedVersion
        if (versionField) assertEntityVersionCanIncrement(expectedVersion)
        const versionColumn = versionField ? mapping.columnMap[versionField] : undefined
        const values = versionField ? { ...command.values, [versionField]: sql`${versionColumn!} + 1` } : command.values
        const versionedFilter = versionField
          ? Predicate.and(filter, Predicate.eq(versionField, expectedVersion!), Predicate.lt(versionField, Number.MAX_SAFE_INTEGER))
          : filter
        return {
          kind: "statement",
          ...effectiveExpectedAffectedRows(command, mapping),
          statement: adapter.raw.update(mapping.table)
            .set(drizzleValues(command, mapping, values))
            .where(new DrizzlePredicateCompiler(mapping.columnMap, SQLITE_PREDICATES).compileWhere(versionedFilter)) as RunnableQuery<unknown, "sqlite">
        }
      }
      if (mapping.entity.versionField && command.expectedVersion === undefined) {
        throw new ConfigurationError(`Atomic delete for versioned entity "${command.entity}" requires expectedVersion`)
      }
       const expectedVersion = command.expectedVersion
      const versionedFilter = mapping.entity.versionField
        ? Predicate.and(filter, Predicate.eq(mapping.entity.versionField, expectedVersion!))
        : filter
      return {
        kind: "statement",
        ...effectiveExpectedAffectedRows(command, mapping),
        statement: adapter.raw.delete(mapping.table)
          .where(new DrizzlePredicateCompiler(mapping.columnMap, SQLITE_PREDICATES).compileWhere(versionedFilter)) as RunnableQuery<unknown, "sqlite">
      }
    },
  }
}

function createUnscopedCommandEncoder(
  adapter: DrizzleD1Adapter,
  registry: DrizzleEntityRegistry,
): (command: TenantScopedWriteCommand) => DrizzleD1Command {
  return (command) => {
    const qualifiedCommand = command as TenantScopedWriteCommand & { namespace?: string }
    const mapping = registry.get(command.entity, qualifiedCommand.namespace)
    if (!mapping) throw new ConfigurationError(`Entity "${command.entity}" is not registered in the Drizzle entity registry`)
    if (mapping.entity.tenantField) {
      throw new ConfigurationError(`Global D1 command entity "${command.entity}" must not be tenant-scoped`)
    }
    if (command.kind === "insert") {
      const insertValues = mapping.entity.versionField
        ? { ...command.values, [mapping.entity.versionField]: 1 }
        : command.values
      return adapter.raw.insert(mapping.table).values(drizzleValues(command, mapping, insertValues)) as RunnableQuery<unknown, "sqlite">
    }
    if (command.kind === "update") {
      assertProtectedUpdateFields(command, mapping)
      const versionField = mapping.entity.versionField
      if (versionField && command.expectedVersion === undefined) {
        throw new ConfigurationError(`Atomic update for versioned entity "${command.entity}" requires expectedVersion`)
      }
      if (versionField) assertEntityVersionCanIncrement(command.expectedVersion)
      const versionColumn = versionField ? mapping.columnMap[versionField] : undefined
      const values = versionField ? { ...command.values, [versionField]: sql`${versionColumn!} + 1` } : command.values
       const filter = versionField
         ? Predicate.and(command.filter, Predicate.eq(versionField, command.expectedVersion!), Predicate.lt(versionField, Number.MAX_SAFE_INTEGER))
        : command.filter
      return {
        kind: "statement",
        ...effectiveExpectedAffectedRows(command, mapping),
        statement: adapter.raw.update(mapping.table)
          .set(drizzleValues(command, mapping, values))
          .where(new DrizzlePredicateCompiler(mapping.columnMap, SQLITE_PREDICATES).compileWhere(filter)) as RunnableQuery<unknown, "sqlite">
      }
    }
    if (mapping.entity.versionField && command.expectedVersion === undefined) {
      throw new ConfigurationError(`Atomic delete for versioned entity "${command.entity}" requires expectedVersion`)
    }
    const filter = mapping.entity.versionField
      ? Predicate.and(command.filter, Predicate.eq(mapping.entity.versionField, command.expectedVersion!))
      : command.filter
    return {
      kind: "statement",
      ...effectiveExpectedAffectedRows(command, mapping),
      statement: adapter.raw.delete(mapping.table)
        .where(new DrizzlePredicateCompiler(mapping.columnMap, SQLITE_PREDICATES).compileWhere(filter)) as RunnableQuery<unknown, "sqlite">
    }
  }
}

function resolveAdapter(db: DrizzlePersistenceProviderArgs["db"]): DrizzleD1Adapter | null {
  if ("raw" in db && "repository" in db) return db
  if ("batch" in db && typeof db.batch === "function") return createDrizzleD1Adapter(db)
  return null
}

export function mapAuditRecord(record: AuditRecord): Record<string, unknown> {
  return {
    id: record.id,
    createdAt: record.occurredAt,
    tenantId: record.tenantId,
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    actorId: record.actor.id,
    actorType: record.actor.kind,
    // Impersonation is authority provenance, never a Principal field.
    impersonatedByAdminId: null,
    oldValue: record.oldValue ? JSON.stringify(record.oldValue) : null,
    newValue: record.newValue ? JSON.stringify(record.newValue) : null,
    metadata: record.metadata ? JSON.stringify(record.metadata) : null,
  }
}

export function createDrizzlePersistenceProvider(args: DrizzlePersistenceProviderArgs): PersistenceProvider {
  const adapter = resolveAdapter(args.db)
  const auditMapper = args.mapAuditRecord ?? mapAuditRecord
  const repositoryDb: DrizzleSessionLike = adapter?.repository ?? (args.db as DrizzleSessionLike)
  const maxPageSize = validateD1ConfiguredLimit("maxPageSize", args.limits?.maxPageSize)
  const maxBindParams = validateD1ConfiguredLimit("maxBindParams", args.limits?.maxBindParams)
  const maxStatementBytes = validateD1ConfiguredLimit("maxStatementBytes", args.limits?.maxStatementBytes)
  const maxBatchItems = validateD1ConfiguredLimit("maxBatchItems", args.limits?.maxBatchItems)
  const idempotencyAssertionCapability = getD1IdempotencyAssertionCapability(args.idempotencyAssertionTable)
  const capabilities: PersistenceCapabilities = {
    interactiveTransactions: false,
    atomicBatch: adapter !== null,
    ...(adapter ? { atomicBatchScope: "unscoped" as const } : {}),
      ...(args.idempotencyTable && args.idempotencyAssertionTable && idempotencyAssertionCapability === D1_IDEMPOTENCY_ASSERTION_CAPABILITY
       ? { atomicBatchIdempotency: true as const }
       : {}),
    ...(args.tagGenerationTable ? { atomicBatchCacheGeneration: true as const } : {}),
    returningInsert: false,
    readSessions: false,
    jsonQueries: false,
    exactDecimal: false,
    persistentConnection: false,
    conditionalAbacUpdate: false,
    maxPageSize: maxPageSize ?? 100,
    maxBindParams: maxBindParams ?? 100,
    maxStatementBytes: maxStatementBytes ?? 100_000,
    maxBatchItems: maxBatchItems ?? 100,
    execution: Object.freeze({
      "transaction.interactive": { status: "unsupported" },
      "transaction.atomicBatch": adapter
        ? { status: "proven", evidence: "framework-conformance/release/d1-guarantees.json" }
        : { status: "unsupported" },
      "locking.pessimistic": { status: "unsupported" },
      "bulk.versioned.atomic": { status: "unsupported" },
      "bulk.versioned.partial": { status: "unsupported" },
      "read.streaming": { status: "unsupported" },
      "read.boundedPagedScan": { status: "proven", evidence: "framework-conformance/q1/query-envelope-conformance.json" },
    }),
  }

  function repository<T, TId = string>(entity: VersionedEntityDescriptor<T>): VersionedRepository<T, TId>
  function repository<T, TId = string>(entity: UnversionedEntityDescriptor<T>): UnversionedRepository<T, TId>
  function repository<T, TId = string>(entity: EntityDescriptor<T>): VersionedRepository<T, TId> | UnversionedRepository<T, TId> {
    const mapping = args.registry.get(entity.name, entity.namespace)
    if (!mapping) throw new ConfigurationError(`Entity "${entity.name}" is not registered in the Drizzle entity registry`)
    const repositoryArgs = {
      db: repositoryDb,
      table: mapping.table,
      entity,
      columnMap: mapping.columnMap,
      ...(capabilities.maxPageSize !== undefined ? { maxPageSize: capabilities.maxPageSize } : {}),
      ...(args.constraintMap !== undefined ? { constraintMap: args.constraintMap } : {}),
    }
    return createDrizzleRepository(repositoryArgs) as VersionedRepository<T, TId> | UnversionedRepository<T, TId>
  }

  interface D1RuntimeProvider extends PersistenceProvider {
    createTenantScopedCommandEncoder?: (tenantId: string) => TenantScopedAtomicBatchCommandEncoder<DrizzleD1Command>
    executeAtomicBatch?: (plan: AtomicBatchPlan<DrizzleD1Command>) => Promise<AtomicBatchResult>
  }
  const provider: D1RuntimeProvider = {
    dialect: "cloudflare-d1",
    capabilities,
    repository,
  }

  if (adapter) {
    let idempotencyFenceVerification: Promise<void> | undefined
    const verifyIdempotencyFence = (): Promise<void> => {
      if (!idempotencyFenceVerification) {
        if (!args.idempotencyAssertionTable) {
          return Promise.reject(new ConfigurationError("D1 atomic idempotency requires an idempotency assertion table"))
        }
        if (!args.idempotencyTable) {
          return Promise.reject(new ConfigurationError("D1 atomic idempotency requires an idempotency table"))
        }
        const verification = verifyD1IdempotencyOwnershipFence(adapter, args.idempotencyAssertionTable, args.idempotencyTable)
        idempotencyFenceVerification = verification
        // Only a successful verification is cached: a transient read failure
        // or a fence installed later must not poison every future batch.
        verification.catch(() => {
          if (idempotencyFenceVerification === verification) idempotencyFenceVerification = undefined
        })
      }
      return idempotencyFenceVerification
    }
    provider.createTenantScopedCommandEncoder = (tenantId) => createTenantCommandEncoder(adapter, args.registry, tenantId)
    provider.executeAtomicBatch = async (plan: AtomicBatchPlan<DrizzleD1Command>): Promise<AtomicBatchResult> => {
      const fingerprints = new Map<string, string>()
      const outboxFingerprints = new Map<OutboxRecord, string>()
      const verifiedIdempotentNoOps = new Set<OutboxRecord>()
      const existingOutboxKeys = new Set<string>()
      const hasOutbox = plan.items.some((item) => item.kind === "outbox")
      if (hasOutbox) {
        if (!args.outboxTable || !args.mapOutboxRecord) {
          throw new ConfigurationError("D1 atomic batches require outboxTable and mapOutboxRecord for outbox items")
        }
        validateD1AtomicOutboxColumns(args.outboxTable)
      }
      // D1 batches cannot conditionally insert and then inspect the conflicting
      // row. Resolve duplicates before constructing the batch so a replay or a
      // duplicate in one plan never reaches D1 as a second INSERT. A concurrent
      // writer can still win between this read and batch(); its unique
      // constraint aborts the entire batch, which preserves transaction safety.
      const checkedOutboxIdentities = new Set<string>()
      const outboxColumns = hasOutbox ? validateD1AtomicOutboxColumns(args.outboxTable!) : undefined
      for (const item of plan.items) {
        if (item.kind !== "outbox") continue
        assertOutboxScope(item.record)
        const scope = item.record.scopeId
        const key = `${scope}\u0000${item.record.idempotencyKey}`
        const fingerprint = await fingerprintOutboxRecord(item.record)
        outboxFingerprints.set(item.record, fingerprint)
        const previous = fingerprints.get(key)
        if (previous && previous !== fingerprint) {
          throw new ConflictError("Outbox idempotency key was reused for a different event")
        }
        fingerprints.set(key, fingerprint)
        if (checkedOutboxIdentities.has(key)) {
          verifiedIdempotentNoOps.add(item.record)
          continue
        }
        checkedOutboxIdentities.add(key)
        const existingRows = await adapter.raw
          .select({ eventFingerprint: outboxColumns!.eventFingerprint! } as never)
          .from(args.outboxTable!)
          .where(and(
            eq(outboxColumns!.idempotencyScope!, scope),
            eq(outboxColumns!.idempotencyKey!, item.record.idempotencyKey),
          ))
          .limit(1)
        const existing = existingRows[0] as { eventFingerprint?: unknown } | undefined
        if (existing) {
          await assertOutboxFingerprintMatches(existing.eventFingerprint, fingerprint, item.record)
          existingOutboxKeys.add(key)
          verifiedIdempotentNoOps.add(item.record)
        }
      }
      const hasCommand = plan.items.some((item) => item.kind === "command")
      const outboxItems = plan.items.filter((item): item is Extract<typeof item, { kind: "outbox" }> => item.kind === "outbox")
      if (hasCommand && existingOutboxKeys.size > 0) {
        // An outbox no-op is not proof that the business mutation committed. Do
        // not replay commands unless the same plan's durable receipt proves it.
        if (outboxItems.some((item) => !existingOutboxKeys.has(`${item.record.scopeId}\u0000${item.record.idempotencyKey}`))) {
          throw new ConflictError("Atomic batch replay has both existing and new outbox identities")
        }
        const commits = plan.items.filter((item): item is Extract<typeof item, { kind: "idempotency" }> => item.kind === "idempotency")
        const commit = commits[0]?.commit
        if (commits.length !== 1 || !commit || !args.idempotencyTable) {
          throw new ConflictError("Existing outbox identity requires a committed idempotency receipt before replay")
        }
        const columns = args.idempotencyTable as AnySQLiteTable & {
          scope?: AnyColumn
          key?: AnyColumn
          fingerprint?: AnyColumn
          status?: AnyColumn
        }
        if (!columns.scope || !columns.key || !columns.fingerprint || !columns.status) {
          throw new ConfigurationError("D1 idempotency replay requires scope, key, fingerprint, and status columns")
        }
        const receiptRows = await adapter.raw.select({
          fingerprint: columns.fingerprint,
          status: columns.status,
        } as never).from(args.idempotencyTable).where(and(
          eq(columns.scope, commit.scope),
          eq(columns.key, commit.key),
        )).limit(1)
        const receipt = receiptRows[0] as { fingerprint?: unknown; status?: unknown } | undefined
        if (!receipt) throw new ConflictError("Existing outbox identity has no committed idempotency receipt")
        if (receipt.fingerprint !== commit.fingerprint) throw new ConflictError("Idempotency key was reused for a different mutation")
        if (receipt.status !== "business-committed" && receipt.status !== "completed") {
          throw new ConflictError("Existing outbox identity does not have a committed idempotency receipt")
        }
        // The receipt is the durable replay result. Nothing in the plan may be
        // executed again, including audit, cache, and outbox writes.
         return plan.items.map((item) => ({ kind: item.kind, result: { replayed: true } }))
      }
       const statementEntries: { itemIndex: number; statement: RunnableQuery<unknown, "sqlite"> }[] = []
       let hasMutationAssertion = false
       for (const [itemIndex, item] of plan.items.entries()) {
         if (item.kind === "command") {
           const encoded = isTenantWriteCommand(item.command)
             ? createUnscopedCommandEncoder(adapter, args.registry)(item.command)
             : item.command
           statementEntries.push({
             itemIndex,
             statement: isEncodedD1Command(encoded) ? encoded.statement : encoded as RunnableQuery<unknown, "sqlite">,
           })
           if (isEncodedD1Command(encoded) && encoded.expectedAffectedRows !== undefined) {
             const mutationAssertionTable = args.mutationAssertionTable
             if (!mutationAssertionTable) throw new ConfigurationError("D1 conditional atomic mutations require mutationAssertionTable")
             statementEntries.push({ itemIndex, statement: createMutationAssertion(adapter, mutationAssertionTable, encoded.expectedAffectedRows) })
             hasMutationAssertion = true
           }
           continue
        }
         if (item.kind === "audit") {
          if (!args.auditTable) throw new ConfigurationError("D1 atomic batches require auditTable for audit items")
          // Audit newValue/oldValue are the deterministic pre-commit command
          // projection (requested MUTATION INTENT), not the DB-real committed
          // state. DB defaults, triggers, generated columns, and framework
          // version increments may differ from what is recorded here.
          statementEntries.push({
            itemIndex,
            statement: adapter.raw.insert(args.auditTable).values({
              ...auditMapper(item.record),
              id: item.record.id,
            }),
          })
           continue
         }
         if (item.kind === "cache-generation") {
           if (!args.tagGenerationTable) throw new ConfigurationError("D1 atomic batches require tagGenerationTable for cache-generation items")
           const table = args.tagGenerationTable as AnySQLiteTable & { tag?: AnyColumn; generation?: AnyColumn }
           if (!table.tag || !table.generation) throw new ConfigurationError("tagGenerationTable must expose tag and generation columns")
           statementEntries.push({
             itemIndex,
             statement: adapter.raw.insert(args.tagGenerationTable).values({ tag: item.tag, generation: 1 })
               .onConflictDoUpdate({ target: table.tag as never, set: { generation: sql`${table.generation} + 1` } }),
           })
           continue
           }
           if (item.kind === "idempotency") {
             if (!args.idempotencyTable || !args.idempotencyAssertionTable || idempotencyAssertionCapability !== D1_IDEMPOTENCY_ASSERTION_CAPABILITY) {
             throw new ConfigurationError(
                "D1 atomic batches require idempotencyTable, idempotencyAssertionTable, and the ownership-fence-trigger assertion capability for idempotency commit receipts",
              )
            }
            await verifyIdempotencyFence()
           const columns = args.idempotencyTable as AnySQLiteTable & {
            scope?: AnyColumn
            key?: AnyColumn
            fingerprint?: AnyColumn
            token?: AnyColumn
            status?: AnyColumn
            result?: AnyColumn
            resourceEntity?: AnyColumn
            resourceId?: AnyColumn
            pendingInvalidations?: AnyColumn
            completedAt?: AnyColumn
          }
          // DB-enforced ownership fence: the assertion insert fires a trigger
          // that RAISEs (aborting the whole batch) when the exact reservation
          // token is no longer in-progress. A zero-row conditional UPDATE could
          // not abort the batch, so this assertion is mandatory.
          const assertion = adapter.raw.insert(args.idempotencyAssertionTable).values({
            scope: item.commit.scope,
            key: item.commit.key,
            fingerprint: item.commit.fingerprint,
            token: item.commit.token,
          }) as unknown as RunnableQuery<unknown, "sqlite">
          // Durable commit receipt: proves the mutation committed and records
          // stable identity + obligations. It never stores a replayable result.
          const receipt = adapter.raw.update(args.idempotencyTable).set({
            status: "business-committed",
            result: null,
            resourceEntity: item.commit.resource?.entity ?? null,
            resourceId: item.commit.resource?.id ?? null,
            resourceVersion: item.commit.resource?.version == null ? null : encodeResourceVersion(item.commit.resource.version),
            pendingInvalidations: serializeInvalidations(item.commit.invalidations),
            completedAt: d1CurrentEpochMilliseconds(),
          }).where(and(
            eq(columns.scope!, item.commit.scope),
            eq(columns.key!, item.commit.key),
            eq(columns.fingerprint!, item.commit.fingerprint),
            eq(columns.token!, item.commit.token),
            eq(columns.status!, "in-progress"),
          )) as unknown as RunnableQuery<unknown, "sqlite">
          statementEntries.push({ itemIndex, statement: assertion }, { itemIndex, statement: receipt })
          continue
        }
         if (!args.outboxTable || !args.mapOutboxRecord) {
           throw new ConfigurationError("D1 atomic batches require outboxTable and mapOutboxRecord for outbox items")
         }
         const outboxColumns = validateD1AtomicOutboxColumns(args.outboxTable)
           const fingerprint = outboxFingerprints.get(item.record)
           if (!fingerprint) throw new ConfigurationError("D1 atomic batch could not fingerprint its outbox item")
          const scope = item.record.scopeId
          if (verifiedIdempotentNoOps.has(item.record)) {
          // Verified identical replay: emit a trivial SELECT so the batch still
          // returns a per-item result entry without re-inserting the event. The
          // no-table `SELECT 1` is constant-cost and never scans the outbox table.
          statementEntries.push({
             itemIndex,
              statement: adapter.raw.select({ noop: sql`1` }).from(args.outboxTable).where(sql`0`),
          })
          continue
        }
          const mapped = args.mapOutboxRecord(item.record)
         assertOutboxProtectedFields(mapped, {
           id: item.record.id,
           tenantId: item.record.tenantId,
           idempotencyScope: scope,
           idempotencyKey: item.record.idempotencyKey,
           eventFingerprint: fingerprint,
         })
         statementEntries.push({
           itemIndex,
           statement: adapter.raw.insert(args.outboxTable).values({
             ...mapped,
             id: item.record.id,
             ...(outboxColumns.tenantId ? { tenantId: item.record.tenantId } : {}),
             idempotencyScope: scope,
             idempotencyKey: item.record.idempotencyKey,
             eventFingerprint: fingerprint,
             ...outboxProvenanceColumn(outboxColumns, item.record),
           }),
         })
       }
      if (statementEntries.length === 0) return []
      const statements = statementEntries.map((entry) => entry.statement)
      const [firstStatement, ...remainingStatements] = statements
      if (!firstStatement) return []
      const batchStatements = remainingStatements.length > 0
        ? [firstStatement, ...remainingStatements] as const
        : [firstStatement] as const
       assertD1BatchLimits(batchStatements.map(estimateD1Statement), {
        maxBindParams: capabilities.maxBindParams ?? 100,
        maxStatementBytes: capabilities.maxStatementBytes ?? 100_000,
        maxBatchItems: capabilities.maxBatchItems ?? 100,
      })
      let results: readonly unknown[]
      try {
        results = await adapter.raw.batch(batchStatements)
      } catch (error) {
        throw normalizeD1BatchError(error, {
          hasIdempotencyFence: plan.items.some((item) => item.kind === "idempotency"),
          mutationAssertionColumns: hasMutationAssertion ? mutationAssertionColumnNames(args.mutationAssertionTable) : [],
        })
      }
      // Align batch results back to plan items (an idempotency item expands to
      // an assertion + a receipt statement).
      const perItemResults: import("@xonava/core/persistence").AtomicBatchItemResult[] = []
      let offset = 0
      for (const [itemIndex, item] of plan.items.entries()) {
        const count = statementEntries.filter((entry) => entry.itemIndex === itemIndex).length || 1
         const itemResults = results.slice(offset, offset + count)
         offset += count
         if (item.kind === "idempotency") {
           const receiptResult = itemResults[1]
           if (receiptResult === undefined || getAffectedRows(receiptResult) !== 1) {
             throw new ConfigurationError("D1 idempotency receipt update affected exactly one row")
           }
           perItemResults.push({ kind: "idempotency", result: { assertion: itemResults[0], receipt: itemResults[1] } })
        } else {
          const first = itemResults[0]
          if (first === undefined) throw new ConfigurationError("D1 atomic batch returned an unaddressable result.")
          perItemResults.push({ kind: item.kind, result: first })
        }
      }
      return perItemResults
    }
  }

  sessionByProvider.set(provider, repositoryDb)
  return provider
}

function providerMessages(error: unknown): string[] {
  const messages: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    const message = (current as { message?: unknown }).message
    if (typeof message === "string") messages.push(message)
    current = (current as { cause?: unknown }).cause
  }
  return messages
}

function mutationAssertionColumnNames(table: AnySQLiteTable | undefined): string[] {
  const columns = table as (AnySQLiteTable & { expectedAffectedRows?: AnyColumn; actualAffectedRows?: AnyColumn }) | undefined
  return [columns?.expectedAffectedRows?.name, columns?.actualAffectedRows?.name].filter((name): name is string => typeof name === "string" && name.length > 0)
}

/**
 * Maps a failed D1 batch to a framework error. Provider text (SQL, table and
 * column names) is only inspected for classification and never copied.
 * - The mutation-assertion CHECK (expected vs actual affected rows) means a
 *   conditional/versioned write matched an unexpected number of rows: a stale
 *   write, surfaced as ConflictError.
 * - The idempotency ownership fence aborts via RAISE(ABORT), which D1 reports
 *   as an unclassified SQLITE_CONSTRAINT failure: ownership was lost, surfaced
 *   as ConflictError (matching the PostgreSQL adapter).
 */
function normalizeD1BatchError(error: unknown, context: { hasIdempotencyFence: boolean; mutationAssertionColumns: readonly string[] }): FrameworkCoreError {
  if (error instanceof FrameworkCoreError) return error
  const messages = providerMessages(error)
  if (context.mutationAssertionColumns.length > 0 && messages.some((message) =>
    message.includes("CHECK constraint failed") && context.mutationAssertionColumns.some((column) => message.includes(column)))) {
    return new ConflictError("Optimistic concurrency conflict: a conditional write in the atomic batch affected an unexpected number of rows (stale write)", { dialect: "d1", reason: "mutation-assertion" })
  }
  const normalized = normalizeDrizzleError(error, "d1")
  if (context.hasIdempotencyFence && normalized.code === "PERSISTENCE_ERROR" && messages.some((message) => message.includes("SQLITE_CONSTRAINT"))) {
    return new ConflictError("Idempotency ownership was lost before the mutation committed", { dialect: "d1", reason: "idempotency-fence" })
  }
  return normalized
}

function createMutationAssertion(
  adapter: DrizzleD1Adapter,
  table: AnySQLiteTable,
  expectedAffectedRows: number,
): RunnableQuery<unknown, "sqlite"> {
  const columns = table as AnySQLiteTable & { expectedAffectedRows?: AnyColumn; actualAffectedRows?: AnyColumn }
  if (!columns.expectedAffectedRows || !columns.actualAffectedRows) {
    throw new ConfigurationError("mutationAssertionTable must expose expectedAffectedRows and actualAffectedRows columns")
  }
  return adapter.raw.insert(table).values({
    scope: "__mutation__",
    key: `mutation-${crypto.randomUUID()}`,
    fingerprint: "",
    token: "",
    expectedAffectedRows,
    actualAffectedRows: sql`changes()`,
  })
}
