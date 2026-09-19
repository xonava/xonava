import type { PolicyOperator } from "./abacPolicySchema"
import type { AbacFieldType } from "./coercePolicyValue"

export interface AbacFieldDefinition {
  key: string
  type: AbacFieldType
  operators: PolicyOperator[]
}

export interface AbacModuleCatalog {
  moduleKey: string
  actions: string[]
  capabilities: string[]
  fields: Record<string, AbacFieldDefinition>
}

/**
 * Register an ABAC module catalog.  The `fields` map is normalised to a
 * null-prototype object so that downstream lookups via `Object.hasOwn()`
 * cannot be spoofed by inherited properties such as `__proto__`,
 * `constructor`, or `toString`.
 */
export function defineAbacModule(catalog: AbacModuleCatalog): AbacModuleCatalog {
  const safeFields = {} as Record<string, AbacFieldDefinition>
  Object.setPrototypeOf(safeFields, null)
  for (const key of Object.keys(catalog.fields)) {
    safeFields[key] = catalog.fields[key]!
  }
  return { ...catalog, fields: safeFields }
}
