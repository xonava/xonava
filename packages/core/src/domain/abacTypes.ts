import type { PredicateNode } from "./predicate"
import type { AbacPolicyEffect, ParsedPolicyPayload } from "./abacPolicySchema"
import type { AbacFieldDefinition } from "./abacCatalog"

export type AbacScopeType =
  | "tenant_default"
  | "platform_default"
  | "role"
  | "branch"
  | "department"
  | "user"

export interface AbacPolicySource {
  policyId: string
  scopeType: AbacScopeType
  scopeRefId?: string | null
  /**
   * Date windows are stored as ISO strings in normalized policies so that
   * Object.freeze can make them truly immutable (Date internal slots stay
   * mutable under freeze). Providers may supply Date instances; normalization
   * converts them to canonical ISO strings.
   */
  startsAt?: Date | string | null
  endsAt?: Date | string | null
}

export interface AbacPolicy {
  source: AbacPolicySource
  moduleKey: string
  effect: AbacPolicyEffect
  priority: number
  payload: ParsedPolicyPayload
}

export interface NormalizedAbacPolicy extends AbacPolicy {
  compiledConditions: PredicateNode
}

export interface AbacContext {
  userId?: string
  roleId?: string | null
  branchId?: string | null
  departmentId?: string | null
  tenantId?: string
  [key: string]: unknown
}

export interface AbacPolicyBundle {
  mode: "tenant" | "platform"
  moduleKey: string
  policies: NormalizedAbacPolicy[]
  context: AbacContext
  defaultEffect: "allow" | "deny"
  cacheScopeKey?: string
  fieldCatalog: Record<string, AbacFieldDefinition>
  /** IDs of valid policies that were excluded because they are inactive. */
  inactivePolicyIds?: string[]
  /** SHA-256 over every security-relevant bundle field except this digest. */
  securityDigest?: string
}

/** A bundle that was bound, frozen, and checked by the production factory. */
export type VerifiedAbacPolicyBundle = AbacPolicyBundle & {
  readonly __verifiedAbacBundle: unique symbol
  readonly defaultEffect: "deny"
  readonly securityDigest: string
}

export interface AbacReadScope {
  filter: PredicateNode
  cacheScopeKey?: string
}
