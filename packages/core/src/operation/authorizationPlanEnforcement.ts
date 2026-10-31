import { registerTenantScopedProvider } from "../persistence/tenantScopeBrand"
import { ConfigurationError, ConflictError, ForbiddenError, evaluatePredicate, executionScopesEqual } from "../domain"
import { evaluatePredicateTruth } from "../domain/evaluatePredicate"
import { Predicate, type PredicateNode } from "../domain/predicate"
import type { AuthorizationFactRevalidator } from "../security/authorizationFacts"
import { supportsInteractiveTransactions, isTenantScopedPersistenceProvider, type EntityDescriptor, type PersistenceProvider, type TransactionOptions } from "../persistence/provider"
import type { QueryOptions } from "../query"
import { canonicalJsonBytes, hmacSha256Hex } from "../serialization"
import { isAuthorizedExecutionPlan, type AuthorizationObligation, type AuthorizedExecutionPlan, type DynamicFactEvidence } from "../security"
import type { AuthorizationOperationContext } from "./operationContext"
import type { AuthorizationDecision, OperationAuthorizationPort, OperationKind } from "./operationDefinition"
import type { InternalOperationRunContext } from "./operationRunContext"

type AuthorizedDefinition<TInput> = {
  readonly key: string
  readonly kind: OperationKind
  readonly authorization?: OperationAuthorizationPort<TInput>
  readonly audit?: { readonly action: string; readonly required?: boolean }
}

/**
 * Executes an operation authorizer as a fail-closed boundary.  This is kept
 * separate from either pipeline so standard and atomic-batch operations cannot
 * drift into different authorization semantics.
 */
export async function authorizeOperation<TInput>(args: {
  readonly operation: AuthorizationOperationContext
  readonly definition: AuthorizedDefinition<TInput>
  readonly input: TInput
}): Promise<AuthorizedExecutionPlan | undefined> {
  const authorizer = args.definition.authorization
  if (authorizer === undefined) return undefined
  if (!authorizer || typeof authorizer.authorize !== "function") {
    throw new ConfigurationError(`Operation ${args.definition.key} authorization is invalid.`)
  }
  const decision = await authorizer.authorize({ operation: args.operation, input: args.input })
  const validated = validateAuthorizationDecision(decision, args.definition.key)
  if (validated.allowed !== true) {
    throw new ForbiddenError(validated.reason ?? `Operation is not allowed: ${args.definition.key}. Operation ${args.definition.key} is not allowed.`)
  }
  if (validated.plan === undefined) return undefined
  assertPlanMatchesOperation(validated.plan, args.definition, args.operation)
  return validated.plan
}

function validateAuthorizationDecision(value: unknown, operationKey: string): AuthorizationDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`Operation ${operationKey} authorization must return an explicit decision.`)
  }
  const allowed = Object.getOwnPropertyDescriptor(value, "allowed")
  if (!allowed || !("value" in allowed) || typeof allowed.value !== "boolean") {
    throw new ConfigurationError(`Operation ${operationKey} authorization decision.allowed must be boolean.`)
  }
  const reason = Object.getOwnPropertyDescriptor(value, "reason")
  if (reason && (!("value" in reason) || (reason.value !== undefined && typeof reason.value !== "string"))) {
    throw new ConfigurationError(`Operation ${operationKey} authorization decision.reason must be a string.`)
  }
  const plan = Object.getOwnPropertyDescriptor(value, "plan")
  if (plan && (!("value" in plan) || !isAuthorizedExecutionPlan(plan.value))) {
    throw new ConfigurationError(`Operation ${operationKey} authorization decision.plan must be a framework authorization plan.`)
  }
  if (allowed.value !== true && plan?.value !== undefined) {
    throw new ConfigurationError(`Operation ${operationKey} denied authorization cannot include an execution plan.`)
  }
  if (("plan" in value && !plan) || ("reason" in value && !reason)) {
    throw new ConfigurationError(`Operation ${operationKey} authorization decision must use own data properties.`)
  }
  return { allowed: allowed.value, ...(reason?.value !== undefined ? { reason: reason.value as string } : {}), ...(plan ? { plan: plan.value as AuthorizedExecutionPlan } : {}) }
}

