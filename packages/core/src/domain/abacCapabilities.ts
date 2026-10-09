import { evaluateGlobalAbacCapability, evaluateAbacRecordCapability } from "./abacDecision"
import type { AbacPolicyBundle } from "./abacTypes"

/**
 * Check a capability as a GLOBAL grant.
 * Only policies with unrestricted conditions can grant global capabilities,
 * while any relevant deny, conditional or not, blocks the grant in its tier.
 */
export function hasGlobalAbacCapability(args: {
  bundle: AbacPolicyBundle
  capabilityKey: string
}): boolean {
  return evaluateGlobalAbacCapability({ bundle: args.bundle, capability: args.capabilityKey }).allowed
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
