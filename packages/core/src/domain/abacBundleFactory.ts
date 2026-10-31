import type { NormalizedAbacPolicy, VerifiedAbacPolicyBundle, AbacPolicy, AbacContext } from "./abacTypes"
import type { AbacPolicyProvider } from "../security/abacPolicyProvider"
import type { AbacFieldDefinition, AbacModuleCatalog } from "./abacCatalog"
import { normalizeAbacPolicy } from "./abacPolicyNormalizer"
import { InvalidPolicyConfigurationError } from "./errors"
import { bindAbacSecurityDigest } from "./abacBundleIntegrity"

export interface CreateAbacBundleInput {
  provider: AbacPolicyProvider
  mode: "tenant" | "platform"
  moduleKey: string
  context: AbacContext
  catalog: AbacModuleCatalog
  at?: Date
}

const SCOPE_ORDER = { role: 5, branch: 4, department: 3, user: 2, tenant_default: 1, platform_default: 0 } as const

function scopeRequiresRef(scopeType: string): boolean {
  return scopeType === "role" || scopeType === "branch" || scopeType === "department" || scopeType === "user"
}

function scopeRefMissing(scopeType: string, scopeRefId?: string | null): boolean {
  return scopeRequiresRef(scopeType) && (scopeRefId == null || scopeRefId === "")
}

function scopeMatchesContext(policy: NormalizedAbacPolicy | { source: { scopeType: string; scopeRefId?: string | null } }, input: CreateAbacBundleInput): boolean {
  const { scopeType, scopeRefId } = policy.source
  const allowed = input.mode === "tenant"
    ? ["tenant_default", "role", "branch", "department", "user"]
    : ["platform_default", "role", "user"]
  if (!allowed.includes(scopeType)) return false

  // A scope type that requires a ref must always have one; a missing ref is
  // never a match (surface it as POLICY_SCOPE_INVALID in the factory).
  if (scopeRefMissing(scopeType, scopeRefId)) return false

  const expectedRef = scopeType === "role" ? input.context.roleId
    : scopeType === "branch" ? input.context.branchId
      : scopeType === "department" ? input.context.departmentId
        : scopeType === "user" ? input.context.userId
          : undefined
  return scopeRefId == null ? expectedRef == null : scopeRefId === expectedRef
}

type PolicyFailure = { policyId: string; errors: unknown[] }

/** Unknown catalog names (actions, capabilities, fields) reported by catalog validation. */
function missingCatalogFields(failures: PolicyFailure[]): string[] {
  const names = new Set<string>()
  for (const { errors } of failures) {
    for (const error of errors) {
      const { code, message, value } = error as { code?: unknown; message?: unknown; value?: unknown }
      if (code === "CATALOG_VALIDATION_FAILED" && typeof message === "string" && message.startsWith("Unknown field") && typeof value === "string") names.add(value)
    }
  }
  return [...names]
}

function throwOnPolicyFailures(moduleKey: string, failures: PolicyFailure[]): void {
  const firstError = failures[0]
  if (!firstError) return
  const missingFields = missingCatalogFields(failures)
  throw new InvalidPolicyConfigurationError(
    missingFields.length > 0
      ? `One or more policies failed normalization: catalog does not list field(s) ${missingFields.join(", ")}`
      : "One or more policies failed normalization",
    {
      moduleKey,
      policyId: firstError.policyId,
      issues: failures.flatMap(e => e.errors),
      ...(missingFields.length > 0 ? { missingFields } : {}),
    },
  )
}

export interface AssertAbacPoliciesMatchCatalogInput {
  moduleKey: string
  catalog: AbacModuleCatalog
  policies: readonly AbacPolicy[]
  /** Only used to resolve `userAttr` references; unresolved attributes never match. */
  context?: AbacContext
  at?: Date
}

/**
 * Configuration pre-flight: throws `InvalidPolicyConfigurationError` (moduleKey,
 * policyId, issues, `missingFields`) when any policy names an action,
 * capability, condition field or fieldAccess read/write/query field that the
 * module catalog does not list. It runs the same normalization as
 * `createAbacBundle`, so apps can call it at startup or when policies are
 * loaded instead of discovering the mismatch on the first request.
 */
