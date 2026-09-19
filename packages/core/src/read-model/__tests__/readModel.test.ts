import { describe,expect,it } from "vitest"
import { Predicate } from "../../domain/predicate"
import { encodeExecutionScopeId } from "../../domain/executionScope"
import { DEFAULT_QUERY_BUDGET } from "../../query/queryBudget"
import { defineReadModel,executeReadModel,type CompiledMultiSourceReadPlan } from ".."
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
