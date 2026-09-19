import { ConfigurationError } from "../domain/errors.js"
import type { MultiSourceConsistency } from "../query/readConsistency.js"
import type { DatasourceCapabilities, DatasourceKey } from "../persistence/datasource.js"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity.js"

export interface ReadModelSource { readonly source: DatasourceKey; readonly capabilities: DatasourceCapabilities }
export interface ReadModelDefinition { readonly key: string; readonly sources?: readonly ReadModelSource[]; readonly consistency?: MultiSourceConsistency }
export interface CompiledReadModelDefinition { readonly key: string; readonly sources: readonly ReadModelSource[]; readonly consistency: MultiSourceConsistency | "strong" }

export function defineReadModelDefinition(definition: ReadModelDefinition): CompiledReadModelDefinition {
  if (!definition.key?.trim()) throw new ConfigurationError("Read model key must be non-empty.")
  const sources = definition.sources?.length ? [...definition.sources] : [{ source: "primary" as DatasourceKey, capabilities: { readConsistency: ["strong" as const], writable: true, localTransactions: true } }]
  if (new Set(sources.map(item => item.source)).size !== sources.length) throw new ConfigurationError(`Read model '${definition.key}' has duplicate sources.`)
  if (sources.length > 1 && !definition.consistency) throw new ConfigurationError(`Multi-source read model '${definition.key}' must declare consistency semantics.`)
  return cloneAndFreezeDefinition({ key: definition.key, sources, consistency: sources.length === 1 ? "strong" as const : definition.consistency! })
}
