import { afterEach,describe,expect,it,vi } from "vitest"
import { expectNearLinear } from "../../__tests__/timing"
import { Predicate } from "../../domain/predicate"
import { encodeExecutionScopeId } from "../../domain/executionScope"
import { DEFAULT_QUERY_BUDGET } from "../../query/queryBudget"
import { defineReadModel,executeReadModel,MAX_READ_MODEL_JOINS,MAX_READ_MODEL_OUTPUT_ROWS,MAX_READ_MODEL_SOURCE_ROWS,MAX_READ_MODEL_SOURCES,MAX_READ_MODEL_TIMEOUT_MS,ReadModelCancelledError,ReadModelDeadlineExceededError,type CompiledMultiSourceReadPlan } from ".."
import { validateSearchRequest } from "../../query/search"

const scope={kind:"tenant",tenantId:"t1"} as const
const authority={scope,scopeId:encodeExecutionScopeId(scope)}
const source=(sourceKey:string,predicate=Predicate.eq("tenantId","t1"))=>({sourceKey,datasourceKey:sourceKey,authority,mandatoryPredicate:predicate,readableFields:new Set(["id","tenantId","customerId","name","amount"]),filterableFields:new Set(["tenantId"]),sortableFields:new Set(["name"]),aggregatableFields:new Set(["amount"]),consistency:"eventual" as const,maxStalenessMs:100})
const plan=(overrides:Partial<CompiledMultiSourceReadPlan>={}):CompiledMultiSourceReadPlan=>defineReadModel({key:"report",version:1,sources:[source("orders"),source("customers")],joins:[{leftSourceKey:"orders",rightSourceKey:"customers",type:"inner",leftKey:"customerId",rightKey:"id",cardinality:"many-to-one",maxExpansion:1}],consistency:{kind:"eventual"},partialFailurePolicy:"fail-whole-read",aggregatePermissions:[],budget:DEFAULT_QUERY_BUDGET,maxSourceRows:10,maxOutputRows:10,...overrides})

