import { ConfigurationError } from "../domain/errors"
import { evaluatePredicate } from "../domain/evaluatePredicate"
import { defineReadModel, MAX_READ_MODEL_INDEXED_ROWS } from "./defineReadModel"
import { ReadModelCancelledError, ReadModelDeadlineExceededError } from "./errors"
import type { CompiledMultiSourceReadPlan, CompiledReadJoin, ExecuteReadModelOptions, MultiSourceReadResult, ReadModelExecutionContext, ReadSourceExecutor, ReadSourceResult } from "./types"

export const DEFAULT_READ_MODEL_TIMEOUT_MS = 30_000
export const MAX_READ_MODEL_TIMEOUT_MS = 300_000

const rank={eventual:0,session:1,strong:2} as const

function sanitize(rows:readonly Readonly<Record<string,unknown>>[],source:CompiledMultiSourceReadPlan["sources"][number]):Readonly<Record<string,unknown>>[]{
  return rows.filter(row=>evaluatePredicate(row as Record<string,unknown>,source.mandatoryPredicate)).map(row=>Object.freeze(Object.fromEntries([...source.readableFields].filter(field=>Object.hasOwn(row,field)).map(field=>[field,row[field]]))))
}

function isJoinKey(value:unknown):boolean {
  return value!==undefined&&value!==null&&!(typeof value==="number"&&Number.isNaN(value))
}

function joinRows(left:readonly Record<string,Readonly<Record<string,unknown>>>[],right:readonly Readonly<Record<string,unknown>>[],join:CompiledReadJoin,maxOutputRows:number,indexedRows:{value:number}):Record<string,Readonly<Record<string,unknown>>>[]{
  if(indexedRows.value+right.length>MAX_READ_MODEL_INDEXED_ROWS) throw new ConfigurationError(`Read-model indexed row budget exceeded (${MAX_READ_MODEL_INDEXED_ROWS})`)
  indexedRows.value+=right.length
  const index=new Map<unknown,Readonly<Record<string,unknown>>[]>()
  for(const candidate of right){
    if(!Object.hasOwn(candidate,join.rightKey)) continue
    const key=candidate[join.rightKey]
    if(!isJoinKey(key)) continue
    const matches=index.get(key)
    if(matches) matches.push(candidate)
    else index.set(key,[candidate])
  }

  const output:Record<string,Readonly<Record<string,unknown>>>[]=[]
  for(const row of left){
    const leftRecord=row[join.leftSourceKey]
    const leftValue=leftRecord&&Object.hasOwn(leftRecord,join.leftKey)?leftRecord[join.leftKey]:undefined
    const matches=isJoinKey(leftValue)?index.get(leftValue):undefined
    const matchCount=matches?.length??0
    if(matchCount>join.maxExpansion||(join.cardinality!=="one-to-many"&&matchCount>1)) throw new ConfigurationError("Read-model join expansion budget exceeded")
    const appended=Math.max(matchCount,join.type==="left"?1:0)
    if(output.length+appended>maxOutputRows) throw new ConfigurationError("Read-model output row budget exceeded")
    if(!matches){
      if(join.type==="left") output.push({...row,[join.rightSourceKey]:Object.freeze({})})
      continue
    }
    for(const match of matches) output.push({...row,[join.rightSourceKey]:match})
  }
  return output
}

function settleSources(plan:CompiledMultiSourceReadPlan,executorMap:ReadonlyMap<string,ReadSourceExecutor>,context:ReadModelExecutionContext):{promise:Promise<PromiseSettledResult<ReadSourceResult>[]>; release:()=>void} {
  let active=true
  let count=0
  const values:Array<PromiseSettledResult<ReadSourceResult>>=[]
  let resolveAll:(values:PromiseSettledResult<ReadSourceResult>[])=>void=()=>{}
  const promise=new Promise<PromiseSettledResult<ReadSourceResult>[]>(resolve=>{resolveAll=resolve})
  plan.sources.forEach((source,index)=>{
    Promise.resolve().then(()=>executorMap.get(source.sourceKey)!.execute(source,context)).then(
      value=>{
        if(!active) return
        values[index]={status:"fulfilled",value}
        if(++count===plan.sources.length) resolveAll(values)
      },
      reason=>{
        // Keep this rejection handler attached even after release so late failures are observed.
        if(!active) return
        values[index]={status:"rejected",reason}
        if(++count===plan.sources.length) resolveAll(values)
      },
    )
  })
  return {promise,release:()=>{active=false;values.length=0}}
}

