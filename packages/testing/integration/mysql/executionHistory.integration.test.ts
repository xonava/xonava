import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest"
import type {Pool} from "mysql2/promise"
import {DrizzleMySqlJobStore,MYSQL_JOB_LEASE_EXHAUSTED_REASON,type DrizzleMySqlJobStoreOptions} from "@xonava/adapters/drizzle-mysql"
import {altName,clearAltDatabase,openAltDatabase} from "./altDatabase.js"

const system={scope:"system" as const}
const systemJob=(overrides:Record<string,unknown>={})=>({jobType:"probe",jobVersion:1,payload:{},executionScope:{kind:"system" as const,systemKey:"probe"},...overrides})
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

describe("job store executionHistory modes",()=>{
  let pool:Pool
  let database:string
  let drop:()=>Promise<void>
  beforeAll(async()=>{({pool,database,drop}=await openAltDatabase())})
  afterAll(async()=>{await drop?.()})
  beforeEach(async()=>{await clearAltDatabase(pool,database)})
  const q=(table:Parameters<typeof altName>[0])=>`\`${database}\`.\`${altName(table)}\``
  /** `broken` points history at a table that does not exist, forcing every history write to fail. */
  const store=(executionHistory:DrizzleMySqlJobStoreOptions["executionHistory"],broken=false)=>new DrizzleMySqlJobStore(pool,{database,...(executionHistory?{executionHistory}:{}),tables:{jobs:altName("jobs"),jobExecutions:broken?"missing_job_executions":altName("job_executions")}})
  const jobRow=async(id:string)=>{const [rows]=await pool.query(`SELECT status,worker_id,claim_token,attempt,last_error,lease_expires_at FROM ${q("jobs")} WHERE id=?`,[id]);return (rows as Record<string,unknown>[])[0]!}
  const history=async(id:string)=>{const [rows]=await pool.query(`SELECT id,status,attempt,error_message FROM ${q("job_executions")} WHERE job_id=? ORDER BY finished_at,id`,[id]);return rows as Record<string,unknown>[]}
  const claimOne=async(target:DrizzleMySqlJobStore,overrides:Record<string,unknown>={},leaseDurationMs=60_000)=>{const job=await target.enqueue({requester:system,job:systemJob(overrides)} as never);const [claimed]=await target.claimDue({requester:system,workerId:"w1",limit:1,leaseDurationMs});expect(claimed?.id).toBe(job.id);return claimed!}
  const fence=(job:{id:string;claimToken:string|null;currentAttempt:number})=>({jobId:job.id,workerId:"w1",claimToken:job.claimToken!,attempt:job.currentAttempt})

  it("required (the default) commits each transition together with its history row",async()=>{
    for(const target of [store("required"),store(undefined)]){
      await clearAltDatabase(pool,database)
      const succeeded=await claimOne(target,{idempotencyKey:"ok"})
      const done=await target.markSucceeded({...fence(succeeded),result:{ok:true}})
      expect(done).toMatchObject({applied:true});expect(done.historyError).toBeUndefined()
      expect(await history(succeeded.id)).toEqual([{id:done.transitionToken,status:"succeeded",attempt:1,error_message:null}])
      const retried=await claimOne(target,{idempotencyKey:"retry"})
      const retry=await target.markRetrying({...fence(retried),error:"boom",nextAttemptAt:new Date(Date.now()+60_000)})
      expect(retry).toMatchObject({applied:true})
      expect((await jobRow(retried.id)).status).toBe("retrying")
      expect(await history(retried.id)).toEqual([{id:retry.transitionToken,status:"retrying",attempt:1,error_message:"boom"}])
      expect(await target.markSucceeded(fence(succeeded))).toEqual({applied:false,reason:"LEASE_LOST"})
    }
  })

  it("required: a failed history write returns a sanitized HISTORY_FAILED and leaves the job unchanged",async()=>{
    const target=store("required",true)
    const claimed=await claimOne(target)
    const before=await jobRow(claimed.id)
    for(const attempt of [
      ()=>target.markSucceeded(fence(claimed)),
      ()=>target.markRetrying({...fence(claimed),error:"boom",nextAttemptAt:new Date()}),
      ()=>target.markFailed({...fence(claimed),status:"dead_letter",error:"boom"} as never),
      ()=>target.cancel({jobId:claimed.id,requester:system} as never),
    ]){
      const result=await attempt()
      expect(result).toMatchObject({applied:false,reason:"HISTORY_FAILED"})
      expect(result.historyError).toMatch(/^Execution history persistence failed/)
      expect(result.historyError).not.toMatch(/job_executions|INSERT|exist|framework_alt/i)
      expect(await jobRow(claimed.id)).toEqual(before)
    }
    expect(before).toMatchObject({status:"running",worker_id:"w1",claim_token:claimed.claimToken})
    // The intact store can still complete the untouched claim.
    expect(await store("required").markSucceeded(fence(claimed))).toMatchObject({applied:true})
  })

  it("best_effort: the transition commits and a history failure is reported, not fatal",async()=>{
    const broken=store("best_effort",true)
    const claimed=await claimOne(broken)
    const done=await broken.markSucceeded(fence(claimed))
    expect(done).toMatchObject({applied:true})
    expect(done.transitionToken).toBeTruthy()
    expect(done.historyError).toMatch(/^Execution history persistence failed/)
    expect(done.historyError).not.toMatch(/job_executions|INSERT|exist/i)
    expect((await jobRow(claimed.id)).status).toBe("succeeded")
    const other=await broken.enqueue({requester:system,job:systemJob({idempotencyKey:"cancel"})} as never)
    const cancelled=await broken.cancel({jobId:other.id,requester:system} as never)
    expect(cancelled).toMatchObject({applied:true});expect(cancelled.historyError).toBeTruthy()
    expect((await jobRow(other.id)).status).toBe("cancelled")
    expect(await broken.cancel({jobId:other.id,requester:system} as never)).toEqual({applied:false,reason:"INVALID_STATE"})

    const healthy=store("best_effort")
    const next=await claimOne(healthy,{idempotencyKey:"healthy"})
    const failed=await healthy.markFailed({...fence(next),status:"dead_letter",error:"fatal"} as never)
    expect(failed).toMatchObject({applied:true});expect(failed.historyError).toBeUndefined()
    expect(await history(next.id)).toEqual([{id:failed.transitionToken,status:"dead_letter",attempt:1,error_message:"fatal"}])
    expect(await healthy.markFailed({...fence(next),status:"dead_letter",error:"again"} as never)).toEqual({applied:false,reason:"LEASE_LOST"})
  })

  it("dead-lettering an exhausted expired lease writes a job_executions row in both modes",async()=>{
    for(const mode of ["required","best_effort"] as const){
      await clearAltDatabase(pool,database)
      const target=store(mode)
      const stuck=await claimOne(target,{maxAttempts:1,partitionKey:"P"},50)
      await pause(150)
      const next=await target.enqueue({requester:system,job:systemJob({partitionKey:"P",idempotencyKey:"next"})} as never)
      const claimed=await target.claimDue({requester:system,workerId:"w2",limit:10,leaseDurationMs:60_000})
      expect(claimed.map(job=>job.id)).toEqual([next.id])
      expect(await jobRow(stuck.id)).toMatchObject({status:"dead_letter",worker_id:null,claim_token:null,last_error:MYSQL_JOB_LEASE_EXHAUSTED_REASON})
      expect(await history(stuck.id)).toEqual([expect.objectContaining({status:"dead_letter",attempt:1,error_message:MYSQL_JOB_LEASE_EXHAUSTED_REASON})])
    }
  })

  it("dead-letter history failure: required keeps the job un-swept atomically, best_effort sweeps it; claims proceed",async()=>{
    const required=store("required",true)
    const stuck=await claimOne(required,{maxAttempts:1},50)
    await pause(150)
    const fresh=await required.enqueue({requester:system,job:systemJob({idempotencyKey:"fresh"})} as never)
    expect((await required.claimDue({requester:system,workerId:"w2",limit:10,leaseDurationMs:60_000})).map(job=>job.id)).toEqual([fresh.id])
    expect(await jobRow(stuck.id)).toMatchObject({status:"running",worker_id:"w1"})

    const bestEffort=store("best_effort",true)
    expect(await bestEffort.claimDue({requester:system,workerId:"w3",limit:10,leaseDurationMs:60_000})).toEqual([])
    expect(await jobRow(stuck.id)).toMatchObject({status:"dead_letter",worker_id:null,last_error:MYSQL_JOB_LEASE_EXHAUSTED_REASON})
    expect(await history(stuck.id)).toEqual([])
  })
})
