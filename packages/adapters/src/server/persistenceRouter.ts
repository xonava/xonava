import { ConfigurationError } from "core/domain"
import type { DatasourceCapabilities, DatasourceKey, DatasourceRoutingRequest, PersistenceRouter } from "core/persistence"
import type { ScopedPersistenceProvider } from "core/persistence"
import type { ExecutionScope } from "core/domain"

export interface PersistenceRouteBinding {
  readonly capabilities: DatasourceCapabilities
  readonly resolve: (request: DatasourceRoutingRequest) => ScopedPersistenceProvider<ExecutionScope> | Promise<ScopedPersistenceProvider<ExecutionScope>>
}

/** Closed registry of trusted logical sources; callers cannot inject physical shard names. */
export class TrustedPersistenceRouter implements PersistenceRouter {
  readonly #bindings: ReadonlyMap<DatasourceKey, PersistenceRouteBinding>
  constructor(bindings: Readonly<Record<string, PersistenceRouteBinding>>) {
    this.#bindings = new Map(Object.entries(bindings) as [DatasourceKey, PersistenceRouteBinding][])
    if (this.#bindings.size === 0) throw new ConfigurationError("Persistence router requires at least one trusted datasource binding.")
  }
  async resolve(request: DatasourceRoutingRequest): Promise<ScopedPersistenceProvider<ExecutionScope>> {
    const binding = this.#bindings.get(request.source)
    if (!binding) throw new ConfigurationError(`Datasource '${request.source}' is not registered.`)
    if (request.access === "write" && !binding.capabilities.writable) throw new ConfigurationError(`Datasource '${request.source}' is read-only.`)
    if (!binding.capabilities.readConsistency.includes(request.consistency)) throw new ConfigurationError(`Datasource '${request.source}' does not prove ${request.consistency} consistency.`)
    const provider = await binding.resolve(Object.freeze({ ...request }))
    if (provider.scope.kind !== request.scope.kind) throw new ConfigurationError(`Datasource '${request.source}' returned a provider for the wrong scope kind.`)
    return provider
  }
}