function assertPlanMatchesOperation<TInput>(
  plan: AuthorizedExecutionPlan,
  definition: AuthorizedDefinition<TInput>,
  operation: AuthorizationOperationContext,
): void {
  if (plan.operationKind !== definition.kind) {
    throw new ConfigurationError(`Authorization plan kind does not match operation ${definition.key}.`)
  }
  const request = operation.request
  if (!request) throw new ConfigurationError(`Authorization plan for operation ${definition.key} requires a verified request context.`)
  if (!executionScopesEqual(plan.scope, request.scope) ||
    plan.identity.actor.id !== request.identity.actor.id || plan.identity.actor.kind !== request.identity.actor.kind ||
    plan.identity.subject.id !== request.identity.subject.id || plan.identity.subject.kind !== request.identity.subject.kind) {
    throw new ForbiddenError(`Authorization plan identity or scope does not match operation ${definition.key}.`)
  }
  for (const obligation of plan.obligations) assertObligationBeforeExecution(obligation, plan, definition, operation)
}

function assertObligationBeforeExecution<TInput>(
  obligation: AuthorizationObligation,
  plan: AuthorizedExecutionPlan,
  definition: AuthorizedDefinition<TInput>,
  operation: AuthorizationOperationContext,
): void {
  if (obligation.kind === "mask") return
  if (obligation.kind === "audit") {
    if (!definition.audit || definition.audit.required === false || definition.audit.action !== obligation.action) {
      throw new ConfigurationError(`Authorization plan audit obligation is not enforced by operation ${definition.key}.`)
    }
    return
  }
  const authentication = operation.request?.identity.actor.authentication
  if (!authentication || authentication.kind !== "authenticated") {
    throw new ForbiddenError(`Authorization plan step-up obligation is not satisfied for operation ${definition.key}.`)
  }
  if (obligation.requirement === "mfa") {
    if (authentication.assuranceLevel !== "mfa") {
      throw new ForbiddenError(`Authorization plan MFA obligation is not satisfied for operation ${definition.key}.`)
    }
    return
  }
  const maxAgeSeconds = obligation.maxAgeSeconds
  if (typeof maxAgeSeconds !== "number" || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) {
    throw new ConfigurationError("Recent-authentication obligations require a positive maxAgeSeconds.")
  }
  const authenticatedAt = Date.parse(authentication.authenticatedAt)
  const age = operation.services.clock.now().getTime() - authenticatedAt
  if (!Number.isFinite(authenticatedAt) || age < 0 || age > maxAgeSeconds * 1000) {
    throw new ForbiddenError(`Authorization plan recent-authentication obligation is not satisfied for operation ${definition.key}.`)
  }
  void plan
}

/**
 * Atomic-batch commands are opaque adapter values. They cannot be safely
 * rewritten with a predicate or checked for field permissions here, so reject
 * mutation plans rather than allowing a broader batch mutation to proceed.
 */
export function assertAtomicBatchPlanSupported(plan: AuthorizedExecutionPlan | undefined, operationKey: string): void {
  if (!plan || plan.operationKind !== "mutation") return
  throw new ConfigurationError(`Atomic-batch operation ${operationKey} cannot execute a mutation authorization plan without an adapter-bound command plan.`)
}

/** Restricts every repository reached through an authorized standard operation. */
export function createPlanConstrainedPersistenceProvider(
  provider: PersistenceProvider,
  plan: AuthorizedExecutionPlan,
): PersistenceProvider {
  const requiredPredicate = requiredResourcePredicate(plan)
  const constrained: PersistenceProvider = {
    dialect: provider.dialect,
    capabilities: provider.capabilities,
    ...(isTenantScopedPersistenceProvider(provider) ? { tenantId: provider.tenantId, scope: provider.scope } : {}),
    repository: <T, TId>(entity: EntityDescriptor<T>) => constrainRepository(provider.repository<T, TId>(entity as never), plan, requiredPredicate) as ReturnType<PersistenceProvider["repository"]>,
    ...(supportsInteractiveTransactions(provider) ? {
      runInTransaction: <TResult>(work: (scoped: PersistenceProvider) => Promise<TResult>, options?: TransactionOptions) =>
        provider.runInTransaction(scoped => work(createPlanConstrainedPersistenceProvider(scoped, plan)), options),
    } : {}),
  }
  if (isTenantScopedPersistenceProvider(provider)) registerTenantScopedProvider(constrained)
  return Object.freeze(constrained)
}

