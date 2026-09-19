import { describe, expect, it } from "vitest"
import { FrameworkDefinitionRegistry, compileFramework } from "../../bootstrap"
import { validateWorkingWindows } from "../../business-calendar"
import { ValidationError } from "../../domain"
import { validateFeatureFlagFact } from "../../feature-flags"
import { aggregateHealth } from "../../health"
import { validateQuotaDecision, validateQuotaRequest } from "../../quota"
import { validateSearchRequest, validateSearchResult } from "../../query"
import { DEFAULT_QUERY_BUDGET } from "../../query/queryBudget"
import { defineReadModel, executeReadModel } from "../../read-model"
import { Predicate } from "../../domain/predicate"
import { encodeExecutionScopeId } from "../../domain/executionScope"
import { compileEntity, defineEntity } from "../../entity"

describe("core hostile-boundary hardening", () => {
  it("normalizes malformed provider facts to framework validation errors", () => {
    expect(() => validateFeatureFlagFact({ evaluatedAt: null } as never)).toThrow(ValidationError)
    expect(() => aggregateHealth([{ key: 1 } as never], [], new Date())).toThrow(ValidationError)
    expect(() => validateWorkingWindows(new Date(), new Date(Date.now() + 1), [{ start: null, end: null } as never])).toThrow(ValidationError)
    expect(() => validateQuotaRequest({ quotaKey: 1 } as never)).toThrow(ValidationError)
    const quota=validateQuotaRequest({quotaKey:"api",subject:{scope:{kind:"tenant",tenantId:"t1"}},amount:1,limit:10,windowMs:1000})
    expect(Object.isFrozen(quota.subject)).toBe(true)
    expect(()=>validateQuotaDecision(quota,{allowed:true,used:1,remaining:8,resetAt:1})).toThrow("inconsistent")
    expect(validateQuotaDecision(quota,{allowed:true,used:1,remaining:9,resetAt:1})).toEqual({allowed:true,used:1,remaining:9,resetAt:1})
  })

  it("rejects malformed search capabilities and requests", () => {
    const capability = { portKey: "search", searchableFields: new Set(["name"]), filterableFields: new Set<string>(), sortableFields: new Set(["name"]), consistency: ["eventual" as const], maxQueryBytes: 10, maxResults: 2 }
    const request = { scope: { kind: "tenant", tenantId: "t1" } as const, text: "x", fields: ["name"], limit: 1, consistency: "eventual" as const }
    expect(() => validateSearchRequest({ ...capability, maxResults: Number.NaN }, request)).toThrow("budgets")
    expect(() => validateSearchRequest(capability, { ...request, fields: ["name", "name"] })).toThrow("unique")
    expect(() => validateSearchRequest(capability, { ...request, sort: [{ field: "name", direction: "sideways" }] } as never)).toThrow(ValidationError)
    expect(() => validateSearchResult(capability, request, { consistency: "eventual", hits: [{ id: "1", score: 1, fields: { secret: "x" } }] })).toThrow("unauthorized")
    expect(() => validateSearchResult(capability, request, { consistency: "eventual", hits: [{ id: "1", score: Number.NaN, fields: { name: "x" } }] })).toThrow("invalid hit")
    expect(validateSearchResult(capability, request, { consistency: "eventual", total: 1, hits: [{ id: "1", score: 1, fields: { name: "x" } }] }).hits).toHaveLength(1)
  })

  it("handles cyclic configuration without recursion failure and rejects exotic mutable containers", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const registry = new FrameworkDefinitionRegistry()
    registry.register({ kind: "policy", key: "cyclic", definitionVersion: 1, config: cyclic })
    const snapshot = registry.snapshot()[0]!.config as Record<string, unknown>
    expect(snapshot.self).toBe(snapshot)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(() => compileFramework(registry, { frameworkVersion: "2", sourceRevision: "revision" })).toThrow()
    expect(() => new FrameworkDefinitionRegistry().register({ kind: "policy", key: "map", definitionVersion: 1, config: { mutable: new Map() } })).toThrow(TypeError)
  })

  it("rejects single-source output beyond the declared row budget", async () => {
    const scope = { kind: "tenant", tenantId: "t1" } as const
    const plan = defineReadModel({ key: "bounded", version: 1, sources: [{ sourceKey: "items", datasourceKey: "db", authority: { scope, scopeId: encodeExecutionScopeId(scope) }, mandatoryPredicate: Predicate.eq("tenantId", "t1"), readableFields: new Set(["id", "tenantId"]), filterableFields: new Set(["tenantId"]), sortableFields: new Set(["id"]), aggregatableFields: new Set<string>(), consistency: "eventual" }], joins: [], consistency: { kind: "eventual" }, partialFailurePolicy: "fail-whole-read", aggregatePermissions: [], budget: DEFAULT_QUERY_BUDGET, maxSourceRows: 2, maxOutputRows: 1 })
    await expect(executeReadModel(plan, [{ sourceKey: "items", execute: async () => ({ consistency: "eventual", rows: [{ id: "1", tenantId: "t1" }, { id: "2", tenantId: "t1" }] }) }])).rejects.toThrow("output row budget")
  })

  it("keeps valid plain bootstrap definitions compilable", () => {
    const registry = new FrameworkDefinitionRegistry()
    registry.register({ kind: "policy", key: "valid", definitionVersion: 1, config: { nested: { enabled: true } } })
    expect(() => compileFramework(registry, { frameworkVersion: "2", sourceRevision: "revision" })).not.toThrow()
  })

  it("requires full-text entities to bind their declared SearchPort during compilation", () => {
    const schema={} as never
    const entity=defineEntity({moduleKey:"catalog",entity:{name:"item",fields:{id:{type:"string" as const},tenantId:{type:"string" as const},name:{type:"string" as const}},tenantField:"tenantId" as const},entityScope:{kind:"tenant" as const},policy:{skipCapabilityCheck:true as const},validation:{createBody:schema,updateBody:schema},routes:{list:true,detail:true,create:false,update:false,delete:false},searchableColumns:["name"],searchStrategy:{kind:"fullText",portKey:"catalog-search"}})
    expect(()=>compileEntity(entity,{dependencies:{}})).toThrow("searchPorts.catalog-search")
    const port={capability:{portKey:"catalog-search",searchableFields:new Set(["name"]),filterableFields:new Set<string>(),sortableFields:new Set<string>(),consistency:["eventual" as const],maxQueryBytes:100,maxResults:10},search:async()=>({hits:[],consistency:"eventual" as const})}
    expect(()=>compileEntity(entity,{dependencies:{searchPorts:{"catalog-search":port}}})).not.toThrow()
  })
})
