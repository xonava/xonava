import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest"
import type {Pool} from "mysql2/promise"
import type {InboxKey,InboxRecord,OutboxDeliveryRecord} from "@xonava/core/events"
import {ConfigurationError} from "@xonava/core/domain"
import {applyWorkflowStep} from "@xonava/core/workflow"
import {createMySqlInboxStore,createMySqlLeaseStore,createMySqlOutboxStore,createMySqlTagGenerationStore,DrizzleMySqlJobProgressStore,DrizzleMySqlJobStore,DrizzleMySqlScheduleStore,DrizzleMySqlSequenceStore,DrizzleMySqlTemporalHistoryStore,DrizzleMySqlWorkflowStore} from "@xonava/adapters/drizzle-mysql"
import {altName,clearAltDatabase,openAltDatabase} from "./altDatabase.js"

const system={scope:"system" as const}
const systemJob=(overrides:Record<string,unknown>={})=>({jobType:"probe",jobVersion:1,payload:{},executionScope:{kind:"system" as const,systemKey:"probe"},...overrides})
const count=async(pool:Pool,sqlText:string,params:unknown[]=[])=>{const [rows]=await pool.query(sqlText,params);return Number((rows as {n:number}[])[0]!.n)}

describe("MYSQL1 configurable database and table names",()=>{
  let pool:Pool
  let database:string
  let drop:()=>Promise<void>
  beforeAll(async()=>{({pool,database,drop}=await openAltDatabase())})
  afterAll(async()=>{await drop?.()})
  beforeEach(async()=>{await clearAltDatabase(pool,database)})
  const q=(table:Parameters<typeof altName>[0])=>`\`${database}\`.\`${altName(table)}\``

  it("rejects hostile database and table names before touching SQL",()=>{
    expect(()=>new DrizzleMySqlJobStore(pool,{tables:{jobs:"jobs`; DROP TABLE x;--"}})).toThrow(ConfigurationError)
    expect(()=>new DrizzleMySqlWorkflowStore(pool,{database:"x`.`y"})).toThrow(ConfigurationError)
  })

  it("runs the job, progress and schedule stores against renamed tables in another database",async()=>{
    const jobs=new DrizzleMySqlJobStore(pool,{database,tables:{jobs:altName("jobs"),jobExecutions:altName("job_executions")}})
    const job=await jobs.enqueue({requester:system,job:systemJob({idempotencyKey:"alt-1"})} as never)
    expect((await jobs.getById({id:job.id,requester:system} as never))?.id).toBe(job.id)
    expect(await count(pool,"SELECT COUNT(*) n FROM jobs WHERE id=?",[job.id])).toBe(0)
    expect(await count(pool,`SELECT COUNT(*) n FROM ${q("jobs")} WHERE id=?`,[job.id])).toBe(1)
    const [claimed]=await jobs.claimDue({requester:system,workerId:"w1",limit:5,leaseDurationMs:60_000})
    expect(claimed?.id).toBe(job.id)
    const progress=new DrizzleMySqlJobProgressStore(pool,{database,tables:{jobs:altName("jobs"),jobProgress:altName("job_progress")}})
    const fence={jobId:job.id,workerId:"w1",claimToken:claimed!.claimToken!,attempt:claimed!.currentAttempt}
    expect((await progress.write(fence,0,{percent:40})).sequence).toBe(1)
    expect((await progress.read(job.id))?.percent).toBe(40)
    expect(await count(pool,`SELECT COUNT(*) n FROM ${q("job_progress")}`)).toBe(1)
    expect(await jobs.renewLease({jobId:job.id,workerId:"w1",claimToken:claimed!.claimToken!,extendByMs:60_000})).toBe(true)
    const done=await jobs.markSucceeded({jobId:job.id,workerId:"w1",claimToken:claimed!.claimToken!,attempt:claimed!.currentAttempt})
    expect(done).toMatchObject({applied:true})
    expect(await count(pool,`SELECT COUNT(*) n FROM ${q("job_executions")} WHERE id=? AND status='succeeded'`,[done.transitionToken])).toBe(1)
    expect(await jobs.findPending({requester:system} as never)).toEqual([])

    await pool.query(`INSERT INTO ${q("schedules")}(id,scope,job_type,job_version,tenant_id,payload,cron_expression,timezone,overlap_policy,misfire_policy,next_run_at) VALUES('alt-schedule','tenant','job',1,'t1',JSON_OBJECT(),'0 * * * *','UTC','allow','fire_now',TIMESTAMPADD(SECOND,-1,CURRENT_TIMESTAMP(3)))`)
    const schedules=new DrizzleMySqlScheduleStore(pool,{database,tables:{schedules:altName("schedules")}})
    const [schedule]=await schedules.claimDueSchedules({workerId:"s1",limit:5,leaseDurationMs:60_000})
    expect(schedule?.scheduleId).toBe("alt-schedule")
    expect(await schedules.renewScheduleLease({scheduleId:"alt-schedule",workerId:"s1",claimToken:schedule!.claimToken,now:new Date(),extendByMs:60_000})).toBe(true)
    expect(await schedules.advanceSchedule({scheduleId:"alt-schedule",workerId:"s1",claimToken:schedule!.claimToken,nextRunAt:new Date(Date.now()+60_000),lastRunAt:new Date(),lastStatus:"fired"})).toBe(true)
    expect(await count(pool,`SELECT COUNT(*) n FROM ${q("schedules")} WHERE last_status='fired'`)).toBe(1)
  })

  it("runs the workflow, sequence and temporal stores against renamed tables in another database",async()=>{
    const workflows=new DrizzleMySqlWorkflowStore(pool,{database,tables:{workflows:altName("workflows"),workflowSignals:altName("workflow_signals")}})
    await workflows.start({id:"wf-alt",workflowType:"order",workflowVersion:1,executionScope:{kind:"tenant",tenantId:"t1"},initialStep:"reserve",variables:{amount:1}})
    const [claim]=await workflows.claimDue({workerId:"w",limit:1,leaseDurationMs:60_000})
    const fence={instanceId:"wf-alt",workerId:"w",claimToken:claim!.claimToken,revision:claim!.instance.revision}
    expect(await workflows.assertLease(fence)).toBe(true)
    expect(await workflows.commit(fence,applyWorkflowStep(claim!.instance,{kind:"wait",signal:"approve"},new Date()))).toBe(true)
    expect(await workflows.deliverSignal({id:"sig-alt",instanceId:"wf-alt",name:"approve",payload:{ok:true}})).toEqual({delivered:true,duplicate:false})
    expect((await workflows.getSignal("wf-alt","approve"))?.payload).toEqual({ok:true})
    expect((await workflows.get("wf-alt"))?.status).toBe("pending")
    expect(await count(pool,"SELECT COUNT(*) n FROM workflows WHERE id='wf-alt'")).toBe(0)

    const sequences=new DrizzleMySqlSequenceStore(pool,{database,tables:{sequences:altName("sequences")}})
    expect([await sequences.next("tenant:t1" as never,"invoice","2026"),await sequences.next("tenant:t1" as never,"invoice","2026")]).toEqual([1,2])
    expect(await count(pool,`SELECT COUNT(*) n FROM ${q("sequences")}`)).toBe(1)

    const temporal=new DrizzleMySqlTemporalHistoryStore<{value:number}>(pool,{database,tables:{temporalHeads:altName("temporal_heads"),temporalRevisions:altName("temporal_revisions"),temporalSnapshots:altName("temporal_snapshots")}})
    const resource={scopeId:"tenant-a" as never,entityType:"invoice",entityId:"alt"}
    await temporal.append({...resource,occurredAt:new Date(1_000),kind:"created",state:{value:1}})
    expect((await temporal.append({...resource,occurredAt:new Date(2_000),kind:"updated",state:{value:2}})).revision).toBe(2)
    await temporal.saveSnapshot({...resource,revision:2,occurredAt:new Date(2_000),state:{value:2}})
    expect((await temporal.latestSnapshot(resource,new Date(3_000)))?.revision).toBe(2)
    expect((await temporal.revisions(resource,{afterRevision:0,asOf:new Date(3_000),limit:10})).items.map(item=>item.revision)).toEqual([1,2])
    expect(await count(pool,`SELECT COUNT(*) n FROM ${q("temporal_heads")}`)).toBe(1)
  })

  it("runs the inbox, outbox, lease and tag-generation stores against renamed tables in another database",async()=>{
    const scopeId="tenant:t1" as never
    const inboxKey:InboxKey={consumerKey:"ledger",messageId:"alt-inbox",scopeId}
    const inboxRecord:InboxRecord={...inboxKey,consumerDefinitionVersion:1,state:"pending",attempt:0,replayGeneration:0,claim:null,firstObservedAt:"",lastObservedAt:"",eventFormatVersion:1,eventPayloadVersion:1,originalProvenance:{format:"framework.authority-provenance",formatVersion:1} as never,replay:{kind:"original-delivery"},history:[]}
    const inbox=createMySqlInboxStore(pool,{database,tables:{atomicRecords:altName("atomic_records")}})
    await inbox.observe(inboxRecord)
    const claim=await inbox.claim(inboxKey,"worker",60_000)
    await inbox.acknowledge(inboxKey,claim!.claim!.token,async()=>"committed")
    expect((await inbox.get(inboxKey))?.state).toBe("processed")

    const outbox=createMySqlOutboxStore(pool,{database,tables:{atomicRecords:altName("atomic_records")}})
    const delivery:OutboxDeliveryRecord={envelope:{messageId:"alt-outbox"} as never,scopeId,idempotencyKey:"alt-outbox",state:"pending",attempt:0,claim:null}
    await outbox.append(delivery)
    const published=await outbox.claim({messageId:"alt-outbox",scopeId},"publisher",60_000)
    await outbox.markPublished({messageId:"alt-outbox",scopeId},published!.claim!.token)
    expect((await outbox.get({messageId:"alt-outbox",scopeId}))?.state).toBe("published")
    expect(await count(pool,`SELECT COUNT(*) n FROM ${q("atomic_records")}`)).toBe(2)

    const leases=createMySqlLeaseStore(pool,{database,tables:{leases:altName("leases")}})
    const lease=await leases.acquire({scopeId,namespace:"jobs",resourceId:"alt"},"worker",60_000)
    await leases.assertCurrent(lease!)
    await leases.release(lease!)
    expect(await count(pool,`SELECT COUNT(*) n FROM ${q("leases")}`)).toBe(1)

    const generations=createMySqlTagGenerationStore(pool,{database,tables:{cacheGenerations:altName("cache_generations")}})
    expect(await generations.advanceTagGeneration("tenant:t1")).toBe("1")
    expect(await generations.getTagGeneration("tenant:t1")).toBe("1")
    expect(await count(pool,`SELECT COUNT(*) n FROM ${q("cache_generations")}`)).toBe(1)
  })
})
