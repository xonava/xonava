import { evaluateGlobalAbacCapability, evaluateAbacRecordCapability } from "./abacDecision"
import { isAlwaysTrue, simplifyPredicate } from "./predicateSimplifier"
import type { AbacPolicyBundle } from "./abacTypes"

/**
 * Check a capability as a GLOBAL grant.
 * Only policies with unrestricted conditions can grant global capabilities.
 * A conditioned capability policy cannot grant a global capability.
 */
export function hasGlobalAbacCapability(args: {
  bundle: AbacPolicyBundle
  capabilityKey: string
}): boolean {
  const unconditional = args.bundle.policies.filter((p) => {
    return isAlwaysTrue(simplifyPredicate(p.compiledConditions))
  })

  const scopedBundle: AbacPolicyBundle = {
    ...args.bundle,
    policies: unconditional,
  }

  return evaluateGlobalAbacCapability({ bundle: scopedBundle, capability: args.capabilityKey }).allowed
}

/**
 * Check a capability for a specific RECORD.
 * Conditioned capability policies are evaluated against the record.
 */
export function hasRecordAbacCapability(args: {
  bundle: AbacPolicyBundle
  capabilityKey: string
  record: Record<string, unknown>
}): boolean {
  return evaluateAbacRecordCapability({ bundle: args.bundle, capability: args.capabilityKey, record: args.record }).allowed
}

export function resolveGrantedGlobalCapabilities(args: { bundle: AbacPolicyBundle }): Set<string> {
  const allKeys = new Set<string>()
  for (const p of args.bundle.policies) {
    if (p.moduleKey !== args.bundle.moduleKey) continue
    for (const cap of p.payload.capabilities) {
      allKeys.add(cap)
    }
  }

  const granted = new Set<string>()
  for (const cap of allKeys) {
    if (hasGlobalAbacCapability({ bundle: args.bundle, capabilityKey: cap })) granted.add(cap)
  }

  return granted
}