function requiredResourcePredicate(plan: AuthorizedExecutionPlan): PredicateNode | undefined {
  const predicates: PredicateNode[] = []
  if (plan.mandatoryResourcePredicate) predicates.push(plan.mandatoryResourcePredicate)
  if (plan.operationKind === "mutation") {
    for (const fact of plan.dynamicFacts) {
      if (fact.revalidation?.kind === "mutation-predicate") {
        predicates.push(Predicate.eq(fact.revalidation.field, fact.revalidation.expectedValue as never))
      }
    }
  }
  if (predicates.length === 0) return undefined
  return predicates.length === 1 ? predicates[0] : Predicate.and(...predicates)
}

function addRequiredPredicate(filter: PredicateNode | undefined, required: PredicateNode | undefined): PredicateNode | undefined {
  if (!required) return filter
  return filter ? Predicate.and(filter, required) : required
}

function permittedRecord(record: unknown, predicate: PredicateNode | undefined): boolean {
  return predicate === undefined || (typeof record === "object" && record !== null && evaluatePredicate(record as Record<string, unknown>, predicate))
}

function predicateFields(predicate: PredicateNode, out = new Set<string>()): Set<string> {
  if (predicate.kind === "condition") out.add(predicate.field)
  else if (predicate.kind === "not") predicateFields(predicate.filter, out)
  else if (predicate.kind === "and" || predicate.kind === "or") for (const child of predicate.filters) predicateFields(child, out)
  return out
}

/**
 * Defence-in-depth re-check of rows returned by a query whose filter already
 * included the required predicate. A row projected without a predicate field
 * cannot be re-evaluated in memory (the field would read as NULL), so it is
 * trusted to the pushed-down filter; any row that carries every field is
 * re-checked and dropped if it does not satisfy the predicate.
 */
function permittedQueriedRecord(record: unknown, predicate: PredicateNode | undefined, fields: ReadonlySet<string> | undefined): boolean {
  if (predicate === undefined || fields === undefined) return true
  if (typeof record !== "object" || record === null) return false
  for (const field of fields) if (!Object.prototype.hasOwnProperty.call(record, field)) return true
  return evaluatePredicate(record as Record<string, unknown>, predicate)
}

function assertWritableFields(data: unknown, plan: AuthorizedExecutionPlan): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigurationError("Authorized repository writes must use a data object.")
  }
  for (const field of Object.keys(data)) {
    if (!plan.writableFields.has(field)) throw new ForbiddenError(`Authorization plan does not permit writes to field "${field}".`)
  }
}

const UPDATE_FORBIDDEN = "Authorization plan resource predicate does not permit this update."

/**
 * Rewrites the mandatory predicate so it describes the row AFTER the update:
 * conditions on written fields are decided by the new values, and what
 * remains mentions only unwritten fields, whose post-image equals their
 * pre-image. Adding the result to the WHERE clause therefore guarantees the
 * updated row still satisfies the mandatory predicate, exactly, for any
 * AND/OR/NOT shape. A written value that makes a condition UNKNOWN (NULL
 * comparison) is rejected rather than approximated.
 */
function postImagePredicate(predicate: PredicateNode, data: Readonly<Record<string, unknown>>): PredicateNode {
  switch (predicate.kind) {
    case "literal": return predicate
    case "condition": {
      if (!Object.hasOwn(data, predicate.field)) return predicate
      const truth = evaluatePredicateTruth(data, predicate)
      if (truth === null) throw new ForbiddenError(UPDATE_FORBIDDEN)
      return Predicate.literal(truth)
    }
    case "not": {
      const inner = postImagePredicate(predicate.filter, data)
      return inner.kind === "literal" ? Predicate.literal(!inner.value) : Predicate.not(inner)
    }
    case "and":
    case "or": {
      const decisive = predicate.kind === "or"
      const remaining: PredicateNode[] = []
      for (const child of predicate.filters) {
        const next = postImagePredicate(child, data)
        if (next.kind === "literal") { if (next.value === decisive) return next; continue }
        remaining.push(next)
      }
      if (remaining.length === 0) return Predicate.literal(!decisive)
      return remaining.length === 1 ? remaining[0]! : predicate.kind === "and" ? Predicate.and(...remaining) : Predicate.or(...remaining)
    }
    default: throw new ForbiddenError(UPDATE_FORBIDDEN)
  }
}

