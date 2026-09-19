import type { ScopeResolver } from "../security/scopeResolver.js"
import type { ExecutionScope } from "../domain/executionScope.js"
import type { CompiledRouteBinding, CompiledScopeResolutionPlan } from "./compiledRouteBinding.js"
import type { CompiledDurableFormatRegistry } from "../serialization/formatRegistry.js"
import type { GuaranteeId, GuaranteeStatus } from "../spec/guarantees.js"
import type { FrameworkDefinition, FrameworkDefinitionKind } from "./definition.js"

export interface GuaranteeCertificationV1 {
  readonly schema: "framework.guarantee-certification"; readonly schemaVersion: 1; readonly guarantee: GuaranteeId
  readonly adapter: { readonly packageName: string; readonly packageVersion: string; readonly adapterBuildId: string }; readonly status: GuaranteeStatus
  readonly evidence: null | { readonly suiteId: string; readonly suiteVersion: number; readonly artifactPath: string; readonly artifactSha256: string; readonly sourceRevision: string; readonly frameworkVersion: string; readonly executedAt: string; readonly environment: { readonly runtime: string; readonly runtimeVersion: string; readonly databaseEngine: string; readonly databaseVersion: string } }
  readonly topology: { readonly mode: string; readonly limits: Readonly<Record<string, string | number | boolean>>; readonly assumptions: readonly string[] }
  readonly failureBehavior: { readonly startupWhenRequired: "reject-configuration" | "not-applicable"; readonly runtimeIfTopologyChanges: "fail-closed" | "typed-capability-error" | "not-applicable" }
  readonly migration: { readonly state: "not-required" | "required-and-applied" | "required-not-applied"; readonly schemaVersion?: string; readonly migrationIds: readonly string[] }
}
export type { CompiledScopeResolutionPlan }
export interface CompiledRoutePlan extends CompiledRouteBinding {
  readonly key: string
}
export interface CompiledReadinessRequirement { readonly key: string; readonly description: string }
export interface CompiledPortBindingRequirement { readonly key: string; readonly capability: string; readonly optional: boolean }
export interface CompiledWorkerBinding { readonly key: string; readonly definitionKey: string; readonly kind: "consumer" | "job" | "schedule" | "workflow" }
export type CompiledDefinitionPlan<K extends FrameworkDefinitionKind = FrameworkDefinitionKind> = Readonly<Omit<FrameworkDefinition, "kind"> & { readonly kind: K; readonly definitionId: string; readonly dependencies: readonly string[] }>
export type CompiledEntityPlan = CompiledDefinitionPlan<"entity">
export type CompiledOperationPlan = CompiledDefinitionPlan<"operation">
export type CompiledReadModelPlan = CompiledDefinitionPlan<"readModel">
export type CompiledEventPlan = CompiledDefinitionPlan<"event">
export type CompiledConsumerPlan = CompiledDefinitionPlan<"consumer">
export type CompiledJobPlan = CompiledDefinitionPlan<"job">
export type CompiledSchedulePlan = CompiledDefinitionPlan<"schedule">
export type CompiledWorkflowPlan = CompiledDefinitionPlan<"workflow">
export type CompiledPolicyPlan = CompiledDefinitionPlan<"policy">
export type CompiledDelegationRule = CompiledDefinitionPlan<"delegationRule">
export interface CompiledDatasourceBinding extends CompiledDefinitionPlan { readonly adapter: string; readonly adapterBuildId?: string; readonly capabilities: readonly string[] }
export interface CompiledScopeResolverBinding { readonly key: string; readonly definitionVersion: number; readonly resolver: ScopeResolver; readonly allowedTargetKinds: readonly ExecutionScope["kind"][] }
export interface CompiledFrameworkPlan {
  readonly framework: { readonly frameworkVersion: string; readonly sourceRevision: string; readonly compiledAt: string }
  readonly definitions: { readonly entities: ReadonlyMap<string, CompiledEntityPlan>; readonly operations: ReadonlyMap<string, CompiledOperationPlan>; readonly readModels: ReadonlyMap<string, CompiledReadModelPlan>; readonly events: ReadonlyMap<string, CompiledEventPlan>; readonly consumers: ReadonlyMap<string, CompiledConsumerPlan>; readonly jobs: ReadonlyMap<string, CompiledJobPlan>; readonly schedules: ReadonlyMap<string, CompiledSchedulePlan>; readonly workflows: ReadonlyMap<string, CompiledWorkflowPlan> }
  readonly routes: ReadonlyMap<string, CompiledRoutePlan>; readonly datasources: ReadonlyMap<string, CompiledDatasourceBinding>
  readonly authority: { readonly delegationRules: ReadonlyMap<string, CompiledDelegationRule>; readonly scopeResolvers: ReadonlyMap<string, CompiledScopeResolverBinding> }
  readonly authorization: { readonly policies: ReadonlyMap<string, CompiledPolicyPlan>; readonly digests: ReadonlyMap<string, string> }
  readonly guarantees: { readonly certifications: ReadonlyMap<string, GuaranteeCertificationV1>; readonly requirementsByPlan: ReadonlyMap<string, readonly GuaranteeId[]> }
  readonly durableFormats: CompiledDurableFormatRegistry; readonly readiness: { readonly requirements: readonly CompiledReadinessRequirement[] }
  readonly runtimeBindings: { readonly requiredPorts: readonly CompiledPortBindingRequirement[]; readonly workerBindings: readonly CompiledWorkerBinding[]; readonly startupOrder: readonly string[] }
}
