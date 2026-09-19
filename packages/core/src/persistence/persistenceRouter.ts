import type { ScopedPersistenceProvider } from "../persistence/provider.js"
import type { ExecutionScope } from "../domain/executionScope.js"
import type { DatasourceRoutingRequest } from "./datasource.js"

/** Trusted-infrastructure boundary. Operation contexts receive only its resolved provider. */
export interface PersistenceRouter {
  resolve(request: DatasourceRoutingRequest): Promise<ScopedPersistenceProvider<ExecutionScope>>
}
