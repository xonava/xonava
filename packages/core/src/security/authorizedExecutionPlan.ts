import { ConfigurationError, assertPrincipal, isRfc3339UtcInstant, validateExecutionScope } from "../domain"
import type { ExecutionIdentity } from "../domain/principal"
import type { ExecutionScope } from "../domain/executionScope"
import type { PredicateNode } from "../domain/predicate"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"

// Plans carry execution authority. A structural TypeScript cast must not be
// sufficient to make an arbitrary object look like one at an execution
// boundary, so only this module can register the issued object identity.
const authorizedExecutionPlans = new WeakSet<object>()

export type DynamicFactRevalidation =
  | { readonly kind: "mutation-predicate"; readonly field: string; readonly expectedValue: unknown }
  | { readonly kind: "transaction-check"; readonly checkKey: string }
  | { readonly kind: "lease-grant-check"; readonly grantId: string; readonly version: string }
export interface DynamicFactEvidence { readonly factKey: string; readonly version: string; readonly observedAt: string; readonly revalidation?: DynamicFactRevalidation }
export type AuthorizationObligation =
  | { readonly kind: "audit"; readonly action: string }
  | { readonly kind: "step-up"; readonly requirement: "mfa" | "recent-authentication"; readonly maxAgeSeconds?: number }
  | { readonly kind: "mask"; readonly field: string; readonly strategy: "redact" | "partial" | "hash" }
export interface AuthorizedExecutionPlan {
  readonly identity: ExecutionIdentity; readonly scope: ExecutionScope; readonly action: string; readonly operationKind: "read" | "mutation"
  readonly mandatoryResourcePredicate?: PredicateNode; readonly readableFields: ReadonlySet<string>; readonly writableFields: ReadonlySet<string>
  readonly obligations: readonly AuthorizationObligation[]; readonly dynamicFacts: readonly DynamicFactEvidence[]
  readonly policy: { readonly key: string; readonly version: number; readonly digest: string }
}

/** True only for an immutable plan created by `createAuthorizedExecutionPlan`. */
export function isAuthorizedExecutionPlan(value: unknown): value is AuthorizedExecutionPlan {
  return typeof value === "object" && value !== null &&
    authorizedExecutionPlans.has(value) &&
    Object.isFrozen(value)
}

function immutableSet<T>(values: ReadonlySet<T>): ReadonlySet<T> {
  const snapshot = Object.freeze(Array.from(values))
  const result: ReadonlySet<T> = {
    get size() { return snapshot.length },
    has: (value) => snapshot.includes(value),
    forEach: (callbackfn) => { snapshot.forEach((value) => callbackfn(value, value, result)) },
    keys: () => snapshot[Symbol.iterator]() as unknown as SetIterator<T>,
    values: () => snapshot[Symbol.iterator]() as unknown as SetIterator<T>,
    entries: () => (function* (): Generator<[T, T], undefined, unknown> { for (const value of snapshot) yield [value, value] as [T, T]; return undefined })() as unknown as SetIterator<[T, T]>,
    [Symbol.iterator]: () => (function* (): Generator<T, undefined, unknown> { yield* snapshot; return undefined })() as unknown as SetIterator<T>,
  }
  return Object.freeze(result)
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

const MAX_AUTHORIZATION_SNAPSHOT_DEPTH = 64
const MAX_AUTHORIZATION_SNAPSHOT_NODES = 10_000
const DATE_MUTATORS = [
  "setDate", "setFullYear", "setHours", "setMilliseconds", "setMinutes", "setMonth", "setSeconds", "setTime",
  "setUTCDate", "setUTCFullYear", "setUTCHours", "setUTCMilliseconds", "setUTCMinutes", "setUTCMonth", "setUTCSeconds",
] as const

/**
 * Authorization material can legitimately contain Date predicate values. A
 * plain Object.freeze(Date) is not immutable: Date setters still update its
 * internal slot. Snapshot dates and reject other non-data values so policy
 * decisions cannot change after the plan has been issued.
 */
function snapshotAuthorizationValue(value: unknown): unknown {
  const ancestors = new WeakSet<object>()
  let nodes = 0

  const snapshot = (current: unknown, depth: number): unknown => {
    if (depth > MAX_AUTHORIZATION_SNAPSHOT_DEPTH || ++nodes > MAX_AUTHORIZATION_SNAPSHOT_NODES) {
      throw new ConfigurationError("Authorization plan exceeds snapshot limits")
    }
    if (current === null || typeof current === "string" || typeof current === "number" || typeof current === "boolean" || current === undefined) {
      return current
    }
    if (current instanceof Date) {
      if (!Number.isFinite(current.getTime())) throw new ConfigurationError("Authorization plan cannot contain an invalid Date")
      const copy = new Date(current.getTime())
      for (const mutator of DATE_MUTATORS) {
        Object.defineProperty(copy, mutator, {
          value: () => { throw new TypeError("Authorization plan Date values are immutable") },
          configurable: false,
          enumerable: false,
          writable: false,
        })
      }
      return Object.freeze(copy)
    }
    if (!current || typeof current !== "object" || ancestors.has(current)) {
      throw new ConfigurationError("Authorization plan must contain acyclic data values")
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(current)) {
      throw new ConfigurationError("Authorization plan must contain only data values")
    }
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const result = current.map((_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (!descriptor || !("value" in descriptor)) throw new ConfigurationError("Authorization plan cannot contain accessors")
          return snapshot(descriptor.value, depth + 1)
        })
        return Object.freeze(result)
      }
      const result: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(current)) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (!descriptor || !("value" in descriptor)) throw new ConfigurationError("Authorization plan cannot contain accessors")
        result[key] = snapshot(descriptor.value, depth + 1)
      }
      return Object.freeze(result)
    } finally {
      ancestors.delete(current)
    }
  }

  return snapshot(value, 0)
}

