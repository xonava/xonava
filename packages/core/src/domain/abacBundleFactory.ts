import type { NormalizedAbacPolicy, AbacPolicyBundle, AbacContext } from "./abacTypes"
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

export async function createAbacBundle(input: CreateAbacBundleInput): Promise<AbacPolicyBundle> {
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
  const allErrors: Array<{ policyId: string; errors: unknown[] }> = []
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

  if (allErrors.length > 0) {
    const firstError = allErrors[0]
    if (!firstError) throw new InvalidPolicyConfigurationError("Policy normalization failed", {
      moduleKey: input.moduleKey,
      policyId: null,
      issues: [],
    })
    throw new InvalidPolicyConfigurationError("One or more policies failed normalization", {
      moduleKey: input.moduleKey,
      policyId: firstError.policyId,
      issues: allErrors.flatMap(e => e.errors),
    })
  }

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