/**
 * The fields an update actually writes. Adapters skip `undefined` values
 * (drizzle's `.set()` drops them), so such a key leaves the stored value in
 * place; treating it as a written NULL would let it decide mandatory
 * conditions (e.g. `isNull(f)`) that the post-image does not satisfy. Strip
 * them so the post-image rewrite and the adapter write see the same patch.
 */
function writtenData<T>(data: Partial<T>): Partial<T> {
  if (!Object.values(data as object).includes(undefined)) return data
  return Object.fromEntries(Object.entries(data as object).filter(([, value]) => value !== undefined)) as Partial<T>
}

/** The WHERE addition that keeps an updated row inside the mandatory predicate. */
function postImageFilter(data: unknown, mandatory: PredicateNode | undefined): PredicateNode | undefined {
  if (!mandatory) return undefined
  const residual = postImagePredicate(mandatory, data as Readonly<Record<string, unknown>>)
  if (residual.kind === "literal") {
    if (!residual.value) throw new ForbiddenError(UPDATE_FORBIDDEN)
    return undefined
  }
  return residual
}

function assertDirectMutationIsSafe(required: PredicateNode | undefined): void {
  if (required) {
    throw new ConfigurationError("A predicate-bearing authorization plan requires a conditional where mutation; direct id mutation is not authorized.")
  }
}

