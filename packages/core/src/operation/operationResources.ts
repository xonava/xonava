import { ConfigurationError } from "../domain"

export type OperationResourceKind = "entity" | "read-model" | "port"
export type OperationResourceAccess = "read" | "write"

export interface OperationResourceDeclaration {
  readonly kind: OperationResourceKind
  readonly key: string
  readonly access: OperationResourceAccess
  readonly source?: string
}

/**
 * Declarative data authority for an ordinary application operation.
 * Datasource keys are logical routing identities; they do not grant access.
 */
export interface OperationDataAccessDeclaration {
  readonly kind: "declared"
  readonly datasourceKey: string
  readonly resources: readonly OperationResourceDeclaration[]
}

/**
 * Raw provider authority is deliberately not part of OperationDefinition.
 * Infrastructure code must opt into this separately and carry review evidence.
 */
export interface InfrastructureRawDataAccessCapability {
  readonly kind: "infrastructure-raw"
  readonly datasourceKey: string
  readonly justification: string
  readonly reviewKey: string
}

export function defineOperationDataAccess(
  declaration: OperationDataAccessDeclaration,
): OperationDataAccessDeclaration {
  if (!declaration || typeof declaration !== "object" || declaration.kind !== "declared") throw new ConfigurationError("Operation data access kind must be declared.")
  assertNonEmpty(declaration.datasourceKey, "Operation datasource key")
  if (!Array.isArray(declaration.resources) || declaration.resources.length === 0) {
    throw new ConfigurationError("Operation data access must declare at least one resource.")
  }
  const seen = new Set<string>()
  const resources = declaration.resources.map((resource) => {
    if (!resource || typeof resource !== "object") throw new ConfigurationError("Operation resource must be an object.")
    if (!(["entity", "read-model", "port"] as const).includes(resource.kind)) {
      throw new ConfigurationError("Operation resource kind is invalid.")
    }
    if (!(["read", "write"] as const).includes(resource.access)) {
      throw new ConfigurationError("Operation resource access is invalid.")
    }
    assertNonEmpty(resource.key, "Operation resource key")
    const identity = `${resource.kind}:${resource.key}`
    if (seen.has(identity)) throw new ConfigurationError(`Duplicate operation resource declaration: ${identity}.`)
    seen.add(identity)
    if (resource.source !== undefined) assertNonEmpty(resource.source, "Operation resource datasource")
    return Object.freeze({ kind: resource.kind, key: resource.key, access: resource.access, ...(resource.source ? { source: resource.source } : {}) })
  })
  return Object.freeze({ kind: "declared", datasourceKey: declaration.datasourceKey, resources: Object.freeze(resources) })
}

export function defineInfrastructureRawDataAccess(
  capability: InfrastructureRawDataAccessCapability,
): InfrastructureRawDataAccessCapability {
  if (!capability || typeof capability !== "object" || capability.kind !== "infrastructure-raw") throw new ConfigurationError("Infrastructure raw access kind is invalid.")
  assertNonEmpty(capability.datasourceKey, "Infrastructure datasource key")
  assertNonEmpty(capability.justification, "Infrastructure raw-access justification")
  assertNonEmpty(capability.reviewKey, "Infrastructure raw-access review key")
  return Object.freeze({ ...capability })
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${label} must be non-empty.`)
  }
}
