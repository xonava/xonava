import { ConfigurationError } from "../domain"
import type { PersistenceProvider } from "../persistence/provider"

export type CacheInvalidationGuarantee = "atomic-generation" | "durable-eventual-generation" | "best-effort"
export interface CacheInvalidationStrategy { readonly guarantee: CacheInvalidationGuarantee; readonly correctnessCritical: boolean }
export function compileCacheInvalidationStrategy(args: { requested: CacheInvalidationGuarantee; correctnessCritical: boolean; atomicAvailable: boolean; durableEventualAvailable: boolean }): CacheInvalidationStrategy {
  if (args.correctnessCritical && args.requested === "best-effort") throw new ConfigurationError("Correctness-critical cache invalidation cannot use best-effort")
  if (args.requested === "atomic-generation" && !args.atomicAvailable) throw new ConfigurationError("Atomic cache generation is required but not proven")
  if (args.requested === "durable-eventual-generation" && !args.durableEventualAvailable) throw new ConfigurationError("Durable eventual cache generation is required but no finalizer is available")
  return Object.freeze({ guarantee: args.requested, correctnessCritical: args.correctnessCritical })
}
export interface TransactionalCacheGenerationParticipant { advanceInTransaction(tag: string, persistence: PersistenceProvider): Promise<string> }