function constrainRepository<T, TId>(repository: ReturnType<PersistenceProvider["repository"]>, plan: AuthorizedExecutionPlan, required: PredicateNode | undefined) {
  const requiredFields = required === undefined ? undefined : predicateFields(required)
  // Dynamic-fact equalities guard the pre-image only (compare-and-set); the
  // post-image must satisfy the mandatory resource predicate.
  const mandatory = plan.mandatoryResourcePredicate ?? undefined
  const findOneWhere = async (filter: PredicateNode): Promise<T | null> => {
    const row = await (repository as { findOneWhere(filter: PredicateNode): Promise<T | null> }).findOneWhere(addRequiredPredicate(filter, required)!)
    return permittedRecord(row, required) ? row : null
  }
  const read = {
    findById: async (id: TId): Promise<T | null> => {
      const row = await (repository as { findById(id: TId): Promise<T | null> }).findById(id)
      return permittedRecord(row, required) ? row : null
    },
    ...(typeof (repository as { findOneWhere?: unknown }).findOneWhere === "function" ? { findOneWhere } : {}),
    ...(typeof (repository as { countUpTo?: unknown }).countUpTo === "function"
      ? { countUpTo: (filter: PredicateNode | undefined, limit: number) => (repository as { countUpTo(filter: PredicateNode | undefined, limit: number): Promise<number> }).countUpTo(addRequiredPredicate(filter, required), limit) }
      : {}),
    findMany: async (options?: QueryOptions) => {
      const filter = addRequiredPredicate(options?.filter, required)
      const constrainedOptions: QueryOptions | undefined = filter === undefined
        ? options
        : { ...(options ?? {}), filter }
      const result = await (repository as { findMany(options?: QueryOptions): Promise<{ rows: T[]; rowCount?: number; page: number; pageSize: number; pageInfo?: unknown }> }).findMany(constrainedOptions)
      const rows = result.rows.filter((row) => permittedQueriedRecord(row, required, requiredFields))
      return Object.freeze({ ...result, rows: Object.freeze(rows), ...(result.rowCount === undefined ? {} : { rowCount: rows.length }) })
    },
  }
  if (plan.operationKind === "read") return Object.freeze(read)

  const mutation = repository as {
    insert(data: Partial<T>): Promise<T>
    bulkInsert?: (data: Partial<T>[]) => Promise<T[]>
    update(id: TId, data: Partial<T>, options?: unknown): Promise<T>
    updateOneWhere?: (filter: PredicateNode, data: Partial<T>, options?: unknown) => Promise<{ updatedCount: number }>
    updateOneWhereReturning?: (filter: PredicateNode, data: Partial<T>, options?: unknown) => Promise<T | null>
    updateManyWhere?: (filter: PredicateNode, data: Partial<T>, options?: unknown) => Promise<number>
    delete(id: TId, options?: unknown): Promise<void>
    deleteWhere?: (filter: PredicateNode, options?: unknown) => Promise<{ deletedCount: number }>
  }
  return Object.freeze({
    ...read,
    insert: async (data: Partial<T>) => {
      assertWritableFields(data, plan)
      if (!permittedRecord(data, required)) throw new ForbiddenError("Authorization plan resource predicate does not permit this insert.")
      const row = await mutation.insert(data)
      if (!permittedRecord(row, required)) throw new ConflictError("Inserted record no longer satisfies the authorization predicate.")
      return row
    },
    ...(mutation.bulkInsert ? {
      bulkInsert: async (data: Partial<T>[]) => {
        data.forEach((entry) => { assertWritableFields(entry, plan); if (!permittedRecord(entry, required)) throw new ForbiddenError("Authorization plan resource predicate does not permit this insert.") })
        const rows = await mutation.bulkInsert!(data)
        if (rows.some((row) => !permittedRecord(row, required))) throw new ConflictError("Inserted record no longer satisfies the authorization predicate.")
        return rows
      },
    } : {}),
    update: async (id: TId, data: Partial<T>, options?: unknown) => {
      assertWritableFields(data, plan)
      assertDirectMutationIsSafe(required)
      return mutation.update(id, data, options)
    },
    ...(mutation.updateOneWhere ? {
      updateOneWhere: async (filter: PredicateNode, data: Partial<T>, options?: unknown) => {
        assertWritableFields(data, plan)
        const written = writtenData(data)
        return mutation.updateOneWhere!(addRequiredPredicate(addRequiredPredicate(filter, required), postImageFilter(written, mandatory))!, written, options)
      },
    } : {}),
    ...(mutation.updateOneWhereReturning ? {
      updateOneWhereReturning: async (filter: PredicateNode, data: Partial<T>, options?: unknown) => {
        assertWritableFields(data, plan)
        const written = writtenData(data)
        const row = await mutation.updateOneWhereReturning!(addRequiredPredicate(addRequiredPredicate(filter, required), postImageFilter(written, mandatory))!, written, options)
        return permittedRecord(row, mandatory) ? row : null
      },
    } : {}),
    ...(mutation.updateManyWhere ? {
      updateManyWhere: async (filter: PredicateNode, data: Partial<T>, options?: unknown) => {
        assertWritableFields(data, plan)
        const written = writtenData(data)
        return mutation.updateManyWhere!(addRequiredPredicate(addRequiredPredicate(filter, required), postImageFilter(written, mandatory))!, written, options)
      },
    } : {}),
    delete: (id: TId, options?: unknown) => {
      assertDirectMutationIsSafe(required)
      return mutation.delete(id, options)
    },
    ...(mutation.deleteWhere ? {
      deleteWhere: (filter: PredicateNode, options?: unknown) => mutation.deleteWhere!(addRequiredPredicate(filter, required)!, options),
    } : {}),
  })
}

/** Rechecks non-predicate mutable evidence at the transaction commit boundary. */
export async function revalidateAuthorizationFacts(args: {
  readonly plan: AuthorizedExecutionPlan | undefined
  readonly operation: InternalOperationRunContext
  readonly revalidator?: AuthorizationFactRevalidator
}): Promise<void> {
  const plan = args.plan
  if (!plan || plan.operationKind !== "mutation") return
  const facts = plan.dynamicFacts.filter((fact) => fact.revalidation?.kind !== "mutation-predicate")
  if (!facts.length) return
  if (!args.revalidator) throw new ConfigurationError("Authorization plan requires a dynamic-fact revalidator.")
  for (const fact of facts) {
    const valid = await args.revalidator.revalidate({
      fact,
      plan,
      persistence: args.operation.persistence,
      operationId: args.operation.operationId,
      signal: args.operation.signal,
    })
    if (valid !== true) throw new ConflictError(`Authorization fact "${fact.factKey}" changed before mutation commit.`)
  }
}

