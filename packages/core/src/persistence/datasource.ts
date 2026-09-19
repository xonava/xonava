import type { ExecutionScope } from "../domain/executionScope.js"
import type { ReadConsistency } from "../query/readConsistency.js"

export type DatasourceKey = string & { readonly __brand?: "DatasourceKey" }
export type DataSourceAccess = "read" | "write"
export interface DatasourceCapabilities {
  readonly readConsistency: readonly ReadConsistency[]
  readonly writable: boolean
  readonly localTransactions: boolean
  readonly strongMultiSourceSnapshot?: boolean
}
export interface DatasourceRoutingRequest {
  readonly scope: ExecutionScope
  readonly source: DatasourceKey
  readonly access: DataSourceAccess
  readonly consistency: ReadConsistency
}
