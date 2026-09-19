import type { Principal } from "../domain/principal"
import type { ExecutionScope } from "../domain/executionScope"
import type { DynamicFactEvidence, AuthorizedExecutionPlan } from "../security/authorizedExecutionPlan"
import type { PersistenceProvider } from "../persistence/provider"
export interface PrincipalResolver<TInput = unknown> { resolvePrincipal(input: TInput): Promise<Principal> }
export interface EntitlementProvider { getEntitlements(principal: Principal, scope: ExecutionScope): Promise<ReadonlySet<string>> }
export interface RelationshipProvider { getRelationshipFacts(principal: Principal, scope: ExecutionScope, resource: { type: string; id: string }): Promise<readonly DynamicFactEvidence[]> }

/**
 * Rechecks relationship evidence that cannot be represented as a conditional
 * repository predicate. The framework calls this inside the mutation's active
 * transaction, immediately before its durable effects and commit.
 */
export interface AuthorizationFactRevalidator {
  revalidate(args: {
    readonly fact: DynamicFactEvidence
    readonly plan: AuthorizedExecutionPlan
    readonly persistence: PersistenceProvider
    readonly operationId: string
    readonly signal: AbortSignal
  }): Promise<boolean>
}
