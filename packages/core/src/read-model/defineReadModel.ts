import { readonlySet } from "../kernel/readonlyCollections"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"
import { ConfigurationError } from "../domain/errors"
import { encodeExecutionScopeId } from "../domain/executionScope"
import { assertQueryBudget } from "../query/queryBudget"
import type { CompiledMultiSourceReadPlan } from "./types"

export function defineReadModel(input:CompiledMultiSourceReadPlan):CompiledMultiSourceReadPlan {
  if(typeof input.key !== "string" || !input.key.trim()||!Number.isSafeInteger(input.version)||input.version<1) throw new ConfigurationError("Read model key and positive version are required")
  if(input.sources.length<1||new Set(input.sources.map(source=>source.sourceKey)).size!==input.sources.length) throw new ConfigurationError("Read model sources must be non-empty and uniquely keyed")
  for(const source of input.sources){ if(!source.datasourceKey.trim()||source.authority.scopeId!==encodeExecutionScopeId(source.authority.scope)) throw new ConfigurationError(`Invalid source envelope: ${source.sourceKey}`) }
  if (!["fail-whole-read", "allow-partial-with-explicit-metadata"].includes(input.partialFailurePolicy)) throw new ConfigurationError("Invalid partial source failure policy")
  if (!["eventual", "bounded-staleness", "application-defined-snapshot"].includes(input.consistency.kind)) throw new ConfigurationError("Invalid multi-source consistency")
  for (const source of input.sources) {
    if (typeof source.sourceKey !== "string" || !source.sourceKey.trim() || !["strong", "session", "eventual"].includes(source.consistency)) throw new ConfigurationError("Invalid source key or consistency")
    if (source.maxStalenessMs !== undefined && (!Number.isSafeInteger(source.maxStalenessMs) || source.maxStalenessMs < 0)) throw new ConfigurationError("Invalid source bounded-staleness proof")
  }
  const connected = new Set([input.sources[0]!.sourceKey])
  for (const join of input.joins) {
    if (!["inner", "left"].includes(join.type) || !["one-to-one", "one-to-many", "many-to-one"].includes(join.cardinality)) throw new ConfigurationError("Invalid join type or cardinality")
    if (!connected.has(join.leftSourceKey) || connected.has(join.rightSourceKey)) throw new ConfigurationError("Joins must form an ordered, connected source tree")
    connected.add(join.rightSourceKey)
  }
  if (connected.size !== input.sources.length) throw new ConfigurationError("Every read-model source requires a supported join")
  const byKey=new Map(input.sources.map(source=>[source.sourceKey,source]))
  for(const join of input.joins){ const left=byKey.get(join.leftSourceKey); const right=byKey.get(join.rightSourceKey); if(!left||!right) throw new ConfigurationError("Join references an unknown source"); if(!left.readableFields.has(join.leftKey)||!right.readableFields.has(join.rightKey)) throw new ConfigurationError("Join key is not authorized"); if(!Number.isSafeInteger(join.maxExpansion)||join.maxExpansion<1) throw new ConfigurationError("Join maxExpansion must be positive") }
  for(const aggregate of input.aggregatePermissions){ const source=byKey.get(aggregate.sourceKey); if(!source) throw new ConfigurationError("Aggregate references an unknown source"); if(aggregate.field&&!source.aggregatableFields.has(aggregate.field)) throw new ConfigurationError("Aggregate field is not authorized"); for(const field of aggregate.groupBy??[]) if(!source.aggregatableFields.has(field)) throw new ConfigurationError("Aggregate grouping field is not authorized") }
  if(input.consistency.kind==="bounded-staleness"){ const maximum=input.consistency.maxStalenessMs; if(!Number.isSafeInteger(maximum)||maximum<0||input.sources.some(source=>source.maxStalenessMs===undefined||source.maxStalenessMs>maximum)) throw new ConfigurationError("Sources do not prove the bounded-staleness requirement") }
  if(input.consistency.kind==="application-defined-snapshot"){ const coordinator=input.consistency.coordinatorKey; if(typeof coordinator!=="string"||!coordinator.trim()||typeof input.consistency.snapshotTokenFormat!=="string"||!input.consistency.snapshotTokenFormat.trim())throw new ConfigurationError("Snapshot coordinator and token format are required"); if(input.sources.some(source=>!source.snapshotCoordinatorKeys?.has(coordinator))) throw new ConfigurationError("Snapshot coordinator is not supported by every source") }
  if(!Number.isSafeInteger(input.maxSourceRows)||input.maxSourceRows<1||!Number.isSafeInteger(input.maxOutputRows)||input.maxOutputRows<1) throw new ConfigurationError("Read model row budgets must be positive")
  assertQueryBudget(input.budget)
  return cloneAndFreezeDefinition({...input,sources:input.sources.map(source=>({...source,
    readableFields:readonlySet(source.readableFields),filterableFields:readonlySet(source.filterableFields),
    sortableFields:readonlySet(source.sortableFields),aggregatableFields:readonlySet(source.aggregatableFields),
    ...(source.snapshotCoordinatorKeys ? {snapshotCoordinatorKeys:readonlySet(source.snapshotCoordinatorKeys)} : {}),
  }))})
}