function executionContext(options:ExecuteReadModelOptions):{context:ReadModelExecutionContext; controller:AbortController; removeParent:()=>void; clearDeadline:()=>void; clearCancellation:()=>void; cancellation:Promise<never>} {
  const now=options.now??Date.now
  if(typeof now!=="function") throw new ConfigurationError("Read-model now must be a function")
  const startedAt=now()
  if(!Number.isFinite(startedAt)) throw new ConfigurationError("Read-model clock returned an invalid time")
  if(options.signal!==undefined&&(!(options.signal instanceof AbortSignal))) throw new ConfigurationError("Read-model signal must be an AbortSignal")
  if(options.deadline!==undefined&&!Number.isFinite(options.deadline)) throw new ConfigurationError("Read-model deadline must be finite")
  if(options.timeoutMs!==undefined&&(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>MAX_READ_MODEL_TIMEOUT_MS)) throw new ConfigurationError(`Read-model timeout must be between 1 and ${MAX_READ_MODEL_TIMEOUT_MS} milliseconds`)

  const timeoutMs=options.timeoutMs??(options.deadline===undefined?DEFAULT_READ_MODEL_TIMEOUT_MS:undefined)
  const timeoutDeadline=timeoutMs===undefined?Number.POSITIVE_INFINITY:startedAt+timeoutMs
  const deadline=Math.min(options.deadline??Number.POSITIVE_INFINITY,timeoutDeadline,startedAt+MAX_READ_MODEL_TIMEOUT_MS)
  if(deadline<=startedAt) throw new ReadModelDeadlineExceededError(deadline)

  const controller=new AbortController()
  const cancel=(reason?:unknown)=>controller.abort(reason instanceof ReadModelCancelledError?reason:new ReadModelCancelledError(reason))
  const parent=options.signal
  const onParentAbort=()=>cancel(parent?.reason)
  if(parent?.aborted) throw new ReadModelCancelledError(parent.reason)
  parent?.addEventListener("abort",onParentAbort,{once:true})

  let timeout:ReturnType<typeof setTimeout>|undefined
  const onDeadline=()=>controller.abort(new ReadModelDeadlineExceededError(deadline))
  timeout=setTimeout(onDeadline,deadline-startedAt)
  let rejectCancellation:(reason?:unknown)=>void=()=>{}
  const onChildAbort=()=>rejectCancellation(controller.signal.reason)
  const cancellation=new Promise<never>((_resolve,reject)=>{rejectCancellation=reject})
  controller.signal.addEventListener("abort",onChildAbort,{once:true})
  return {
    context:Object.freeze({signal:controller.signal,deadline,...(options.now?{now}: {})}),
    controller,
    removeParent:()=>parent?.removeEventListener("abort",onParentAbort),
    clearDeadline:()=>{if(timeout!==undefined){clearTimeout(timeout);timeout=undefined}},
    clearCancellation:()=>controller.signal.removeEventListener("abort",onChildAbort),
    cancellation,
  }
}

export async function executeReadModel(plan:CompiledMultiSourceReadPlan,executors:readonly ReadSourceExecutor[],options:ExecuteReadModelOptions={}):Promise<MultiSourceReadResult>{
  plan=defineReadModel(plan)
  if(new Set(executors.map(executor=>executor.sourceKey)).size!==executors.length)throw new ConfigurationError("Duplicate source executor")
  for(const source of plan.sources)if(!executors.some(executor=>executor.sourceKey===source.sourceKey&&typeof executor.execute==="function"))throw new ConfigurationError(`Missing source executor: ${source.sourceKey}`)
  const execution=executionContext(options)
  let sourceSettlement:{promise:Promise<PromiseSettledResult<ReadSourceResult>[]>;release:()=>void}|undefined
  try {
    const executorMap=new Map(executors.map(executor=>[executor.sourceKey,executor]))
    sourceSettlement=settleSources(plan,executorMap,execution.context)
    const settled=await Promise.race([sourceSettlement.promise,execution.cancellation])
    const failed:string[]=[]
    const results=new Map<string,ReadSourceResult>()
    const sourceConsistency:Record<string,"strong"|"session"|"eventual">=Object.create(null)
    settled.forEach((item,index)=>{const source=plan.sources[index]!;if(item.status==="rejected"){failed.push(source.sourceKey);return}if(!item.value||!Array.isArray(item.value.rows)||!Object.hasOwn(rank,item.value.consistency)||item.value.rows.some(row=>!row||typeof row!=="object"||Array.isArray(row)))throw new ConfigurationError(`Invalid source result or consistency: ${source.sourceKey}`);if(item.value.rows.length>plan.maxSourceRows)throw new ConfigurationError(`Source row budget exceeded: ${source.sourceKey}`);if(rank[item.value.consistency]<rank[source.consistency])throw new ConfigurationError(`Source consistency requirement was not satisfied: ${source.sourceKey}`);results.set(source.sourceKey,item.value);sourceConsistency[source.sourceKey]=item.value.consistency})
    if(failed.length&&plan.partialFailurePolicy==="fail-whole-read")throw new ConfigurationError(`Read-model source failure: ${failed.join(",")}`)
    if(plan.consistency.kind==="application-defined-snapshot"&&failed.length===0){const tokens=[...results.values()].map(value=>value.snapshotToken);if(tokens.some(token=>typeof token!=="string"||!token)||new Set(tokens).size!==1)throw new ConfigurationError("Application-defined snapshot token mismatch")}
    const available=plan.sources.filter(source=>results.has(source.sourceKey))
    const first=available[0]
    let rows:Record<string,Readonly<Record<string,unknown>>>[]=first?sanitize(results.get(first.sourceKey)!.rows,first).map(row=>({[first.sourceKey]:row})):[]
    const indexedRows={value:0}
    for(const join of plan.joins){if(failed.includes(join.leftSourceKey)||failed.includes(join.rightSourceKey))continue;const rightSource=plan.sources.find(source=>source.sourceKey===join.rightSourceKey)!;rows=joinRows(rows,sanitize(results.get(join.rightSourceKey)!.rows,rightSource),join,plan.maxOutputRows,indexedRows)}
    if(rows.length>plan.maxOutputRows)throw new ConfigurationError("Read-model output row budget exceeded")
    return Object.freeze({rows:Object.freeze(rows.map(Object.freeze)),metadata:Object.freeze({consistency:plan.consistency,sourceConsistency:Object.freeze(sourceConsistency),failedSources:Object.freeze(failed),missingData:failed.length>0,incompleteAggregates:failed.length>0&&plan.aggregatePermissions.length>0})})
  } finally {
    sourceSettlement?.release()
    execution.clearDeadline()
    execution.removeParent()
    execution.clearCancellation()
  }
}
