import type { StartWorkflowInput, WorkflowFence, WorkflowStore } from "core/workflow"
import type { WorkflowClaim, WorkflowInstance, WorkflowSignal } from "core/workflow"
import { assertWorkflowDurableValue, isWorkflowSignalWait } from "core/workflow"
import { decodeWorkflowFailure, encodeWorkflowFailure } from "../drizzle-shared/workflowFailureCodec"

interface D1Result { success: boolean; meta?: { changes?: number }; results?: Record<string, unknown>[] }
interface Statement { bind(...values: unknown[]): Statement; run(): Promise<D1Result>; all(): Promise<D1Result>; first<T=Record<string,unknown>>(): Promise<T|null> }
interface D1Database { prepare(sql: string): Statement; batch(statements: Statement[]): Promise<D1Result[]> }
function date(value: unknown): Date|null { return value==null ? null : new Date(Number(value)) }
function decode(row: Record<string,unknown>): WorkflowInstance { return { id:String(row.id),workflowType:String(row.workflow_type),workflowVersion:Number(row.workflow_version),executionScope:JSON.parse(String(row.execution_scope)),status:row.status as WorkflowInstance["status"],currentStep:String(row.current_step),variables:JSON.parse(String(row.variables)),stepAttempt:Number(row.step_attempt),compensationStack:JSON.parse(String(row.compensation_stack)),waitingSignal:row.waiting_signal==null?null:String(row.waiting_signal),wakeAt:date(row.wake_at_ms),outcome:row.outcome==null?null:row.outcome as WorkflowInstance["outcome"],revision:Number(row.revision),resumeSignalId:row.resume_signal_id==null?null:String(row.resume_signal_id),failure:decodeWorkflowFailure(row.failure),leaseOwner:row.lease_owner==null?null:String(row.lease_owner),claimToken:row.claim_token==null?null:String(row.claim_token),leaseExpiresAt:date(row.lease_expires_at_ms),createdAt:new Date(Number(row.created_at_ms)),updatedAt:new Date(Number(row.updated_at_ms)) } }
const NOW = "CAST(unixepoch('subsec')*1000 AS INTEGER)"
const TERMINAL = "('succeeded','failed','cancelled','compensation_failed')"
function decodeSignal(row: Record<string,unknown>|null): WorkflowSignal|null { if(!row) return null; let payload:unknown; try { payload=JSON.parse(String(row.payload)) } catch { return null } if(!payload||typeof payload!=="object"||Array.isArray(payload)) return null; return { id:String(row.id),instanceId:String(row.instance_id),name:String(row.name),payload:payload as Record<string,unknown>,deliveredAt:new Date(Number(row.delivered_at_ms)) } }
export class DrizzleD1WorkflowStore implements WorkflowStore {
  constructor(private readonly db:D1Database){}
  async start(input:StartWorkflowInput):Promise<WorkflowInstance>{ assertWorkflowDurableValue(input.variables); await this.db.prepare(`INSERT INTO framework_workflows (id,workflow_type,workflow_version,execution_scope,status,current_step,variables,created_at_ms,updated_at_ms) VALUES (?,?,?,?, 'pending',?,?,CAST(unixepoch('subsec')*1000 AS INTEGER),CAST(unixepoch('subsec')*1000 AS INTEGER))`).bind(input.id,input.workflowType,input.workflowVersion,JSON.stringify(input.executionScope),input.initialStep,JSON.stringify(input.variables)).run(); return (await this.get(input.id))! }
  async get(id:string):Promise<WorkflowInstance|null>{ const row=await this.db.prepare("SELECT * FROM framework_workflows WHERE id=?").bind(id).first(); return row?decode(row):null }
  async claimDue(args:{workerId:string;limit:number;leaseDurationMs:number;now?:Date}):Promise<readonly WorkflowClaim[]>{ const token=crypto.randomUUID(); const result=await this.db.prepare(`UPDATE framework_workflows SET status=CASE WHEN status='waiting' THEN 'pending' ELSE status END,lease_owner=?,claim_token=?,lease_expires_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER)+?,step_attempt=step_attempt+1,revision=revision+1,updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id IN (SELECT id FROM framework_workflows WHERE (status='pending' OR (status='compensating' AND (wake_at_ms IS NULL OR wake_at_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER))) OR (status='waiting' AND wake_at_ms IS NOT NULL AND wake_at_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER))) AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=CAST(unixepoch('subsec')*1000 AS INTEGER)) ORDER BY updated_at_ms LIMIT ?) RETURNING *`).bind(args.workerId,token,args.leaseDurationMs,args.limit).all(); return (result.results??[]).map(row=>({instance:decode(row),workerId:args.workerId,claimToken:token})) }
  async assertLease(fence:WorkflowFence){const row=await this.db.prepare("SELECT id FROM framework_workflows WHERE id=? AND lease_owner=? AND claim_token=? AND revision=? AND lease_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)").bind(fence.instanceId,fence.workerId,fence.claimToken,fence.revision).first();return row!==null}
  async renewLease(fence:WorkflowFence,extendByMs:number){const result=await this.db.prepare("UPDATE framework_workflows SET lease_expires_at_ms=MAX(lease_expires_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER)+?) WHERE id=? AND lease_owner=? AND claim_token=? AND revision=? AND lease_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)").bind(extendByMs,fence.instanceId,fence.workerId,fence.claimToken,fence.revision).run();return result.meta?.changes===1}
  /**
   * Fenced transition as one atomic `db.batch`. A batch cannot branch on a statement's result, so each statement is
   * state-conditional: for a signal wait, (1) consumes the oldest pending receipt of the awaited name, guarded by
   * EXISTS on the fenced row and recording `consumed_revision = fence.revision + 1`; (2) updates the workflow row inside
   * the fence, taking `resume_signal_id` from the receipt consumed at that revision and switching to the resumed shape
   * (pending, attempt 0, no timer) when there is one. Acceptance is the workflow update's change count; a rejected
   * fence consumes nothing because (1) is guarded by the same fence.
   */
  async commit(f:WorkflowFence,next:WorkflowInstance):Promise<boolean>{
    const fenced=`id=? AND lease_owner=? AND claim_token=? AND revision=? AND lease_expires_at_ms>${NOW}`
    const fenceBinds=[f.instanceId,f.workerId,f.claimToken,f.revision]
    const common=[next.workflowVersion,next.currentStep,JSON.stringify(next.variables),JSON.stringify(next.compensationStack),next.waitingSignal,next.outcome,encodeWorkflowFailure(next.failure)] as const
    if(!isWorkflowSignalWait(next)){
      const r=await this.db.prepare(`UPDATE framework_workflows SET workflow_version=?,status=?,current_step=?,variables=?,step_attempt=?,compensation_stack=?,waiting_signal=?,wake_at_ms=?,outcome=?,failure=?,resume_signal_id=?,revision=revision+1,lease_owner=NULL,claim_token=NULL,lease_expires_at_ms=NULL,updated_at_ms=${NOW} WHERE ${fenced}`).bind(next.workflowVersion,next.status,next.currentStep,JSON.stringify(next.variables),next.stepAttempt,JSON.stringify(next.compensationStack),next.waitingSignal,next.wakeAt?.getTime()??null,next.outcome,encodeWorkflowFailure(next.failure),next.resumeSignalId??null,...fenceBinds).run()
      return r.meta?.changes===1
    }
    const consume=this.db.prepare(`UPDATE framework_workflow_signals SET consumed_at_ms=${NOW},consumed_revision=? WHERE id=(SELECT id FROM framework_workflow_signals WHERE instance_id=? AND name=? AND consumed_at_ms IS NULL ORDER BY seq LIMIT 1) AND EXISTS (SELECT 1 FROM framework_workflows WHERE ${fenced})`).bind(f.revision+1,f.instanceId,next.waitingSignal,...fenceBinds)
    const resumed=`(SELECT id FROM framework_workflow_signals WHERE instance_id=? AND name=? AND consumed_revision=?)`
    const resumeBinds=[f.instanceId,next.waitingSignal,f.revision+1]
    const update=this.db.prepare(`UPDATE framework_workflows SET workflow_version=?,status=CASE WHEN ${resumed} IS NOT NULL THEN 'pending' ELSE ? END,current_step=?,variables=?,step_attempt=CASE WHEN ${resumed} IS NOT NULL THEN 0 ELSE ? END,compensation_stack=?,waiting_signal=?,wake_at_ms=CASE WHEN ${resumed} IS NOT NULL THEN NULL ELSE ? END,outcome=?,failure=?,resume_signal_id=${resumed},revision=revision+1,lease_owner=NULL,claim_token=NULL,lease_expires_at_ms=NULL,updated_at_ms=${NOW} WHERE ${fenced}`).bind(common[0],...resumeBinds,next.status,common[1],common[2],...resumeBinds,next.stepAttempt,common[3],common[4],...resumeBinds,next.wakeAt?.getTime()??null,common[5],common[6],...resumeBinds,...fenceBinds)
    const results=await this.db.batch([consume,update])
    return results[1]?.meta?.changes===1
  }
  /**
   * Records a signal receipt in one atomic batch of state-conditional statements: (1) insert, only for an existing,
   * non-terminal instance and an unused id, with `seq = MAX(seq)+1` (D1 serializes writes, so the order is the commit
   * order); (2) when the instance is waiting for the name, consume the oldest pending receipt of the name at
   * `revision + 1`; (3) wake the instance with that receipt. Statements 2 and 3 run only if the previous one changed a
   * row. When nothing was inserted, a read tells an unknown/terminal instance from a duplicate id.
   */
  async deliverSignal(signal:Omit<WorkflowSignal,"deliveredAt">):Promise<{delivered:boolean;duplicate:boolean}>{
    const waiting=`status='waiting' AND wake_at_ms IS NULL AND waiting_signal=?`
    const insert=this.db.prepare(`INSERT INTO framework_workflow_signals (id,instance_id,name,payload,delivered_at_ms,seq) SELECT ?,?,?,?,${NOW},(SELECT COALESCE(MAX(seq),0)+1 FROM framework_workflow_signals) WHERE EXISTS (SELECT 1 FROM framework_workflows WHERE id=? AND status NOT IN ${TERMINAL}) AND NOT EXISTS (SELECT 1 FROM framework_workflow_signals WHERE id=?)`).bind(signal.id,signal.instanceId,signal.name,JSON.stringify(signal.payload),signal.instanceId,signal.id)
    const consume=this.db.prepare(`UPDATE framework_workflow_signals SET consumed_at_ms=${NOW},consumed_revision=(SELECT revision+1 FROM framework_workflows WHERE id=?) WHERE changes()=1 AND EXISTS (SELECT 1 FROM framework_workflows WHERE id=? AND ${waiting}) AND id=(SELECT id FROM framework_workflow_signals WHERE instance_id=? AND name=? AND consumed_at_ms IS NULL ORDER BY seq LIMIT 1)`).bind(signal.instanceId,signal.instanceId,signal.name,signal.instanceId,signal.name)
    const wake=this.db.prepare(`UPDATE framework_workflows SET status='pending',wake_at_ms=NULL,step_attempt=0,resume_signal_id=(SELECT id FROM framework_workflow_signals WHERE instance_id=framework_workflows.id AND name=? AND consumed_revision=framework_workflows.revision+1),revision=revision+1,updated_at_ms=${NOW} WHERE changes()=1 AND id=? AND ${waiting}`).bind(signal.name,signal.instanceId,signal.name)
    const [result]=await this.db.batch([insert,consume,wake])
    if(result?.meta?.changes===1) return {delivered:true,duplicate:false}
    const state=await this.db.prepare("SELECT (SELECT 1 FROM framework_workflows WHERE id=?) AS instance,(SELECT 1 FROM framework_workflow_signals WHERE id=?) AS stored").bind(signal.instanceId,signal.id).first<{instance:number|null;stored:number|null}>()
    return {delivered:false,duplicate:state?.instance!=null&&state.stored!=null}
  }
  async cancel(id:string):Promise<boolean>{ const r=await this.db.prepare(`UPDATE framework_workflows SET status=CASE WHEN json_array_length(compensation_stack)>0 THEN 'compensating' ELSE 'cancelled' END,outcome=CASE WHEN json_array_length(compensation_stack)>0 THEN NULL ELSE 'cancelled' END,failure=json_object('code','CANCELLED','message','Workflow was cancelled','step',current_step,'phase','execute','attempt',step_attempt,'at',strftime('%Y-%m-%dT%H:%M:%fZ','now')),step_attempt=0,waiting_signal=NULL,resume_signal_id=NULL,wake_at_ms=NULL,revision=revision+1,lease_owner=NULL,claim_token=NULL,lease_expires_at_ms=NULL,updated_at_ms=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE id=? AND status NOT IN ('succeeded','failed','cancelled','compensation_failed','compensating')`).bind(id).run(); return r.meta?.changes===1 }
  /** The latest receipt of this name by delivery order, pending or consumed (legacy lookup; see `getSignalById`). */
  async getSignal(instanceId:string,name:string):Promise<WorkflowSignal|null>{ return decodeSignal(await this.db.prepare("SELECT id,instance_id,name,payload,delivered_at_ms FROM framework_workflow_signals WHERE instance_id=? AND name=? ORDER BY seq DESC LIMIT 1").bind(instanceId,name).first()) }
  /** The receipt with this id for this instance, pending or consumed. */
  async getSignalById(instanceId:string,signalId:string):Promise<WorkflowSignal|null>{ return decodeSignal(await this.db.prepare("SELECT id,instance_id,name,payload,delivered_at_ms FROM framework_workflow_signals WHERE instance_id=? AND id=?").bind(instanceId,signalId).first()) }
}
