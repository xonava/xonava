import type { PredicateNode } from "../domain/predicate"
import type { EntityVersion } from "../serialization/version"
import { ValidationError } from "../domain/errors"

export type BulkMutationMode = "atomic" | "partial"

export interface VersionedBulkUpdate<T, TId = string> {
  readonly id: TId
  readonly expectedVersion: EntityVersion
  readonly values: Readonly<Partial<T>>
  /** Optional authorization/resource predicate compiled before execution. */
  readonly predicate?: PredicateNode
}

export interface VersionedBulkDelete<TId = string> {
  readonly id: TId
  readonly expectedVersion: EntityVersion
  readonly predicate?: PredicateNode
}

export type BulkMutationFailureCode = "not-found" | "stale-version" | "not-authorized" | "constraint" | "unknown"

export type BulkMutationItemResult<T, TId = string> =
  | { readonly id: TId; readonly status: "applied"; readonly value?: T }
  | { readonly id: TId; readonly status: "rejected"; readonly code: BulkMutationFailureCode }

export interface BulkMutationResult<T, TId = string> {
  readonly mode: BulkMutationMode
  readonly items: readonly BulkMutationItemResult<T, TId>[]
  readonly appliedCount: number
  readonly rejectedCount: number
}

/** Optional capability; adapters must not expose it without conformance evidence. */
export interface VersionedBulkPersistence<T, TId = string> {
  updateVersionedBatch(items: readonly VersionedBulkUpdate<T, TId>[], mode: BulkMutationMode): Promise<BulkMutationResult<T, TId>>
  deleteVersionedBatch(items: readonly VersionedBulkDelete<TId>[], mode: BulkMutationMode): Promise<BulkMutationResult<never, TId>>
}

export interface BulkMutationLimits { readonly maxItems: number }

export function assertBulkMutationInput<T extends {readonly id:unknown;readonly expectedVersion:EntityVersion}>(items:readonly T[],limits:BulkMutationLimits):void{
  if(!Number.isSafeInteger(limits.maxItems)||limits.maxItems<=0) throw new ValidationError("Bulk maxItems must be a positive safe integer.")
  if(items.length===0||items.length>limits.maxItems) throw new ValidationError(`Bulk item count must be between 1 and ${limits.maxItems}.`)
  const ids=new Set<unknown>();for(const item of items){if(ids.has(item.id)) throw new ValidationError("Bulk mutation contains duplicate identifiers.");ids.add(item.id);if(!Number.isSafeInteger(item.expectedVersion)||item.expectedVersion<1) throw new ValidationError("Bulk mutation expectedVersion must be a positive safe integer.")}
}

export function validateBulkMutationResult<T,TId>(requested:readonly {readonly id:TId}[],result:BulkMutationResult<T,TId>):BulkMutationResult<T,TId>{
  if (!result || !["atomic", "partial"].includes(result.mode) || !Array.isArray(result.items)) throw new ValidationError("Bulk mutation result mode or items are invalid.")
  if (!Number.isSafeInteger(result.appliedCount) || result.appliedCount < 0 || !Number.isSafeInteger(result.rejectedCount) || result.rejectedCount < 0) throw new ValidationError("Bulk mutation result counters are invalid.")
  for (const item of result.items) {
    if (!item || (item.status !== "applied" && item.status !== "rejected")) throw new ValidationError("Bulk mutation item status is invalid.")
    if (item.status === "rejected" && !["not-found", "stale-version", "not-authorized", "constraint", "unknown"].includes(item.code)) throw new ValidationError("Bulk mutation rejection code is invalid.")
  }
  if(result.items.length!==requested.length||result.appliedCount+result.rejectedCount!==result.items.length) throw new ValidationError("Bulk mutation result counts do not match the request.")
  let applied=0;let rejected=0
  result.items.forEach((item,index)=>{if(item.id!==requested[index]?.id) throw new ValidationError("Bulk mutation result order or identity does not match the request.");if(item.status==="applied")applied++;else rejected++})
  if(applied!==result.appliedCount||rejected!==result.rejectedCount) throw new ValidationError("Bulk mutation result counters are invalid.")
  if(result.mode==="atomic"&&applied>0&&rejected>0) throw new ValidationError("Atomic bulk mutation cannot report a partially applied result.")
  return Object.freeze({...result,items:Object.freeze(result.items.map(item=>Object.freeze({...item})))})
}
