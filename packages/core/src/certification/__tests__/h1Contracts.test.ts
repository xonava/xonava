import {describe,expect,it} from "vitest"
import {aggregateHealth} from "../../health"
import {isSecretReference,secretReference} from "../../secrets"
import {validateFeatureFlagFact} from "../../feature-flags"
import {validateWorkingWindows,type BusinessCalendarPort} from "../../business-calendar"

describe("H1 contracts",()=>{
  const now=new Date("2026-01-01T00:00:00Z")
  const later=new Date("2026-01-02T00:00:00Z")
  const healthy={key:"process",status:"healthy",critical:true,checkedAt:now} as const
  it("liveness-separation",()=>{expect(aggregateHealth([{...healthy,status:"unhealthy"}],[],now)).toMatchObject({live:false,ready:false,status:"unhealthy"})})
  it("readiness-separation",()=>{expect(aggregateHealth([healthy],[{key:"database",status:"unhealthy",critical:true,checkedAt:now}],now)).toMatchObject({live:true,ready:false,status:"unhealthy"})})
  it("critical-component-failure",()=>{expect(aggregateHealth([healthy],[{key:"queue",status:"unhealthy",critical:true,checkedAt:now}],now).status).toBe("unhealthy")})
  it("noncritical-degradation",()=>{expect(aggregateHealth([healthy],[{key:"search",status:"degraded",critical:false,checkedAt:now}],now)).toMatchObject({live:true,ready:true,status:"degraded"})})
  it("component-identity-validation",()=>{expect(()=>aggregateHealth([{...healthy,key:"same"}],[{...healthy,key:"same"}],now)).toThrow("unique")})
  it("opaque-secret-reference",()=>{expect(secretReference("vault","payments/api","7")).toEqual({provider:"vault",key:"payments/api",version:"7"})})
  it("raw-secret-rejection",()=>{expect(isSecretReference({provider:"vault",key:"x",value:"leak"})).toBe(false)})
  it("feature-fact-validation",()=>{
    expect(validateFeatureFlagFact({key:"new-ui",value:true,reason:"rollout",evaluatedAt:now},"new-ui")).toMatchObject({value:true})
    for(const value of [NaN,Infinity,-Infinity,{},null]) expect(()=>validateFeatureFlagFact({key:"new-ui",value:value as never,reason:"rollout",evaluatedAt:now},"new-ui")).toThrow()
    expect(()=>validateFeatureFlagFact({key:"wrong",value:true,reason:"rollout",evaluatedAt:now},"expected")).toThrow()
  })
  it("feature-fact-expiry",()=>{
    expect(validateFeatureFlagFact({key:"new-ui",value:"on",reason:"rollout",evaluatedAt:now,expiresAt:later}).expiresAt).toEqual(later)
    expect(()=>validateFeatureFlagFact({key:"new-ui",value:true,reason:"rollout",evaluatedAt:now,expiresAt:now})).toThrow()
  })
  it("business-calendar-port",async()=>{
    const port:BusinessCalendarPort={async isBusinessDay(){return true},async nextBusinessDay(){return later},async workingWindows(){return []}}
    await expect(port.isBusinessDay(now,{calendarKey:"default",timeZone:"UTC"})).resolves.toBe(true)
  })
  it("ordered-working-windows",()=>{expect(validateWorkingWindows(now,later,[{start:new Date("2026-01-01T09:00:00Z"),end:new Date("2026-01-01T17:00:00Z")}])).toHaveLength(1)})
  it("bounded-working-windows",()=>{
    expect(()=>validateWorkingWindows(now,later,[{start:new Date("2026-01-01T17:00:00Z"),end:new Date("2026-01-01T09:00:00Z")}])).toThrow()
    expect(()=>validateWorkingWindows(now,later,[{start:new Date("2025-12-31T23:00:00Z"),end:new Date("2026-01-01T01:00:00Z")}])).toThrow()
  })
})