describe("R1 authorized read models",()=>{
  it("applies every source predicate, field projection and authorized join",async()=>{const result=await executeReadModel(plan(),[{sourceKey:"orders",execute:async()=>({consistency:"eventual",rows:[{id:"o1",tenantId:"t1",customerId:"c1",amount:2,secret:"x"},{id:"o2",tenantId:"t2",customerId:"c1"}]})},{sourceKey:"customers",execute:async()=>({consistency:"eventual",rows:[{id:"c1",tenantId:"t1",name:"A",secret:"y"}]})}]);expect(result.rows).toEqual([{orders:{id:"o1",tenantId:"t1",customerId:"c1",amount:2},customers:{id:"c1",tenantId:"t1",name:"A"}}])})
  it("rejects unauthorized join and aggregate fields",()=>{expect(()=>plan({joins:[{leftSourceKey:"orders",rightSourceKey:"customers",type:"inner",leftKey:"secret",rightKey:"id",cardinality:"one-to-one",maxExpansion:1}]})).toThrow("Join key");expect(()=>plan({aggregatePermissions:[{operation:"sum",sourceKey:"orders",field:"secret"}]})).toThrow("Aggregate field")})
  it("fails the whole read by default",async()=>{await expect(executeReadModel(plan(),[{sourceKey:"orders",execute:async()=>{throw new Error("down")}},{sourceKey:"customers",execute:async()=>({consistency:"eventual",rows:[]})}])).rejects.toThrow("source failure")})
  it("marks explicitly allowed partial results and incomplete aggregates",async()=>{const result=await executeReadModel(plan({partialFailurePolicy:"allow-partial-with-explicit-metadata",aggregatePermissions:[{operation:"count",sourceKey:"orders"}]}),[{sourceKey:"orders",execute:async()=>{throw new Error("down")}},{sourceKey:"customers",execute:async()=>({consistency:"eventual",rows:[]})}]);expect(result.metadata).toMatchObject({failedSources:["orders"],missingData:true,incompleteAggregates:true})})
  it("rejects consistency downgrade and excessive join expansion",async()=>{const strong=plan({sources:[{...source("orders"),consistency:"strong"},source("customers")]});await expect(executeReadModel(strong,[{sourceKey:"orders",execute:async()=>({consistency:"eventual",rows:[]})},{sourceKey:"customers",execute:async()=>({consistency:"eventual",rows:[]})}])).rejects.toThrow("consistency");await expect(executeReadModel(plan(),[{sourceKey:"orders",execute:async()=>({consistency:"eventual",rows:[{id:"o",tenantId:"t1",customerId:"c"}]})},{sourceKey:"customers",execute:async()=>({consistency:"eventual",rows:[{id:"c",tenantId:"t1"},{id:"c",tenantId:"t1"}]})}])).rejects.toThrow("expansion")})
  it("requires bounded-staleness proof",()=>{expect(()=>plan({consistency:{kind:"bounded-staleness",maxStalenessMs:50}})).toThrow("bounded-staleness")})
  it("validates compiled SearchPort fields, budgets and consistency",()=>{const capability={portKey:"search",searchableFields:new Set(["name"]),filterableFields:new Set(["tenantId"]),sortableFields:new Set(["name"]),consistency:["eventual" as const],maxQueryBytes:10,maxResults:5};expect(()=>validateSearchRequest(capability,{scope,text:"abc",fields:["secret"],limit:1,consistency:"eventual"})).toThrow("not authorized");expect(()=>validateSearchRequest(capability,{scope,text:"abc",fields:["name"],limit:1,consistency:"eventual"})).not.toThrow()})
  it("rejects a source result beyond maxSourceRows",async()=>{await expect(executeReadModel(plan({maxSourceRows:1}),[{sourceKey:"orders",execute:async()=>({consistency:"eventual",rows:[{id:"1",tenantId:"t1"},{id:"2",tenantId:"t1"}]})},{sourceKey:"customers",execute:async()=>({consistency:"eventual",rows:[]})}])).rejects.toThrow("Source row budget")})
  it("rejects output beyond maxOutputRows without silent truncation",async()=>{await expect(executeReadModel(plan({joins:[],sources:[source("orders")],maxOutputRows:1}),[{sourceKey:"orders",execute:async()=>({consistency:"eventual",rows:[{id:"1",tenantId:"t1"},{id:"2",tenantId:"t1"}]})}])).rejects.toThrow("output row budget")})
  it("requires one shared application snapshot token",async()=>{const snapshot=plan({consistency:{kind:"application-defined-snapshot",coordinatorKey:"snapshot",snapshotTokenFormat:"opaque"},sources:[{...source("orders"),snapshotCoordinatorKeys:new Set(["snapshot"])},{...source("customers"),snapshotCoordinatorKeys:new Set(["snapshot"])}]});await expect(executeReadModel(snapshot,[{sourceKey:"orders",execute:async()=>({consistency:"eventual",snapshotToken:"a",rows:[]})},{sourceKey:"customers",execute:async()=>({consistency:"eventual",snapshotToken:"b",rows:[]})}])).rejects.toThrow("snapshot token mismatch")})
})


