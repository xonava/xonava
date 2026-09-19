import { ConfigurationError } from "../domain"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"

export interface EventVersionDefinition<T = unknown> {
  readonly version: number
  readonly validate: (payload: unknown) => T
}

export interface EventDefinition<TVersions extends readonly EventVersionDefinition[] = readonly EventVersionDefinition[]> {
  readonly type: string
  readonly versions: TVersions
}

export function defineEvent<const T extends readonly EventVersionDefinition[]>(definition: EventDefinition<T>): EventDefinition<T> {
  if (definition.type.trim().length === 0) throw new ConfigurationError("Event type must be non-empty")
  if (definition.versions.length === 0) throw new ConfigurationError(`Event ${definition.type} must declare a version`)
  const seen = new Set<number>()
  for (const version of definition.versions) {
    if (!Number.isSafeInteger(version.version) || version.version < 1 || seen.has(version.version)) throw new ConfigurationError(`Event ${definition.type} has an invalid or duplicate version`)
    seen.add(version.version)
  }
  return cloneAndFreezeDefinition({ type: definition.type, versions: definition.versions }) as EventDefinition<T>
}
