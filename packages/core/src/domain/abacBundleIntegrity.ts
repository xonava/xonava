import type { AbacPolicyBundle, VerifiedAbacPolicyBundle } from "./abacTypes"
import { canonicalJsonString } from "../serialization/canonicalJson"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"

const verifiedBundles = new WeakSet<object>()

export const deepFreeze = cloneAndFreezeDefinition

function digestableBundle(bundle: Omit<AbacPolicyBundle, "securityDigest"> | AbacPolicyBundle): Omit<AbacPolicyBundle, "securityDigest"> {
  // Reconstruct string-keyed domain fields; runtime identity is never digest input.
  return Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== "securityDigest"),
  ) as unknown as Omit<AbacPolicyBundle, "securityDigest">
}

export async function deriveAbacSecurityDigest(bundle: Omit<AbacPolicyBundle, "securityDigest">): Promise<string> {
  const canonical = canonicalJsonString({ version: 1, bundle: digestableBundle(bundle) })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function bindAbacSecurityDigest(bundle: Omit<AbacPolicyBundle, "securityDigest">): Promise<VerifiedAbacPolicyBundle> {
  if (bundle.defaultEffect !== "deny") throw new Error("ABAC bundles must be deny-by-default")
  const withoutDigest = cloneAndFreezeDefinition(digestableBundle(bundle), true)
  const securityDigest = await deriveAbacSecurityDigest(withoutDigest)
  const result = deepFreeze({ ...withoutDigest, securityDigest }) as VerifiedAbacPolicyBundle
  verifiedBundles.add(result)
  return result
}

/**
 * Verification helper — intended for consumers only, not an
 * enforcement primitive for the framework's own paths.
 *
 * The SHA-256 digest alone is recomputable by any caller, so a self-consistent
 * digest is NOT an unforgeable brand. This helper therefore also requires the
 * private verified identity (`assertVerifiedAbacBundle`): a raw or forged
 * bundle is rejected even when its digest matches its own content. The missing-
 * digest diagnostic is surfaced first only to preserve a clearer error for
 * bundles that never carried a digest; every digest-bearing bundle must prove
 * the verified brand before its digest is trusted.
 */
export async function assertAbacSecurityDigest(bundle: AbacPolicyBundle): Promise<void> {
  if (bundle.defaultEffect !== "deny") throw new Error("ABAC bundles must be deny-by-default")
  if (!bundle.securityDigest) throw new Error("ABAC bundle security digest is missing")
  assertVerifiedAbacBundle(bundle)
  const withoutDigest = digestableBundle(bundle)
  const expected = await deriveAbacSecurityDigest(withoutDigest)
  if (expected !== bundle.securityDigest) throw new Error("ABAC bundle security digest mismatch")
}

export function assertVerifiedAbacBundle(bundle: AbacPolicyBundle): asserts bundle is VerifiedAbacPolicyBundle {
  if (
    !bundle ||
    typeof bundle !== "object" ||
    bundle.defaultEffect !== "deny" ||
    !verifiedBundles.has(bundle) ||
    typeof bundle.securityDigest !== "string"
  ) {
    throw new Error("ABAC bundle is not a verified production bundle")
  }
}