describe("release read-model hardening", () => {
  it("snapshots source authority, joins, and field sets", () => {
    const original = source("orders")
    const compiled = plan({ sources: [original], joins: [] })
    original.readableFields.add("secret")
    expect(compiled.sources[0]!.readableFields.has("secret")).toBe(false)
    expect(Object.isFrozen(compiled.sources[0]!.authority.scope)).toBe(true)
    expect((compiled.sources[0]!.readableFields as Set<string>).add).toBeUndefined()
  })
  it("rejects unknown policies, source consistency and NaN staleness", () => {
    expect(() => plan({ partialFailurePolicy: "typo" as never })).toThrow("policy")
    expect(() => plan({ sources: [{ ...source("orders"), consistency: "typo" as never }], joins: [] })).toThrow("consistency")
    expect(() => plan({ sources: [{ ...source("orders"), maxStalenessMs: NaN }], joins: [], consistency: { kind: "bounded-staleness", maxStalenessMs: 100 } })).toThrow("staleness")
  })
  it("rejects disconnected sources instead of silently omitting data", () => {
    expect(() => plan({ joins: [] })).toThrow("supported join")
  })
  it("rejects unknown returned consistency before emitting rows", async () => {
    await expect(executeReadModel(plan({ sources: [source("orders")], joins: [] }), [{ sourceKey: "orders", execute: async () => ({ consistency: "unknown" as never, rows: [] }) }])).rejects.toThrow("consistency")
  })
  it("handles synchronous source failures through the declared partial policy", async () => {
    const result = await executeReadModel(plan({ partialFailurePolicy: "allow-partial-with-explicit-metadata" }), [{ sourceKey: "orders", execute: () => { throw new Error("down") } }, { sourceKey: "customers", execute: async () => ({ consistency: "eventual", rows: [] }) }])
    expect(result.metadata.failedSources).toEqual(["orders"])
  })
  it("preflights all executors before starting any source", async () => {
    let started = false
    await expect(executeReadModel(plan(), [{ sourceKey: "orders", execute: async () => { started = true; return { consistency: "eventual", rows: [] } } }])).rejects.toThrow("Missing source")
    expect(started).toBe(false)
  })
  it("never joins missing keys to missing keys", async () => {
    const result = await executeReadModel(plan(), [{ sourceKey: "orders", execute: async () => ({ consistency: "eventual", rows: [{ tenantId: "t1" }] }) }, { sourceKey: "customers", execute: async () => ({ consistency: "eventual", rows: [{ tenantId: "t1" }] }) }])
    expect(result.rows).toEqual([])
  })
  it("enforces output budget before materializing join expansion", async () => {
    await expect(executeReadModel(plan({ maxOutputRows: 1, joins: [{ leftSourceKey: "orders", rightSourceKey: "customers", type: "inner", leftKey: "customerId", rightKey: "id", cardinality: "one-to-many", maxExpansion: 10 }] }), [{ sourceKey: "orders", execute: async () => ({ consistency: "eventual", rows: [{ tenantId: "t1", customerId: "c" }] }) }, { sourceKey: "customers", execute: async () => ({ consistency: "eventual", rows: [{ tenantId: "t1", id: "c" }, { tenantId: "t1", id: "c" }] }) }])).rejects.toThrow("output row budget")
  })
})

