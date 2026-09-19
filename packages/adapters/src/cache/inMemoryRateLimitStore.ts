import type { AtomicRateLimitStore, RateLimitConsumeRequest, RateLimitStoreCapabilities } from "core/rate-limit"

export class InMemoryRateLimitStore implements AtomicRateLimitStore {
  readonly capabilities: RateLimitStoreCapabilities = Object.freeze({algorithms:Object.freeze(["fixed-window"] as const),weightedCost:true})
  private readonly buckets=new Map<string,{count:number;resetAt:number}>()
  constructor(private readonly nowMs:()=>number=Date.now){}
  async increment(key:string,windowMs:number){return this.consumeAtomically({key,windowMs,algorithm:"fixed-window",cost:1})}
  async incrementAtomically(key:string,windowMs:number){return this.increment(key,windowMs)}
  // A synchronous map update is atomic inside this reference adapter's process.
  // eslint-disable-next-line @typescript-eslint/require-await
  async consumeAtomically(request:RateLimitConsumeRequest):Promise<{count:number;resetAt:number}>{
    if(request.algorithm!=="fixed-window") throw new Error(`Unsupported rate-limit algorithm: ${request.algorithm}`)
    const now=this.nowMs();const current=this.buckets.get(request.key);const bucket=current&&current.resetAt>now?current:{count:0,resetAt:now+request.windowMs}
    bucket.count+=request.cost;this.buckets.set(request.key,bucket);return {...bucket}
  }
}
