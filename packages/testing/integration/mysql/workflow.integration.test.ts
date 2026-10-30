import {describe,expect,it} from "vitest"
import {applyWorkflowStep} from "@xonava/core/workflow"
import {DrizzleMySqlWorkflowStore} from "@xonava/adapters/drizzle-mysql"
import {openMySqlFixture} from "./database.js"

describe("workflow store",()=>{
  it("fences transitions and deduplicates signals",async()=>{
    const {pool}=await openMySqlFixture()
    try{
      const store=new DrizzleMySqlWorkflowStore(pool)
      await store.start({id:"wf-mysql",workflowType:"order",workflowVersion:1,executionScope:{kind:"tenant",tenantId:"t1"},initialStep:"reserve",variables:{amount:10}})
      const [claim]=await store.claimDue({workerId:"worker",limit:1,leaseDurationMs:60_000})
      expect(claim).toBeDefined()
      const next=applyWorkflowStep(claim!.instance,{kind:"wait",signal:"approve"},new Date())
      const fence={instanceId:"wf-mysql",workerId:"worker",claimToken:claim!.claimToken,revision:claim!.instance.revision}
      expect(await store.assertLease(fence)).toBe(true)
      expect(await store.renewLease(fence,60_000)).toBe(true)
      expect(await store.renewLease({...fence,claimToken:"wrong"},60_000)).toBe(false)
      expect(await store.assertLease({...fence,claimToken:"wrong"})).toBe(false)
      expect(await store.commit(fence,next)).toBe(true)
      expect(await store.assertLease(fence)).toBe(false)
      expect(await store.commit(fence,next)).toBe(false)
      expect(await store.deliverSignal({id:"sig-mysql",instanceId:"wf-mysql",name:"approve",payload:{actor:"u"}})).toEqual({delivered:true,duplicate:false})
      expect(await store.deliverSignal({id:"sig-mysql",instanceId:"wf-mysql",name:"approve",payload:{actor:"u"}})).toEqual({delivered:false,duplicate:true})
      expect((await store.get("wf-mysql"))?.status).toBe("pending")
      expect(await store.cancel("wf-mysql")).toBe(true)
      expect(await store.cancel("wf-mysql")).toBe(false)
    }finally{await pool.end()}
  })
})
