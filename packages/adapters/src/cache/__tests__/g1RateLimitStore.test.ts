import {describe,expect,it} from "vitest"
import { checkRateLimit } from "core/rate-limit"
import {InMemoryCacheAdapter} from "../inMemoryCacheAdapter"
import {InMemoryRateLimitStore} from "../inMemoryRateLimitStore"

describe("G1 rate-limit adapter separation",()=>{
  it("keeps cache and security-sensitive rate limiting separate",async()=>{
    const cache=new InMemoryCacheAdapter();const store=new InMemoryRateLimitStore(()=>100)
    expect("incrementRateLimitAtomically" in cache).toBe(false)
    await expect(checkRateLimit({store,key:"tenant",limit:3,windowMs:1000,cost:2})).resolves.toMatchObject({allowed:true,remaining:1})
    await expect(checkRateLimit({store,key:"tenant",limit:3,windowMs:1000,cost:2})).resolves.toMatchObject({allowed:false,remaining:0})
  })
})
