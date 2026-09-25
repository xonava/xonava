import type { PredicateNode } from "../domain/predicate"
import type { ScopedAuthorityTarget } from "../domain/authority"
import type { ReadConsistency, MultiSourceConsistency } from "../query/readConsistency"
import type { QueryBudget } from "../query/queryBudget"

export interface CompiledReadSourcePlan { readonly sourceKey:string; readonly datasourceKey:string; readonly authority:ScopedAuthorityTarget; readonly mandatoryPredicate:PredicateNode; readonly readableFields:ReadonlySet<string>; readonly filterableFields:ReadonlySet<string>; readonly sortableFields:ReadonlySet<string>; readonly aggregatableFields:ReadonlySet<string>; readonly consistency:ReadConsistency; readonly maxStalenessMs?:number; readonly snapshotCoordinatorKeys?:ReadonlySet<string> }
export interface CompiledReadJoin { readonly leftSourceKey:string; readonly rightSourceKey:string; readonly type:"inner"|"left"; readonly leftKey:string; readonly rightKey:string; readonly cardinality:"one-to-one"|"one-to-many"|"many-to-one"; readonly maxExpansion:number }
export type PartialSourceFailurePolicy="fail-whole-read"|"allow-partial-with-explicit-metadata"
export interface AggregatePermission { readonly operation:"count"|"distinct-count"|"min"|"max"|"sum"|"average"; readonly sourceKey:string; readonly field?:string; readonly groupBy?:readonly string[] }
export interface CompiledMultiSourceReadPlan { readonly key:string; readonly version:number; readonly sources:readonly CompiledReadSourcePlan[]; readonly joins:readonly CompiledReadJoin[]; readonly consistency:MultiSourceConsistency; readonly partialFailurePolicy:PartialSourceFailurePolicy; readonly aggregatePermissions:readonly AggregatePermission[]; readonly budget:QueryBudget; readonly maxSourceRows:number; readonly maxOutputRows:number }
export interface ReadSourceResult { readonly rows:readonly Readonly<Record<string,unknown>>[]; readonly consistency:ReadConsistency; readonly snapshotToken?:string }
export interface ReadModelExecutionContext { readonly signal:AbortSignal; readonly deadline:number; readonly now?:()=>number }
export interface ExecuteReadModelOptions { readonly signal?:AbortSignal; readonly deadline?:number; readonly timeoutMs?:number; readonly now?:()=>number }
export interface ReadSourceExecutor { readonly sourceKey:string; execute(source:CompiledReadSourcePlan,context:ReadModelExecutionContext):Promise<ReadSourceResult> }
export interface MultiSourceReadMetadata { readonly consistency:MultiSourceConsistency; readonly sourceConsistency:Readonly<Record<string,ReadConsistency>>; readonly failedSources:readonly string[]; readonly missingData:boolean; readonly incompleteAggregates:boolean }
export interface MultiSourceReadResult { readonly rows:readonly Readonly<Record<string,unknown>>[]; readonly metadata:MultiSourceReadMetadata }
