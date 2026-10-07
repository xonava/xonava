import { validateExecutionScope, type ExecutionScope } from "../domain/executionScope"
import type { ReadConsistency } from "../query/readConsistency"
import { ConfigurationError, TimeoutError, ValidationError } from "../domain/errors"
import type { Clock } from "../kernel/clock"
import { abortSignalError } from "../operation/deadline"
import { assertReadConsistencySupported } from "../query/readConsistency"
import { cloneAndFreezeDefinition } from "../kernel/definitionIntegrity"

export interface SearchCapability { readonly portKey: string; readonly searchableFields: ReadonlySet<string>; readonly filterableFields: ReadonlySet<string>; readonly sortableFields: ReadonlySet<string>; readonly consistency: readonly ReadConsistency[]; readonly maxQueryBytes: number; readonly maxResults: number }
export interface SearchRequest { readonly scope: ExecutionScope; readonly text: string; readonly fields: readonly string[]; readonly filter?: Readonly<Record<string,unknown>>; readonly sort?: readonly {field:string;direction:"asc"|"desc"}[]; readonly limit: number; readonly consistency: ReadConsistency; readonly signal?: AbortSignal; readonly deadline?: number }
export interface SearchHit { readonly id: string; readonly score: number; readonly fields: Readonly<Record<string,unknown>> }
export interface SearchResult { readonly hits: readonly SearchHit[]; readonly consistency: ReadConsistency; readonly total?: number }
export interface SearchPort { readonly capability: SearchCapability; search(request:SearchRequest):Promise<SearchResult> }

/** Validates a search request before dispatch. `now` (epoch ms or a Clock) defaults to the system time and is read only when a deadline is set. */
export function validateSearchRequest(capability:SearchCapability,request:SearchRequest,now?:number|Clock):void {
  validateSearchRequestShape(capability,request)
  if(request.signal?.aborted)throw abortSignalError(request.signal,"Search request is cancelled")
  if(request.deadline!==undefined){
    const current=now===undefined?Date.now():typeof now==="number"?now:now.now().getTime()
    if(!Number.isFinite(current))throw new ConfigurationError("Search clock must return a finite time")
    if(current>=request.deadline)throw new TimeoutError("Search request deadline expired")
  }
}

function validateSearchRequestShape(capability:SearchCapability,request:SearchRequest):void {
  if(!capability||typeof capability!=="object"||typeof capability.portKey!=="string"||!capability.portKey.trim())throw new ConfigurationError("Search capability portKey is required")
  if(!Number.isSafeInteger(capability.maxQueryBytes)||capability.maxQueryBytes<1||!Number.isSafeInteger(capability.maxResults)||capability.maxResults<1)throw new ConfigurationError("Search capability budgets must be positive safe integers")
  if(typeof capability.searchableFields?.has!=="function"||typeof capability.filterableFields?.has!=="function"||typeof capability.sortableFields?.has!=="function"||!Array.isArray(capability.consistency))throw new ConfigurationError("Search capability field and consistency declarations are invalid")
  if(!request||typeof request!=="object"||typeof request.text!=="string"||!Array.isArray(request.fields))throw new ValidationError("Search request is invalid")
  validateExecutionScope(request.scope)
  if(request.deadline!==undefined&&!Number.isFinite(request.deadline))throw new ValidationError("Search request deadline is invalid")
  if(new TextEncoder().encode(request.text).byteLength>capability.maxQueryBytes)throw new ValidationError("Search query exceeds byte budget")
  if(!Number.isSafeInteger(request.limit)||request.limit<1||request.limit>capability.maxResults)throw new ValidationError("Search result limit exceeds capability")
  if(new Set(request.fields).size!==request.fields.length||request.fields.some(field=>typeof field!=="string"||!field.trim()))throw new ValidationError("Search fields must be unique non-empty strings")
  for(const field of request.fields)if(!capability.searchableFields.has(field))throw new ValidationError(`Search field is not authorized: ${field}`)
  if(request.filter!==undefined&&(request.filter===null||typeof request.filter!=="object"||Array.isArray(request.filter)))throw new ValidationError("Search filter must be an object")
  for(const field of Object.keys(request.filter??{}))if(!capability.filterableFields.has(field))throw new ValidationError(`Search filter field is not authorized: ${field}`)
  if(request.sort!==undefined&&!Array.isArray(request.sort))throw new ValidationError("Search sort must be an array")
  const sorts=request.sort??[];if(new Set(sorts.map(sort=>sort?.field)).size!==sorts.length)throw new ValidationError("Search sort fields must be unique")
  for(const sort of sorts)if(!sort||typeof sort.field!=="string"||!sort.field.trim()||(sort.direction!=="asc"&&sort.direction!=="desc")||!capability.sortableFields.has(sort.field))throw new ValidationError(`Search sort field is not authorized: ${String(sort?.field)}`)
  assertReadConsistencySupported(request.consistency,capability.consistency)
}

export function validateSearchResult(capability:SearchCapability,request:SearchRequest,result:SearchResult):SearchResult{
  // The provider may legitimately finish after the deadline or a late abort, so
  // only the request shape is re-checked; result faults are provider contract
  // violations (server-side), not client input problems.
  validateSearchRequestShape(capability,request)
  if(!result||typeof result!=="object"||!Array.isArray(result.hits)||result.hits.length>request.limit)throw new ConfigurationError("Search provider returned an invalid or excessive result")
  if(result.consistency!==request.consistency)throw new ConfigurationError("Search provider did not satisfy requested consistency")
  if(result.total!==undefined&&(!Number.isSafeInteger(result.total)||result.total<result.hits.length))throw new ConfigurationError("Search provider returned an invalid total")
  const ids=new Set<string>()
  const requested=new Set(request.fields)
  const hits=result.hits.map(hit=>{
    if(!hit||typeof hit!=="object"||typeof hit.id!=="string"||!hit.id.trim()||ids.has(hit.id)||typeof hit.score!=="number"||!Number.isFinite(hit.score)||!hit.fields||typeof hit.fields!=="object"||Array.isArray(hit.fields))throw new ConfigurationError("Search provider returned an invalid hit")
    ids.add(hit.id)
    const fields:Record<string,unknown>={}
    for(const [field,value] of Object.entries(hit.fields)){
      if(!requested.has(field)||!capability.searchableFields.has(field))throw new ConfigurationError(`Search provider returned an unauthorized field: ${field}`)
      fields[field]=cloneAndFreezeDefinition(value,true)
    }
    return Object.freeze({id:hit.id,score:hit.score,fields:Object.freeze(fields)})
  })
  return Object.freeze({hits:Object.freeze(hits),consistency:result.consistency,...(result.total===undefined?{}:{total:result.total})})
}