export function createAuthorizedExecutionPlan(plan: AuthorizedExecutionPlan): AuthorizedExecutionPlan {
  if (!plan || typeof plan !== "object") throw new ConfigurationError("Authorization plan must be an object")
  if (typeof plan.action !== "string" || plan.action.trim().length === 0) throw new ConfigurationError("Authorization plan action must be non-empty")
  if (plan.operationKind !== "read" && plan.operationKind !== "mutation") throw new ConfigurationError("Authorization plan operation kind is invalid")
  assertPrincipal(plan.identity?.actor)
  assertPrincipal(plan.identity?.subject)
  validateExecutionScope(plan.scope)
  if (!isReadonlySet(plan.readableFields) || !isReadonlySet(plan.writableFields)) throw new ConfigurationError("Authorization plan field permissions must be sets")
  if ([...plan.readableFields, ...plan.writableFields].some((field) => typeof field !== "string" || field.trim().length === 0)) {
    throw new ConfigurationError("Authorization plan field permissions must contain non-empty strings")
  }
  if (!Array.isArray(plan.obligations) || !Array.isArray(plan.dynamicFacts)) throw new ConfigurationError("Authorization plan obligations and facts must be arrays")
  if (!plan.policy || typeof plan.policy.key !== "string" || plan.policy.key.trim().length === 0 ||
    !Number.isSafeInteger(plan.policy.version) || plan.policy.version < 1 ||
    typeof plan.policy.digest !== "string" || plan.policy.digest.trim().length === 0) {
    throw new ConfigurationError("Authorization plan policy evidence is invalid")
  }
  for (const obligation of plan.obligations) assertAuthorizationObligation(obligation)
  for (const fact of plan.dynamicFacts) assertDynamicFactEvidence(fact, plan.operationKind)
  const snapshot = cloneAndFreezeDefinition(plan)
  if (plan.operationKind === "mutation") { const unsafe = plan.dynamicFacts.find(fact => !fact.revalidation); if (unsafe) throw new ConfigurationError(`Mutable authorization fact "${unsafe.factKey}" has no mutation revalidation strategy`) }
  const result = {
    ...snapshot,
    identity: deepFreeze({ ...snapshot.identity }),
    scope: deepFreeze({ ...snapshot.scope }),
    ...(snapshot.mandatoryResourcePredicate ? { mandatoryResourcePredicate: snapshotAuthorizationValue(snapshot.mandatoryResourcePredicate) as PredicateNode } : {}),
    readableFields: immutableSet(snapshot.readableFields),
    writableFields: immutableSet(snapshot.writableFields),
    obligations: deepFreeze(snapshot.obligations.map((item) => ({ ...item }))),
    dynamicFacts: snapshotAuthorizationValue(snapshot.dynamicFacts) as readonly DynamicFactEvidence[],
    policy: deepFreeze({ ...snapshot.policy }),
  }
  authorizedExecutionPlans.add(result)
  return deepFreeze(result)
}