export interface MaskingOptions {
  /**
   * Secret key for `hash` masking (at least 16 bytes). Keyed hashing keeps
   * masked values joinable without being reversible by dictionary attack;
   * without a key, `hash` masks fail closed to "[REDACTED]".
   */
  readonly maskingKey?: Uint8Array
}

export const MIN_MASKING_KEY_BYTES = 16
const PAGED_ENVELOPE_KEYS = ["page", "pageSize", "pageInfo"] as const
const MASK_DOMAIN = new TextEncoder().encode("framework.authorization-mask:v2\u0000")

/** Applies field visibility and masking at the final representation boundary. */
export function applyAuthorizationPlanToResult<TResult>(plan: AuthorizedExecutionPlan | undefined, result: TResult, options: MaskingOptions = {}): TResult {
  if (!plan) return result
  const key = options.maskingKey
  if (key !== undefined && (!(key instanceof Uint8Array) || key.byteLength < MIN_MASKING_KEY_BYTES)) throw new ConfigurationError(`Masking key must be at least ${MIN_MASKING_KEY_BYTES} bytes`)
  const masks = new Map<string, Extract<AuthorizationObligation, { kind: "mask" }>["strategy"]>()
  for (const obligation of plan.obligations) if (obligation.kind === "mask" && !masks.has(obligation.field)) masks.set(obligation.field, obligation.strategy)
  const projectRecord = (value: unknown): unknown => {
    if (Array.isArray(value)) return Object.freeze(value.map(projectRecord))
    if (!value || typeof value !== "object" || value instanceof Date) return value
    const projected: Record<string, unknown> = Object.create(null)
    for (const field of plan.readableFields) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue
      const raw = (value as Record<string, unknown>)[field]
      const strategy = masks.get(field)
      projected[field] = strategy ? maskValue(raw, strategy, field, key) : raw
    }
    return Object.freeze(projected)
  }
  if (Array.isArray(result)) return projectRecord(result) as TResult
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    // Only the ListResult envelope survives; any other key could carry
    // unprojected row data (aggregates, debug payloads, summaries).
    const value = result as unknown as Record<string, unknown> & { rows: unknown[] }
    const envelope: Record<string, unknown> = {}
    for (const key of PAGED_ENVELOPE_KEYS) if (Object.prototype.hasOwnProperty.call(value, key)) envelope[key] = value[key]
    return Object.freeze({ ...envelope, rows: projectRecord(value.rows), ...(Object.prototype.hasOwnProperty.call(value, "rowCount") && value.rowCount !== undefined ? { rowCount: value.rows.length } : {}) }) as TResult
  }
  return projectRecord(result) as TResult
}

export const MIN_PARTIAL_MASK_LENGTH = 8

function maskValue(value: unknown, strategy: Extract<AuthorizationObligation, { kind: "mask" }>["strategy"], field: string, key: Uint8Array | undefined): unknown {
  if (value === null || value === undefined) return value
  if (strategy === "redact") return "[REDACTED]"
  if (strategy === "partial") {
    // Reveal at most the last four characters, and only of long values, so a
    // partial mask never discloses most of a short identifier.
    if (typeof value !== "string") return "[REDACTED]"
    const characters = Array.from(value)
    if (characters.length < MIN_PARTIAL_MASK_LENGTH) return "[REDACTED]"
    return `****${characters.slice(-4).join("")}`
  }
  if (!key) return "[REDACTED]"
  const material = canonicalJsonBytes({ field, value })
  const message = new Uint8Array(MASK_DOMAIN.byteLength + material.byteLength)
  message.set(MASK_DOMAIN, 0)
  message.set(material, MASK_DOMAIN.byteLength)
  return `hmac-sha256:${hmacSha256Hex(key, message)}`
}
