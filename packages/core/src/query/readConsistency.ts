import { ConfigurationError } from "../domain/errors.js"
export type ReadConsistency = "strong" | "session" | "eventual"
export type MultiSourceConsistency =
  | { readonly kind: "eventual" }
  | { readonly kind: "bounded-staleness"; readonly maxStalenessMs: number }
  | { readonly kind: "application-defined-snapshot"; readonly coordinatorKey: string; readonly snapshotTokenFormat: string }
export function assertReadConsistencySupported(requested: ReadConsistency, proven: readonly ReadConsistency[]): void {
  if (!proven.includes(requested)) throw new ConfigurationError(`read consistency ${requested} is not proven for the selected datasource topology`)
}
