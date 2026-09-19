import { describe, expect, it, vi } from "vitest"
import { ConfigurationError, ForbiddenError } from "../../domain/errors"
import { encodeExecutionScopeId } from "../../domain/executionScope"
import type { CompiledRouteBinding } from "../../bootstrap/compiledRouteBinding"
import { assertVerifiedScopeIdentity, createVerifiedScopeResolution, isVerifiedScopeResolution, resolveVerifiedScope } from "../scopeResolver"

const tenant={kind:"tenant",tenantId:"t1"} as const
const route=(overrides:Partial<CompiledRouteBinding>={}):CompiledRouteBinding=>({routeKey:"items",definitionVersion:1,transport:"http",method:"GET",pathTemplate:"/items",exposure:"authenticated",operationKey:"items.read",scopeResolution:{kind:"resolver",resolverKey:"tenant",allowedTargetKinds:["tenant"]},anonymousPrincipal:{allowed:false},inputPolicy:{},outputPolicy:{},mutation:{allowed:false},authorizationPlanKey:"items",...overrides})
const binding=(resolve=vi.fn(async()=>createVerifiedScopeResolution("tenant",tenant)))=>({key:"tenant",resolver:{key:"tenant",resolve},allowedTargetKinds:["tenant" as const]})

describe("verified scope resolution boundary",()=>{
  it("constructs and resolves an immutable matching scope",async()=>{const created=createVerifiedScopeResolution("tenant",tenant);expect(isVerifiedScopeResolution(created)).toBe(true);expect(Object.isFrozen(created.scope)).toBe(true);await expect(resolveVerifiedScope({route:route(),input:{headers:{host:"example"}},binding:binding()})).resolves.toEqual(created);expect(()=>assertVerifiedScopeIdentity(created)).not.toThrow()})
  it("rejects empty resolver keys and non-resolver routes",async()=>{expect(()=>createVerifiedScopeResolution(" ",tenant)).toThrow(ConfigurationError);await expect(resolveVerifiedScope({route:route({scopeResolution:{kind:"fixed",scope:tenant}}),input:{},binding:binding()})).rejects.toThrow("does not use resolver")})
  it("rejects invalid public route declarations and binding identities",async()=>{await expect(resolveVerifiedScope({route:route({exposure:"public"}),input:{},binding:binding()})).rejects.toThrow("anonymous principal");await expect(resolveVerifiedScope({route:route(),input:{},binding:{...binding(),key:"wrong"}})).rejects.toThrow("binding identity")})
  it("rejects unverified, mismatched, widened, and tampered resolver results",async()=>{
    await expect(resolveVerifiedScope({route:route(),input:{},binding:binding(vi.fn(async()=>({scope:tenant,scopeId:encodeExecutionScopeId(tenant),resolverKey:"tenant"} as never)))})).rejects.toThrow(ForbiddenError)
    await expect(resolveVerifiedScope({route:route(),input:{},binding:binding(vi.fn(async()=>createVerifiedScopeResolution("wrong",tenant)))})).rejects.toThrow("mismatched")
    const verified=createVerifiedScopeResolution("tenant",tenant);const tampered={...verified,scopeId:encodeExecutionScopeId({kind:"tenant",tenantId:"other"})};await expect(resolveVerifiedScope({route:route(),input:{},binding:binding(vi.fn(async()=>tampered))})).rejects.toThrow("unverified")
    const application=createVerifiedScopeResolution("tenant",{kind:"application",applicationKey:"app"});await expect(resolveVerifiedScope({route:route(),input:{},binding:{...binding(vi.fn(async()=>application)),allowedTargetKinds:["application"]}})).rejects.toThrow("route binding")
    await expect(resolveVerifiedScope({route:route({scopeResolution:{kind:"resolver",resolverKey:"tenant",allowedTargetKinds:["tenant","application"]}}),input:{},binding:binding(vi.fn(async()=>application))})).rejects.toThrow("resolver binding")
    expect(()=>assertVerifiedScopeIdentity(tampered)).toThrow(ConfigurationError)
  })
})
