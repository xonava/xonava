import { CapabilityError, ForbiddenError } from "./errors"
import { assertVerifiedAbacBundle } from "./abacBundleIntegrity"
import { createAbacAuthorizer } from "./abacAuthorizer"
import type { VerifiedAbacPolicyBundle } from "./abacTypes"

export interface ModuleAuthorizationFacts {
  scope: "application" | "tenant" | "platform" | "system" | "public"
  enabledModuleKeys?: readonly string[]
  enabledModuleActions?: Readonly<Record<string, readonly string[]>>
  enabledModuleCapabilities?: Readonly<Record<string, readonly string[]>>
  ownerAuthority: boolean
  impersonated: boolean
}

export interface FrameworkAuthorizationInput {
  facts: ModuleAuthorizationFacts
  moduleKey: string
  action: string
  capabilityKey?: string
  bundle?: VerifiedAbacPolicyBundle | null
  /**
   * ABAC is required by default. Callers that intentionally use module-only
   * authorization must opt in explicitly, so a missing policy source cannot
   * silently become an allow.
   */
  abacRequirement?: "required" | "optional"
  evaluateAbacAction?: boolean
}

export interface FrameworkAuthorizationDecision {
  allowed: boolean
  ownerBypass: boolean
}

function includesAction(values: readonly string[] | undefined, key: string): boolean {
  return values === undefined || values.includes(key) || values.includes("manage")
}

export function evaluateModuleAuthorization(input: FrameworkAuthorizationInput): FrameworkAuthorizationDecision {
  const { facts } = input
  const ownerBypass = facts.ownerAuthority && !facts.impersonated
  if (ownerBypass) return { allowed: true, ownerBypass: true }

  if (facts.scope === "tenant") {
    if (!facts.enabledModuleKeys?.includes(input.moduleKey)) return { allowed: false, ownerBypass: false }
    if (!includesAction(facts.enabledModuleActions?.[input.moduleKey], input.action)) {
      return { allowed: false, ownerBypass: false }
    }
    if (input.capabilityKey && !includesAction(facts.enabledModuleCapabilities?.[input.moduleKey], input.capabilityKey)) {
      return { allowed: false, ownerBypass: false }
    }
  }
  return { allowed: true, ownerBypass: false }
}

export function assertFrameworkAuthorization(input: FrameworkAuthorizationInput): FrameworkAuthorizationDecision {
  const decision = evaluateModuleAuthorization(input)
  if (!decision.allowed) {
    throw new CapabilityError(
      input.capabilityKey
        ? `${input.moduleKey}:${input.capabilityKey}`
        : `${input.moduleKey}:${input.action}`,
    )
  }

  if (decision.ownerBypass) return decision
  if (!input.bundle) {
    if (input.abacRequirement !== "optional") {
      throw new ForbiddenError("An ABAC policy bundle is required for this operation")
    }
    if (input.facts.scope === "public" && input.capabilityKey) {
      throw new ForbiddenError("This operation is not permitted")
    }
    return decision
  }

  assertVerifiedAbacBundle(input.bundle)
  // A verified bundle for another module must never authorize this one.
  if (input.bundle.moduleKey !== input.moduleKey) {
    throw new ForbiddenError("The ABAC policy bundle does not belong to this module")
  }
  const authorizer = createAbacAuthorizer(input.bundle)
  if (input.evaluateAbacAction !== false) authorizer.assertCollectionAction(input.action)
  if (input.capabilityKey) authorizer.assertGlobalCapability(input.capabilityKey)
  return decision
}
