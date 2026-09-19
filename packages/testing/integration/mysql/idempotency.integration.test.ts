import {describe,expect,it} from "vitest"
import type { VersionedEntityDescriptor } from "core/persistence"
import {createDrizzleMySqlIdempotencyStore,createDrizzleMySqlPersistenceProvider,DrizzleMySqlEntityRegistry,getDrizzleMySqlSession} from "adapters/drizzle-mysql"
import {mysqlIdempotency,mysqlRecords} from "../../fixtures/mysql/schema.js"
import {openMySqlFixture} from "./database.js"

interface RecordRow{id:string;tenantId:string;name:string;version:number;value:unknown}
const entity:VersionedEntityDescriptor<RecordRow>={name:"records",primaryKey:"id",versionField:"version",tenantField:"tenantId",fields:{id:{type:"string"},tenantId:{type:"string"},name:{type:"string"},version:{type:"number"},value:{type:"json"}}}

describe("MYSQL1 durable idempotency",()=>{
  it("commits the receipt with the mutation, finalizes, replays, and detects conflicts",async()=>{
    const fixture=await openMySqlFixture()
    try{
      const registry=new DrizzleMySqlEntityRegistry().register(entity,mysqlRecords,{id:mysqlRecords.id,tenantId:mysqlRecords.tenantId,name:mysqlRecords.name,version:mysqlRecords.version,value:mysqlRecords.value})
      const provider=createDrizzleMySqlPersistenceProvider({db:fixture.db,registry})
      const store=createDrizzleMySqlIdempotencyStore<{id:string}>(fixture.db,mysqlIdempotency)
      const request={scope:"tenant:t1:create",key:"request-1",fingerprint:"fingerprint-1",leaseDurationMs:60_000}
      const acquired=await store.acquire(request)
      expect(acquired.outcome).toBe("acquired")
      const token=(acquired as {token:string}).token
      await provider.runInTransaction(async transaction=>{
        await transaction.repository(entity).insert({id:"idem-record",tenantId:"t1",name:"created",value:{}})
        await store.markCommittedInTransaction({...request,token,resource:{entity:"records",id:"idem-record",version:1}},transaction)
      })
      expect(await store.acquire(request)).toMatchObject({outcome:"business-committed",token})
      await store.complete({...request,token,result:{id:"idem-record"}})
      expect(await store.acquire(request)).toEqual({outcome:"replay",result:{id:"idem-record"}})
      expect(await store.acquire({...request,fingerprint:"different"})).toEqual({outcome:"conflict"})
      expect(getDrizzleMySqlSession(provider)).toBe(fixture.db)
    }finally{await fixture.pool.end()}
  })
  it("leases, fences, completes and acknowledges durable invalidation obligations",async()=>{const fixture=await openMySqlFixture();try{const registry=new DrizzleMySqlEntityRegistry().register(entity,mysqlRecords,{id:mysqlRecords.id,tenantId:mysqlRecords.tenantId,name:mysqlRecords.name,version:mysqlRecords.version,value:mysqlRecords.value});const provider=createDrizzleMySqlPersistenceProvider({db:fixture.db,registry});const store=createDrizzleMySqlIdempotencyStore<{ok:boolean}>(fixture.db,mysqlIdempotency);for(const key of ["complete","ack"]){const request={scope:"tenant:t1:update",key,fingerprint:`fp-${key}`,leaseDurationMs:60_000};const acquired=await store.acquire(request);const token=(acquired as {token:string}).token;await provider.runInTransaction(tx=>store.markCommittedInTransaction({...request,token,invalidations:["record:t1"]},tx));const [claim]=await store.claimPendingInvalidations({claimOwner:"finalizer",leaseMs:60_000});expect(claim).toMatchObject({key,invalidations:["record:t1"],claimOwner:"finalizer"});if(key==="complete")await store.completeClaimedInvalidation({...request,token,result:{ok:true},claimToken:claim!.claimToken});else await store.ackClaimedInvalidation({...request,token,claimToken:claim!.claimToken})}expect(await store.acquire({scope:"tenant:t1:update",key:"complete",fingerprint:"fp-complete"})).toEqual({outcome:"replay",result:{ok:true}})}finally{await fixture.pool.end()}})
})
