import {describe,expect,it,vi} from "vitest"
import {checkRateLimit,type AtomicRateLimitStore} from "../../rate-limit"
import {encodeQuotaSubject,validateQuotaRequest} from "../../quota"
import {validateResiliencePolicy} from "../../resilience"

describe("G1 contracts",()=>{
  it("uses declared algorithms and weighted costs",async()=>{
    const consumeAtomically=vi.fn(async()=>({count:3,resetAt:1000}))
    const store:AtomicRateLimitStore={capabilities:{algorithms:["fixed-window","token-bucket"],weightedCost:true},increment:async()=>({count:1,resetAt:1000}),incrementAtomically:async()=>({count:1,resetAt:1000}),consumeAtomically}
    await expect(checkRateLimit({store,key:"write",limit:5,windowMs:1000,algorithm:"token-bucket",cost:3})).resolves.toMatchObject({allowed:true,remaining:2})
    expect(consumeAtomically).toHaveBeenCalledWith({key:"write",windowMs:1000,algorithm:"token-bucket",cost:3})
    await expect(checkRateLimit({store,key:"write",limit:5,windowMs:1000,algorithm:"sliding-window"})).rejects.toThrow("rateLimitAlgorithm")
  })

  it("does not emulate weighted or advanced algorithms when capabilities are not advertised",async()=>{
    const store:AtomicRateLimitStore={increment:async()=>({count:1,resetAt:1000}),incrementAtomically:async()=>({count:1,resetAt:1000})}
    await expect(checkRateLimit({store,key:"write",limit:5,windowMs:1000,cost:2})).rejects.toThrow("weightedRateLimitCost")
    await expect(checkRateLimit({store,key:"write",limit:5,windowMs:1000,algorithm:"token-bucket"})).rejects.toThrow("rateLimitConsume")
  })

  it("derives quota identities only from canonical trusted facts",()=>{
    const subject={scope:{kind:"tenant" as const,tenantId:"tenant:a"},principal:{kind:"human" as const,id:"user:a"},planKey:"pro"}
    expect(encodeQuotaSubject(subject)).toContain("human:user%3Aa:plan:pro")
    expect(validateQuotaRequest({quotaKey:"exports",subject,amount:2,limit:10,windowMs:60_000})).toBeDefined()
    expect(()=>validateQuotaRequest({quotaKey:"exports",subject,amount:0,limit:10,windowMs:60_000})).toThrow("amount")
  })

  it("validates read retry policy bounds",()=>{
    expect(validateResiliencePolicy({retry:{maxAttempts:3,backoffMs:10}},{kind:"read"})).toMatchObject({retry:{maxAttempts:3,backoffMs:10}})
    expect(()=>validateResiliencePolicy({retry:{maxAttempts:0}},{kind:"read"})).toThrow("positive")
  })

  it("validates idempotent mutation retry policy and key",()=>{
    expect(validateResiliencePolicy({retry:{maxAttempts:3}},{kind:"idempotent-mutation",idempotencyKey:"request-1"})).toBeDefined()
    expect(()=>validateResiliencePolicy({retry:{maxAttempts:3}},{kind:"idempotent-mutation",idempotencyKey:" "})).toThrow("idempotency key")
  })

  it("prohibits automatic retry of non-idempotent mutations",()=>{
    expect(()=>validateResiliencePolicy({retry:{maxAttempts:2}},{kind:"non-idempotent-mutation"})).toThrow("cannot be retried")
  })

  it("validates timeout policy bounds",()=>{
    expect(validateResiliencePolicy({timeoutMs:500},{kind:"read"})).toMatchObject({timeoutMs:500})
    expect(()=>validateResiliencePolicy({timeoutMs:0},{kind:"read"})).toThrow("positive")
  })

  it("validates circuit-breaker policy bounds and freezes the snapshot",()=>{
    const policy=validateResiliencePolicy({circuitBreaker:{failureThreshold:3,resetAfterMs:1000}},{kind:"read"})
    expect(Object.isFrozen(policy.circuitBreaker)).toBe(true)
    expect(()=>validateResiliencePolicy({circuitBreaker:{failureThreshold:0,resetAfterMs:1000}},{kind:"read"})).toThrow("positive")
  })

  it("validates bulkhead policy bounds and freezes the snapshot",()=>{
    const policy=validateResiliencePolicy({bulkhead:{maxConcurrent:2,maxQueue:0}},{kind:"read"})
    expect(Object.isFrozen(policy.bulkhead)).toBe(true)
    expect(()=>validateResiliencePolicy({bulkhead:{maxConcurrent:0}},{kind:"read"})).toThrow("maxConcurrent")
    expect(()=>validateResiliencePolicy({bulkhead:{maxConcurrent:1,maxQueue:-1}},{kind:"read"})).toThrow("maxQueue")
  })
})
