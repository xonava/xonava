import type { ExecutionScope } from "../domain/executionScope.js"
import type { RouteExposure } from "../domain/routeExposure.js"
import type { DurableFormatRegistration } from "../serialization/formatRegistry.js"
import type { GuaranteeId } from "../spec/guarantees.js"

export const DEFINITION_KINDS = ["entity", "operation", "readModel", "event", "consumer", "job", "schedule", "workflow", "route", "datasource", "delegationRule", "scopeResolver", "policy"] as const
export type FrameworkDefinitionKind = typeof DEFINITION_KINDS[number]
export interface FrameworkDefinitionIdentity { readonly key: string; readonly definitionVersion: number }
export interface FrameworkReference { readonly kind: FrameworkDefinitionKind; readonly key: string; readonly minimumVersion?: number; readonly allowCycle?: boolean }
export interface RuntimePortRequirement { readonly key: string; readonly capability: string; readonly optional?: boolean }
export interface ReadinessRequirement { readonly key: string; readonly description: string }
export interface DurableFormatRequirement { readonly formatId: string; readonly readableVersions: readonly number[]; readonly writableVersion?: number }
export interface FrameworkDefinition extends FrameworkDefinitionIdentity {
  readonly kind: FrameworkDefinitionKind; readonly references?: readonly FrameworkReference[]; readonly requiredCapabilities?: readonly string[]
  readonly requiredGuarantees?: readonly GuaranteeId[]; readonly requiredFormats?: readonly DurableFormatRequirement[]
  readonly requiredPorts?: readonly RuntimePortRequirement[]; readonly readiness?: readonly ReadinessRequirement[]
  readonly datasourceKey?: string; readonly policyKey?: string; readonly eventKeys?: readonly string[]; readonly operationKeys?: readonly string[]; readonly workflowKeys?: readonly string[]
  readonly config?: Readonly<Record<string, unknown>>
}
export type CompiledScopeResolutionDefinition =
  | { readonly kind: "fixed"; readonly scope: ExecutionScope }
  | { readonly kind: "resolver"; readonly resolverKey: string; readonly allowedTargetKinds: readonly ExecutionScope["kind"][] }
export interface RouteDefinition extends FrameworkDefinition {
  readonly kind: "route"; readonly method: string; readonly path: string; readonly operationKey: string; readonly exposure: RouteExposure
  readonly scopeResolution?: CompiledScopeResolutionDefinition; readonly authorizationPlanKey?: string
  readonly inputPolicy?: Readonly<Record<string, unknown>>; readonly outputPolicy?: Readonly<Record<string, unknown>>
  readonly mutation?: { readonly allowed: false } | { readonly allowed: true; readonly idempotencyRequirement: "required" | "optional" | "forbidden" }
}
export interface DatasourceDefinition extends FrameworkDefinition { readonly kind: "datasource"; readonly adapter: string; readonly adapterBuildId?: string; readonly capabilities: readonly string[]; readonly topology?: Readonly<Record<string, string | number | boolean>> }
export interface DelegationRuleDefinition extends FrameworkDefinition { readonly kind: "delegationRule"; readonly fromKinds: readonly ExecutionScope["kind"][]; readonly toKinds: readonly ExecutionScope["kind"][]; readonly capabilities: readonly string[]; readonly maximumDepth?: number; readonly allowImpersonation?: boolean }
export interface ScopeResolverDefinition extends FrameworkDefinition { readonly kind: "scopeResolver"; readonly allowedTargetKinds: readonly ExecutionScope["kind"][] }
export interface DurableFormatDefinition extends DurableFormatRegistration { readonly readableVersions?: readonly number[] }