describe("bounded and cancellable read-model execution",()=>{
  afterEach(()=>vi.useRealTimers())

  it("does not invoke providers when the caller is already cancelled",async()=>{
    const controller=new AbortController()
    controller.abort("stop")
    const execute=vi.fn(async()=>({consistency:"eventual" as const,rows:[]}))
    await expect(executeReadModel(plan({sources:[source("orders")],joins:[]}),[{sourceKey:"orders",execute}],{signal:controller.signal})).rejects.toBeInstanceOf(ReadModelCancelledError)
    expect(execute).not.toHaveBeenCalled()
  })

  it("propagates one signal and effective absolute deadline to every provider",async()=>{
    const contexts:Array<{signal:AbortSignal;deadline:number}>=[]
    await executeReadModel(plan(),[
      {sourceKey:"orders",execute:async(_source,context)=>{contexts.push(context);return {consistency:"eventual",rows:[]}}},
      {sourceKey:"customers",execute:async(_source,context)=>{contexts.push(context);return {consistency:"eventual",rows:[]}}},
    ],{now:()=>1_000,deadline:2_000,timeoutMs:500})
    expect(contexts).toHaveLength(2)
    expect(contexts[0]!.signal).toBe(contexts[1]!.signal)
    expect(contexts.map(context=>context.deadline)).toEqual([1_500,1_500])
    expect(contexts[0]!.signal.aborted).toBe(false)
  })

  it("cancels all pending providers and ignores the partial policy",async()=>{
    const controller=new AbortController()
    let propagated:AbortSignal|undefined
    const pending=executeReadModel(plan({partialFailurePolicy:"allow-partial-with-explicit-metadata"}),[
      {sourceKey:"orders",execute:(_source,context)=>{propagated=context.signal;return new Promise(()=>{})}},
      {sourceKey:"customers",execute:()=>new Promise(()=>{})},
    ],{signal:controller.signal,timeoutMs:1_000})
    await Promise.resolve()
    controller.abort("caller stopped")
    await expect(pending).rejects.toBeInstanceOf(ReadModelCancelledError)
    expect(propagated?.aborted).toBe(true)
  })

  it("rejects an elapsed deadline before provider invocation",async()=>{
    const execute=vi.fn(async()=>({consistency:"eventual" as const,rows:[]}))
    await expect(executeReadModel(plan({sources:[source("orders")],joins:[]}),[{sourceKey:"orders",execute}],{now:()=>10,deadline:10})).rejects.toBeInstanceOf(ReadModelDeadlineExceededError)
    expect(execute).not.toHaveBeenCalled()
  })

  it("terminates a never-settling source at the deadline and observes a late rejection",async()=>{
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    let rejectLate:(reason?:unknown)=>void=()=>{}
    const pending=executeReadModel(plan({sources:[source("orders")],joins:[]}),[{sourceKey:"orders",execute:(_source,context)=>new Promise((_resolve,reject)=>{
      rejectLate=reject
      expect(context.deadline).toBe(1_010)
      expect(context.signal.aborted).toBe(false)
    })}],{timeoutMs:10})
    const rejection=expect(pending).rejects.toBeInstanceOf(ReadModelDeadlineExceededError)
    await vi.advanceTimersByTimeAsync(10)
    await rejection
    rejectLate(new Error("late"))
    await Promise.resolve()
  })

  it("removes the parent abort listener and deadline timer after success",async()=>{
    vi.useFakeTimers()
    const controller=new AbortController()
    const add=vi.spyOn(controller.signal,"addEventListener")
    const remove=vi.spyOn(controller.signal,"removeEventListener")
    await executeReadModel(plan({sources:[source("orders")],joins:[]}),[{sourceKey:"orders",execute:async()=>({consistency:"eventual",rows:[]})}],{signal:controller.signal,timeoutMs:10})
    expect(add).toHaveBeenCalledWith("abort",expect.any(Function),{once:true})
    expect(remove).toHaveBeenCalledWith("abort",expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects invalid timeout configuration",async()=>{
    await expect(executeReadModel(plan({sources:[source("orders")],joins:[]}),[{sourceKey:"orders",execute:async()=>({consistency:"eventual",rows:[]})}],{timeoutMs:MAX_READ_MODEL_TIMEOUT_MS+1})).rejects.toThrow("timeout")
  })
})

describe("indexed read-model joins",()=>{
  const runJoin=(orders:readonly Record<string,unknown>[],customers:readonly Record<string,unknown>[],overrides:Partial<CompiledMultiSourceReadPlan>={})=>executeReadModel(plan(overrides),[
    {sourceKey:"orders",execute:async()=>({consistency:"eventual",rows:orders})},
    {sourceKey:"customers",execute:async()=>({consistency:"eventual",rows:customers})},
  ])

  it("supports no-match, one-to-one, one-to-many and left joins",async()=>{
    await expect(runJoin([{tenantId:"t1",customerId:"none"}],[{tenantId:"t1",id:"c"}])).resolves.toMatchObject({rows:[]})
    await expect(runJoin([{tenantId:"t1",customerId:"c"}],[{tenantId:"t1",id:"c"}])).resolves.toMatchObject({rows:[{orders:{customerId:"c"},customers:{id:"c"}}]})
    const many=await runJoin([{tenantId:"t1",customerId:"c"}],[{tenantId:"t1",id:"c",name:"A"},{tenantId:"t1",id:"c",name:"B"}],{joins:[{leftSourceKey:"orders",rightSourceKey:"customers",type:"inner",leftKey:"customerId",rightKey:"id",cardinality:"one-to-many",maxExpansion:2}]})
    expect(many.rows).toHaveLength(2)
    const left=await runJoin([{tenantId:"t1",customerId:"none"}],[],{joins:[{leftSourceKey:"orders",rightSourceKey:"customers",type:"left",leftKey:"customerId",rightKey:"id",cardinality:"many-to-one",maxExpansion:1}]})
    expect(left.rows).toEqual([{orders:{tenantId:"t1",customerId:"none"},customers:{}}])
  })

  it("preserves nullish, NaN, and object-identity key semantics",async()=>{
    const shared={key:true}
    const distinct={key:true}
    const result=await runJoin([
      {tenantId:"t1",customerId:null},
      {tenantId:"t1",customerId:undefined},
      {tenantId:"t1",customerId:Number.NaN},
      {tenantId:"t1",customerId:shared},
      {tenantId:"t1",customerId:distinct},
    ],[
      {tenantId:"t1",id:null},
      {tenantId:"t1",id:undefined},
      {tenantId:"t1",id:Number.NaN},
      {tenantId:"t1",id:shared,name:"same"},
      {tenantId:"t1",id:{key:true},name:"equal-shape"},
    ])
    expect(result.rows).toHaveLength(1)
    expect((result.rows[0]!.customers as Record<string,unknown>).name).toBe("same")
  })

  it("enforces absolute definition ceilings",()=>{
    expect(()=>plan({maxSourceRows:MAX_READ_MODEL_SOURCE_ROWS+1})).toThrow("hard limit")
    expect(()=>plan({maxOutputRows:MAX_READ_MODEL_OUTPUT_ROWS+1})).toThrow("hard limit")
    expect(()=>plan({sources:Array.from({length:MAX_READ_MODEL_SOURCES+1},(_,index)=>source(`s${index}`)),joins:[]})).toThrow("source count")
    expect(()=>plan({joins:Array.from({length:MAX_READ_MODEL_JOINS+1},()=>({leftSourceKey:"orders",rightSourceKey:"customers",type:"inner",leftKey:"customerId",rightKey:"id",cardinality:"many-to-one",maxExpansion:1}))})).toThrow("join count")
  })

  it("indexes a 5,000 by 5,000 no-match join in near-linear time",async()=>{
    // The cost of 5,000 rows per side is compared with the cost of 1,250: a nested-loop join would grow sixteen-fold.
    await expectNearLinear((count)=>{
      const orders=Array.from({length:count},(_,index)=>({tenantId:"t1",customerId:`left-${index}`}))
      const customers=Array.from({length:count},(_,index)=>({tenantId:"t1",id:`right-${index}`}))
      return async()=>{expect((await runJoin(orders,customers,{maxSourceRows:count,maxOutputRows:count})).rows).toHaveLength(0)}
    },{size:5_000})
  })
})

describe("read-model final pass",()=>{
  it("joins Date keys by instant",async()=>{
    const joined=await executeReadModel(plan(),[{sourceKey:"orders",execute:async()=>({consistency:"eventual",rows:[{id:"o1",tenantId:"t1",customerId:new Date(5)}]})},{sourceKey:"customers",execute:async()=>({consistency:"eventual",rows:[{id:new Date(5),tenantId:"t1",name:"A"}]})}])
    expect(joined.rows).toHaveLength(1)
  })
  it("checks snapshot tokens of the sources that succeeded even when one failed",async()=>{
    const coordinated=(key:string)=>({...source(key),snapshotCoordinatorKeys:new Set(["snapshot"])})
    const partial=plan({partialFailurePolicy:"allow-partial-with-explicit-metadata",joins:[{leftSourceKey:"orders",rightSourceKey:"customers",type:"left",leftKey:"customerId",rightKey:"id",cardinality:"many-to-one",maxExpansion:1},{leftSourceKey:"orders",rightSourceKey:"payments",type:"left",leftKey:"customerId",rightKey:"id",cardinality:"many-to-one",maxExpansion:1}],consistency:{kind:"application-defined-snapshot",coordinatorKey:"snapshot",snapshotTokenFormat:"opaque"},sources:[coordinated("orders"),coordinated("customers"),coordinated("payments")]})
    await expect(executeReadModel(partial,[{sourceKey:"orders",execute:async()=>({consistency:"eventual",snapshotToken:"T1",rows:[]})},{sourceKey:"customers",execute:async()=>({consistency:"eventual",snapshotToken:"T2",rows:[]})},{sourceKey:"payments",execute:async()=>{throw new Error("down")}}])).rejects.toThrow("snapshot token mismatch")
  })
})