export function assertAbacPoliciesMatchCatalog(input: AssertAbacPoliciesMatchCatalogInput): void {
  if (input.catalog.moduleKey !== input.moduleKey) {
    throw new InvalidPolicyConfigurationError("Catalog moduleKey does not match input moduleKey", {
      moduleKey: input.moduleKey,
      catalogModuleKey: input.catalog.moduleKey,
      policyId: null,
      issues: [],
    })
  }
  const failures: PolicyFailure[] = []
  for (const policy of input.policies) {
    const result = normalizeAbacPolicy({ policy, catalog: input.catalog, context: input.context ?? {}, ...(input.at ? { at: input.at } : {}) })
    if (!result.success) failures.push({ policyId: policy.source.policyId, errors: result.errors })
  }
  throwOnPolicyFailures(input.moduleKey, failures)
}

/**
 * Resolves, validates and normalizes policies for one request context. Every
 * returned bundle is bound and registered as verified, so the result is typed
 * `VerifiedAbacPolicyBundle` and needs no `assertVerifiedAbacBundle`.
 */
export async function createAbacBundle(input: CreateAbacBundleInput): Promise<VerifiedAbacPolicyBundle> {
  const rawPolicies = await input.provider.resolve({
    mode: input.mode,
    moduleKey: input.moduleKey,
    context: input.context,
    ...(input.at ? { at: input.at } : {}),
  })

  if (input.catalog.moduleKey !== input.moduleKey) {
    throw new InvalidPolicyConfigurationError("Catalog moduleKey does not match input moduleKey", {
      moduleKey: input.moduleKey,
      catalogModuleKey: input.catalog.moduleKey,
      policyId: null,
      issues: [],
    })
  }

  const normalized: NormalizedAbacPolicy[] = []
  const allErrors: PolicyFailure[] = []
  const inactivePolicyIds: string[] = []

  for (const policy of rawPolicies) {
    const result = normalizeAbacPolicy({ policy, catalog: input.catalog, context: input.context, ...(input.at ? { at: input.at } : {}) })
    if (result.success) {
      if (result.excluded === "inactive") {
        inactivePolicyIds.push(policy.source.policyId)
        continue
      }
      if (scopeMatchesContext(result.policy, input)) normalized.push(result.policy)
      else {
        const invalidRef = scopeRefMissing(result.policy.source.scopeType, result.policy.source.scopeRefId)
        allErrors.push({
          policyId: policy.source.policyId,
          errors: [{
            code: invalidRef ? "POLICY_SCOPE_INVALID" : "POLICY_SCOPE_MISMATCH",
            message: invalidRef
              ? `Policy scope type "${result.policy.source.scopeType}" requires a scope reference but none was provided`
              : "Policy scope does not match bundle mode or context",
          }],
        })
      }
    } else {
      allErrors.push({ policyId: policy.source.policyId, errors: result.errors })
    }
  }

  throwOnPolicyFailures(input.moduleKey, allErrors)

  normalized.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    const aOrder = SCOPE_ORDER[a.source.scopeType] ?? 0
    const bOrder = SCOPE_ORDER[b.source.scopeType] ?? 0
    if (bOrder !== aOrder) return bOrder - aOrder
    // Byte-order (UTF-16 code unit) comparison; localeCompare is locale- and
    // collation-sensitive and would make the tie-break non-deterministic.
    return a.source.policyId < b.source.policyId ? -1 : a.source.policyId > b.source.policyId ? 1 : 0
  })

  // Defensive: ensure the cloned field catalog is a null-prototype object
  // even if the source catalog bypassed defineAbacModule's normalisation.
  const clonedFields: unknown = structuredClone(input.catalog.fields)
  const typedClonedFields = clonedFields as Record<string, AbacFieldDefinition>
  const safeFieldCatalog = {} as Record<string, AbacFieldDefinition>
  Object.setPrototypeOf(safeFieldCatalog, null)
  for (const key of Object.keys(typedClonedFields)) {
    safeFieldCatalog[key] = typedClonedFields[key]!
  }

  const bundle = {
    mode: input.mode,
    moduleKey: input.moduleKey,
    policies: normalized,
    context: structuredClone(input.context),
    // Security bundles are deny-by-default. An allow-default creates a policy
    // omission failure mode and is never supported.
    defaultEffect: "deny" as const,
    fieldCatalog: safeFieldCatalog,
    ...(inactivePolicyIds.length > 0 ? { inactivePolicyIds } : {}),
  }
  return bindAbacSecurityDigest(bundle)
}