function isReadonlySet(value: unknown): value is ReadonlySet<unknown> {
  return typeof value === "object" && value !== null &&
    typeof (value as { has?: unknown }).has === "function" &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
}

function assertAuthorizationObligation(obligation: AuthorizationObligation): void {
  if (!obligation || typeof obligation !== "object") throw new ConfigurationError("Authorization plan obligation is invalid")
  if (obligation.kind === "audit") {
    if (typeof obligation.action !== "string" || obligation.action.trim().length === 0) throw new ConfigurationError("Authorization plan audit obligation action must be non-empty")
    return
  }
  if (obligation.kind === "step-up") {
    if (obligation.requirement !== "mfa" && obligation.requirement !== "recent-authentication") throw new ConfigurationError("Authorization plan step-up requirement is invalid")
    if (obligation.maxAgeSeconds !== undefined && (!Number.isSafeInteger(obligation.maxAgeSeconds) || obligation.maxAgeSeconds < 1)) {
      throw new ConfigurationError("Authorization plan step-up maxAgeSeconds must be a positive safe integer")
    }
    return
  }
  if (obligation.kind !== "mask" || typeof obligation.field !== "string" || obligation.field.trim().length === 0 ||
    !["redact", "partial", "hash"].includes(obligation.strategy)) {
    throw new ConfigurationError("Authorization plan mask obligation is invalid")
  }
}

function assertDynamicFactEvidence(fact: DynamicFactEvidence, operationKind: AuthorizedExecutionPlan["operationKind"]): void {
  if (!fact || typeof fact !== "object" || typeof fact.factKey !== "string" || fact.factKey.trim().length === 0 ||
    typeof fact.version !== "string" || fact.version.trim().length === 0 || !isRfc3339UtcInstant(fact.observedAt)) {
    throw new ConfigurationError("Authorization plan dynamic fact evidence is invalid")
  }
  const revalidation = fact.revalidation
  if (operationKind === "mutation" && !revalidation) throw new ConfigurationError(`Mutable authorization fact "${fact.factKey}" has no mutation revalidation strategy`)
  if (!revalidation) return
  if (revalidation.kind === "mutation-predicate") {
    if (typeof revalidation.field !== "string" || revalidation.field.trim().length === 0) throw new ConfigurationError("Authorization plan mutation predicate field must be non-empty")
    return
  }
  if (revalidation.kind === "transaction-check") {
    if (typeof revalidation.checkKey !== "string" || revalidation.checkKey.trim().length === 0) throw new ConfigurationError("Authorization plan transaction check key must be non-empty")
    return
  }
  if (revalidation.kind !== "lease-grant-check" || typeof revalidation.grantId !== "string" || revalidation.grantId.trim().length === 0 ||
    typeof revalidation.version !== "string" || revalidation.version.trim().length === 0) {
    throw new ConfigurationError("Authorization plan lease grant check is invalid")
  }
}
export interface AuthorizationDecisionTrace { readonly action: string; readonly scopeKind: ExecutionScope["kind"]; readonly policyKey: string; readonly policyVersion: number; readonly predicateApplied: boolean; readonly readableFieldCount: number; readonly writableFieldCount: number; readonly obligationKinds: readonly AuthorizationObligation["kind"][]; readonly dynamicFactKeys: readonly string[] }
/** Trusted admin/testing diagnostic projection; never an HTTP response shape. */
export function createPrivilegedAuthorizationTrace(plan: AuthorizedExecutionPlan): AuthorizationDecisionTrace {
  return Object.freeze({ action: plan.action, scopeKind: plan.scope.kind, policyKey: plan.policy.key, policyVersion: plan.policy.version, predicateApplied: plan.mandatoryResourcePredicate !== undefined, readableFieldCount: plan.readableFields.size, writableFieldCount: plan.writableFields.size, obligationKinds: Object.freeze(plan.obligations.map(item => item.kind)), dynamicFactKeys: Object.freeze(plan.dynamicFacts.map(item => item.factKey)) })
}
