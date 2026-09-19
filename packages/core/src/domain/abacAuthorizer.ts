import { ForbiddenError } from "./errors"
import { evaluateAbacRecordAction, evaluateAbacActionForCollection, type AbacCollectionDecision } from "./abacDecision"
import { hasGlobalAbacCapability, hasRecordAbacCapability } from "./abacCapabilities"
import { buildActionScope } from "./abacReadScope"
import { enforceAbacWrite } from "./abacWrite"
import { resolveFieldReadOverrides } from "./fieldAccess"
import type { AbacReadScope, VerifiedAbacPolicyBundle } from "./abacTypes"
import { assertVerifiedAbacBundle } from "./abacBundleIntegrity"
import type { FieldReadOverride } from "./fieldAccess"

export interface AbacAuthorizer {
  canRecordAction(action: string, record: Record<string, unknown>): boolean
  assertRecordAction(action: string, record: Record<string, unknown>): void

  /** Check collection-level authorization without throwing. */
  authorizeCollection(action: string): AbacCollectionDecision
  /** Assert action at collection level. Returns the AbacCollectionDecision with scope for row-level filtering. */
  assertCollectionAction(action: string): AbacCollectionDecision

  canGlobalCapability(capability: string): boolean
  assertGlobalCapability(capability: string): void
  canRecordCapability(capability: string, record: Record<string, unknown>): boolean
  assertRecordCapability(capability: string, record: Record<string, unknown>): void

  buildActionScope(action: string): AbacReadScope

  assertWrite(params: { action: "create" | "update" | "delete"; record: Record<string, unknown>; changedFields?: string[] }): void
  fieldReadPlan(record: Record<string, unknown>): Record<string, FieldReadOverride>
}

export function createAbacAuthorizer(bundle: VerifiedAbacPolicyBundle): AbacAuthorizer {
  assertVerifiedAbacBundle(bundle)
  return {
    canRecordAction(action, record) {
      return evaluateAbacRecordAction({ bundle, action, record }).allowed
    },

    assertRecordAction(action, record) {
      const decision = evaluateAbacRecordAction({ bundle, action, record })
      if (!decision.allowed) {
        throw new ForbiddenError("Access denied by ABAC policy.", {
          reasonCode: decision.reasonCode,
          target: decision.target,
          evidence: decision.evidence,
        })
      }
    },

    authorizeCollection(action) {
      return evaluateAbacActionForCollection({ bundle, action })
    },

    assertCollectionAction(action) {
      const cd = evaluateAbacActionForCollection({ bundle, action })
      if (!cd.allowed) {
        throw new ForbiddenError("Access denied by ABAC policy.", {
          reasonCode: cd.reasonCode,
          target: { type: "action", key: action },
          evidence: cd.evidence,
        })
      }
      return cd
    },

    canGlobalCapability(capability) {
      return hasGlobalAbacCapability({ bundle, capabilityKey: capability })
    },

    assertGlobalCapability(capability) {
      if (!hasGlobalAbacCapability({ bundle, capabilityKey: capability })) {
        throw new ForbiddenError(`Global capability denied: ${capability}`)
      }
    },

    canRecordCapability(capability, record) {
      return hasRecordAbacCapability({ bundle, capabilityKey: capability, record })
    },

    assertRecordCapability(capability, record) {
      if (!hasRecordAbacCapability({ bundle, capabilityKey: capability, record })) {
        throw new ForbiddenError(`Record capability denied: ${capability}`)
      }
    },

    buildActionScope(action) {
      return buildActionScope({ bundle, action })
    },

    assertWrite({ action, record, changedFields }) {
      enforceAbacWrite({ bundle, action, record, ...(changedFields !== undefined ? { changedFields } : {}) })
    },

    fieldReadPlan(record) {
      return resolveFieldReadOverrides({
        policies: bundle.policies,
        moduleKey: bundle.moduleKey,
        record,
      })
    },
  }
}
