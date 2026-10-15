import type {Pool,PoolConnection,ResultSetHeader,RowDataPacket} from "mysql2/promise"
import {uuidv7} from "uuidv7"
import type {CancelJobArgs,ClaimDueJobsArgs,CompleteJobArgs,EnqueueJobArgs,FailJobArgs,ReleaseJobArgs,FindPendingArgs,GetByCorrelationIdArgs,GetByIdempotencyKeyArgs,GetJobByIdArgs,GetLatestPriorScheduleExecutionArgs,JobStore,JobTransitionResult,RenewLeaseArgs,RetryJobArgs,StoredJob} from "@xonava/core/execution"
import {assertDurableIdentifier,assertDurableJob,assertJobScopeCanEnqueue,assertRequesterCanEnqueueScope,buildJobFingerprintInput,decodeStoredJobMaxAttempts,encodeStoredJobMaxAttempts,fingerprintJob,jobFingerprintMatches,JobIdempotencyConflictError,requesterJobScope,requesterTenantId,scheduleCorrelationId} from "@xonava/core/execution"
import {ConfigurationError} from "@xonava/core/domain"
import {normalizeDrizzleError} from "../drizzle-shared/errors"
import {resolveMySqlTables,type MySqlTableOptions} from "./mysqlIdentifiers"
import {decodePersistedJobFingerprint,decodePersistedJobScope,encodeJobScope} from "../drizzle-shared/jobScope"

type Row=RowDataPacket&Record<string,unknown>
const json=<T>(value:unknown):T=>typeof value==="string"?JSON.parse(value) as T:value as T
const decode=(row:Row):StoredJob=>{const scope=row.scope as StoredJob["scope"];const tenantId=row.tenant_id==null?null:String(row.tenant_id);return {id:String(row.id),jobType:String(row.job_type),jobVersion:Number(row.job_version),tenantId,scope,executionScope:decodePersistedJobScope(scope,tenantId),payload:typeof row.payload==="string"?row.payload:JSON.stringify(row.payload),status:row.status as StoredJob["status"],priority:Number(row.priority),currentAttempt:Number(row.attempt),attemptsCompleted:Math.max(0,Number(row.attempt)-1),maxAttempts:decodeStoredJobMaxAttempts(row.max_attempts),runAt:new Date(row.run_at as string),nextAttemptAt:row.next_attempt_at==null?null:new Date(row.next_attempt_at as string),leaseOwner:row.worker_id==null?null:String(row.worker_id),leaseExpiresAt:row.lease_expires_at==null?null:new Date(row.lease_expires_at as string),claimToken:row.claim_token==null?null:String(row.claim_token),idempotencyKey:row.idempotency_key==null?null:String(row.idempotency_key),fingerprint:decodePersistedJobFingerprint(row.fingerprint),correlationId:row.correlation_id==null?null:String(row.correlation_id),lastError:row.last_error==null?null:String(row.last_error),resultPayload:row.result_payload==null?null:typeof row.result_payload==="string"?row.result_payload:JSON.stringify(row.result_payload),metadata:row.metadata==null?null:json<Record<string,unknown>>(row.metadata),partitionKey:row.partition_key==null?null:String(row.partition_key),createdAt:new Date(row.created_at as string),startedAt:row.started_at==null?null:new Date(row.started_at as string),completedAt:row.completed_at==null?null:new Date(row.completed_at as string)}}
/** Sanitized, machine-readable history failure: never echoes provider messages or SQL text. */
const historyFailure=(error:unknown):string=>{const details=normalizeDrizzleError(error,"mysql").details as {providerCode?:string}|undefined;const code=details?.providerCode;return code&&/^[A-Za-z0-9_]{1,64}$/.test(code)?`Execution history persistence failed (provider code ${code})`:"Execution history persistence failed"}
/** Reason recorded when a final-attempt lease expires without a terminal transition. */
export const MYSQL_JOB_LEASE_EXHAUSTED_REASON="LEASE_EXPIRED_ATTEMPTS_EXHAUSTED"
const DEAD_LETTER_SWEEP_LIMIT=100
const requester=(value:GetJobByIdArgs["requester"])=>value.scope==="tenant"?{sql:"scope=? AND tenant_id=?",params:[value.scope,value.tenantId]}:{sql:"scope=? AND tenant_id IS NULL",params:[requesterJobScope(value)]}

/** Production table names; override per deployment through {@link DrizzleMySqlJobStoreOptions.tables}. */
export const MYSQL_JOB_STORE_TABLES=Object.freeze({jobs:"jobs",jobExecutions:"job_executions"})
export type MySqlJobStoreTable=keyof typeof MYSQL_JOB_STORE_TABLES
export interface DrizzleMySqlJobStoreOptions extends MySqlTableOptions<MySqlJobStoreTable>{
  /**
   * "required" (default, the MySQL adapter's historical behaviour): each terminal/retry transition and its
   * job_executions row commit in one transaction; a failed history write rolls the transition back and
   * returns HISTORY_FAILED. "best_effort": the transition commits first and a history failure is reported
   * through `historyError` on an applied result.
   */
  readonly executionHistory?:"best_effort"|"required"
}
const isLockConflict=(error:unknown)=>{const code=(error as {errno?:number}).errno;return code===1213||code===1205}
type HistoryRow={id:string;jobId:string;attempt:number;workerId:string;status:string;error:string|null}

export class DrizzleMySqlJobStore implements JobStore{
  private readonly t:Readonly<Record<MySqlJobStoreTable,string>>
  private readonly executionHistory:"best_effort"|"required"
  constructor(private readonly pool:Pick<Pool,"query"|"getConnection">,options:DrizzleMySqlJobStoreOptions={}){
    this.t=resolveMySqlTables(MYSQL_JOB_STORE_TABLES,options)
    const mode=options.executionHistory??"required"
    if(mode!=="required"&&mode!=="best_effort")throw new ConfigurationError("executionHistory must be 'best_effort' or 'required'")
    this.executionHistory=mode
  }
  private async insertHistory(connection:Pick<Pool,"query">,row:HistoryRow):Promise<void>{await connection.query(`INSERT INTO ${this.t.jobExecutions}(id,job_id,attempt,worker_id,status,error_message,started_at,finished_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))`,[row.id,row.jobId,row.attempt,row.workerId,row.status,row.error])}
  /** Best-effort history write after a committed transition: failures are reported, never thrown. */
  private async bestEffortHistory(row:HistoryRow):Promise<JobTransitionResult>{try{await this.insertHistory(this.pool,row);return {applied:true,transitionToken:row.id}}catch(error){return {applied:true,transitionToken:row.id,historyError:historyFailure(error)}}}
  private async one(sqlText:string,params:unknown[]){const [rows]=await this.pool.query<Row[]>(sqlText,params);return rows[0]?decode(rows[0]):null}
  async enqueue(args:EnqueueJobArgs){const job=args.job;const {scope,tenantId}=encodeJobScope(job.executionScope);const runAt=job.runAt??new Date();assertDurableJob(job,runAt);assertRequesterCanEnqueueScope(args.requester,scope,tenantId);assertJobScopeCanEnqueue(scope,tenantId);const idempotencyScope=tenantId?`tenant:${tenantId}`:scope;const fingerprintInput=buildJobFingerprintInput(job,runAt);const fingerprint=await fingerprintJob(fingerprintInput);const id=uuidv7();try{await this.pool.query(`INSERT INTO ${this.t.jobs}(id,job_type,job_version,tenant_id,scope,payload,status,priority,attempt,max_attempts,run_at,next_attempt_at,idempotency_key,idempotency_scope,fingerprint,correlation_id,metadata,partition_key) VALUES(?,?,?,?,?,?,'pending',?,0,?,?,?,?,?,?,?,?,?)`,[id,job.jobType,job.jobVersion,tenantId,scope,JSON.stringify(job.payload),job.priority??0,encodeStoredJobMaxAttempts(job.maxAttempts),runAt,runAt,job.idempotencyKey??null,idempotencyScope,fingerprint,job.correlationId??null,job.metadata?JSON.stringify(job.metadata):null,job.partitionKey??null]);return (await this.one(`SELECT * FROM ${this.t.jobs} WHERE id=?`,[id]))!}catch(error){const code=(error as {errno?:number}).errno;if(code!==1062||!job.idempotencyKey)throw error;const existing=await this.one(`SELECT * FROM ${this.t.jobs} WHERE idempotency_scope=? AND idempotency_key=?`,[idempotencyScope,job.idempotencyKey]);if(!existing)throw error;if(!(await jobFingerprintMatches(existing.fingerprint,fingerprintInput)))throw new JobIdempotencyConflictError(idempotencyScope,job.idempotencyKey);return existing}}
  async getById(args:GetJobByIdArgs){const auth=requester(args.requester);return this.one(`SELECT * FROM ${this.t.jobs} WHERE id=? AND ${auth.sql}`,[args.id,...auth.params])}
  async getByCorrelationId(args:GetByCorrelationIdArgs){const auth=requester(args.requester);const [rows]=await this.pool.query<Row[]>(`SELECT * FROM ${this.t.jobs} WHERE correlation_id=? AND ${auth.sql} ORDER BY created_at DESC LIMIT 5`,[args.correlationId,...auth.params]);return rows.map(decode)}
  async getLatestPriorScheduleExecution(args:GetLatestPriorScheduleExecutionArgs){const auth=requester(args.requester);return this.one(`SELECT * FROM ${this.t.jobs} WHERE correlation_id=? AND run_at<? AND ${auth.sql} ORDER BY run_at DESC LIMIT 1`,[scheduleCorrelationId(args.scheduleId),args.beforeOccurrence,...auth.params])}
  async getByIdempotencyKey(args:GetByIdempotencyKeyArgs){const auth=requester(args.requester);const scope=requesterTenantId(args.requester)?`tenant:${requesterTenantId(args.requester)}`:requesterJobScope(args.requester);return this.one(`SELECT * FROM ${this.t.jobs} WHERE idempotency_scope=? AND idempotency_key=? AND ${auth.sql}`,[scope,args.key,...auth.params])}
  async claimDue(args:ClaimDueJobsArgs):Promise<StoredJob[]>{assertDurableIdentifier(args.workerId,"workerId",100);if(!Number.isSafeInteger(args.limit)||args.limit<=0)return [];for(let attempt=0;;attempt++){try{return await this.claimDueOnce(args)}catch(error){const code=(error as {errno?:number}).errno;if(attempt>=3||(code!==1213&&code!==1205))throw error}}}
  /**
   * Candidates are the heads of their partition: a partition (per scope and tenant) offers one job per batch, so a
   * busy or backlogged partition never fills LIMIT with rows that the jobs_active_partition_uq index would reject.
   * That index counts every status='running' row, including one whose lease already lapsed, so a lapsed (crashed)
   * job takes precedence over queued siblings as the partition head: otherwise the better-ranked queued job is the
   * head, can never take the slot, and the lapsed job is never reclaimed.
   */
  private async claimDueOnce(args:ClaimDueJobsArgs):Promise<StoredJob[]>{const auth=requester(args.requester);const connection=await this.pool.getConnection();try{await connection.beginTransaction();const deferredHistory=await this.deadLetterExhaustedLeases(connection,auth);const now=args.now??new Date();const [rows]=await connection.query<Row[]>(`SELECT j.* FROM ${this.t.jobs} j WHERE ${auth.sql} AND ((status IN ('pending','retrying') AND attempt<max_attempts AND COALESCE(next_attempt_at,run_at)<=?) OR (status='running' AND attempt<max_attempts AND lease_expires_at<CURRENT_TIMESTAMP(3))) AND (partition_key IS NULL OR (NOT EXISTS(SELECT 1 FROM ${this.t.jobs} sibling WHERE sibling.partition_key=j.partition_key AND sibling.scope=j.scope AND sibling.tenant_id<=>j.tenant_id AND sibling.status='running' AND sibling.lease_expires_at>CURRENT_TIMESTAMP(3) AND sibling.id<>j.id) AND NOT EXISTS(SELECT 1 FROM ${this.t.jobs} ahead WHERE ahead.partition_key=j.partition_key AND ahead.scope=j.scope AND ahead.tenant_id<=>j.tenant_id AND ahead.id<>j.id AND ((ahead.status IN ('pending','retrying') AND ahead.attempt<ahead.max_attempts AND COALESCE(ahead.next_attempt_at,ahead.run_at)<=?) OR (ahead.status='running' AND ahead.attempt<ahead.max_attempts AND ahead.lease_expires_at<CURRENT_TIMESTAMP(3))) AND ((ahead.status='running')>(j.status='running') OR ((ahead.status='running')=(j.status='running') AND (ahead.priority,ahead.run_at,ahead.id)<(j.priority,j.run_at,j.id)))))) ORDER BY priority,run_at,id LIMIT ? FOR UPDATE SKIP LOCKED`,[...auth.params,now,now,args.limit]);const claimed:StoredJob[]=[];for(const row of rows){const token=uuidv7();try{const [changed]=await connection.query<ResultSetHeader>(`UPDATE ${this.t.jobs} SET status='running',worker_id=?,claim_token=?,lease_expires_at=TIMESTAMPADD(MICROSECOND,?*1000,CURRENT_TIMESTAMP(3)),attempt=attempt+1,started_at=?,next_attempt_at=NULL WHERE id=? AND (status<>'running' OR lease_expires_at<CURRENT_TIMESTAMP(3))`,[args.workerId,token,args.leaseDurationMs,now,row.id]);if(changed.affectedRows===1){const [fresh]=await connection.query<Row[]>(`SELECT * FROM ${this.t.jobs} WHERE id=?`,[row.id]);claimed.push(decode(fresh[0]!))}}catch(error){if((error as {errno?:number}).errno!==1062)throw error}}await connection.commit();for(const history of deferredHistory)await this.bestEffortHistory(history);return claimed}catch(error){await connection.rollback();throw error}finally{connection.release()}}
  /**
   * A running job whose lease expired on its final attempt can never be reclaimed; move it to dead_letter (DB clock)
   * so it stops holding its partition. Required history: the dead-letter UPDATE and its job_executions row share a
   * savepoint, so both commit or neither (the job stays swept-pending and the claim proceeds). Best-effort: the rows
   * are returned and written after the claim commits.
   */
  private async deadLetterExhaustedLeases(connection:PoolConnection,auth:{sql:string;params:unknown[]}):Promise<HistoryRow[]>{
    const [rows]=await connection.query<Row[]>(`SELECT id,attempt,worker_id FROM ${this.t.jobs} WHERE ${auth.sql} AND status='running' AND attempt>=max_attempts AND lease_expires_at<CURRENT_TIMESTAMP(3) LIMIT ? FOR UPDATE SKIP LOCKED`,[...auth.params,DEAD_LETTER_SWEEP_LIMIT])
    const deferred:HistoryRow[]=[]
    for(const row of rows){
      const history:HistoryRow={id:uuidv7(),jobId:String(row.id),attempt:Number(row.attempt),workerId:row.worker_id==null?"lease-expiry":String(row.worker_id),status:"dead_letter",error:MYSQL_JOB_LEASE_EXHAUSTED_REASON}
      const deadLetter=()=>connection.query<ResultSetHeader>(`UPDATE ${this.t.jobs} SET status='dead_letter',last_error=?,completed_at=CURRENT_TIMESTAMP(3),worker_id=NULL,claim_token=NULL,lease_expires_at=NULL WHERE id=? AND status='running' AND attempt>=max_attempts AND lease_expires_at<CURRENT_TIMESTAMP(3)`,[MYSQL_JOB_LEASE_EXHAUSTED_REASON,row.id])
      if(this.executionHistory==="best_effort"){const [changed]=await deadLetter();if(changed.affectedRows===1)deferred.push(history);continue}
      await connection.query("SAVEPOINT framework_dead_letter")
      try{const [changed]=await deadLetter();if(changed.affectedRows===1)await this.insertHistory(connection,history);await connection.query("RELEASE SAVEPOINT framework_dead_letter")}
      catch(error){if(isLockConflict(error))throw error;await connection.query("ROLLBACK TO SAVEPOINT framework_dead_letter")}
    }
    return deferred
  }
  async renewLease(args:RenewLeaseArgs){assertDurableIdentifier(args.workerId,"workerId",100);if(!Number.isFinite(args.extendByMs)||args.extendByMs<=0)return false;const [result]=await this.pool.query<ResultSetHeader>(`UPDATE ${this.t.jobs} SET lease_expires_at=GREATEST(lease_expires_at,TIMESTAMPADD(MICROSECOND,?*1000,CURRENT_TIMESTAMP(3))) WHERE id=? AND worker_id=? AND claim_token=? AND status='running' AND lease_expires_at>CURRENT_TIMESTAMP(3)`,[args.extendByMs,args.jobId,args.workerId,args.claimToken]);return result.affectedRows===1}
  private async transition(args:{jobId:string;workerId:string;claimToken:string;attempt:number;status:string;set:string;values:unknown[];error?:string;guard?:string}):Promise<JobTransitionResult>{
    const token=uuidv7()
    const history:HistoryRow={id:token,jobId:args.jobId,attempt:args.attempt,workerId:args.workerId,status:args.status,error:args.error??null}
    const update=`UPDATE ${this.t.jobs} SET ${args.set} WHERE id=? AND worker_id=? AND claim_token=? AND attempt=? AND status='running' AND lease_expires_at>CURRENT_TIMESTAMP(3)${args.guard??""}`
    const params=[...args.values,args.jobId,args.workerId,args.claimToken,args.attempt]
    if(this.executionHistory==="best_effort"){const [result]=await this.pool.query<ResultSetHeader>(update,params);if(result.affectedRows!==1)return {applied:false,reason:"LEASE_LOST"};return this.bestEffortHistory(history)}
    const connection=await this.pool.getConnection()
    try{await connection.beginTransaction();const [result]=await connection.query<ResultSetHeader>(update,params);if(result.affectedRows!==1){await connection.rollback();return {applied:false,reason:"LEASE_LOST"}}await this.insertHistory(connection,history);await connection.commit();return {applied:true,transitionToken:token}}
    catch(error){await connection.rollback();return {applied:false,reason:"HISTORY_FAILED",historyError:historyFailure(error)}}
    finally{connection.release()}
  }
  markSucceeded(args:CompleteJobArgs){return this.transition({...args,status:"succeeded",set:"status='succeeded',result_payload=?,completed_at=CURRENT_TIMESTAMP(3),worker_id=NULL,claim_token=NULL,lease_expires_at=NULL",values:[args.result?JSON.stringify(args.result):null]})}
  /** Gives a live claim back without consuming the attempt counted at claim time. */
  async release(args:ReleaseJobArgs):Promise<JobTransitionResult>{const [result]=await this.pool.query<ResultSetHeader>(`UPDATE ${this.t.jobs} SET status='retrying',attempt=GREATEST(attempt-1,0),next_attempt_at=?,last_error=?,worker_id=NULL,claim_token=NULL,lease_expires_at=NULL WHERE id=? AND worker_id=? AND claim_token=? AND status='running' AND lease_expires_at>CURRENT_TIMESTAMP(3)`,[args.nextAttemptAt,args.reason.slice(0,512),args.jobId,args.workerId,args.claimToken]);return result.affectedRows===1?{applied:true}:{applied:false,reason:"LEASE_LOST"}}
  markRetrying(args:RetryJobArgs){return this.transition({...args,status:"retrying",set:"status='retrying',next_attempt_at=?,last_error=?,worker_id=NULL,claim_token=NULL,lease_expires_at=NULL",values:[args.nextAttemptAt,args.error],error:args.error,guard:" AND attempt<max_attempts"})}
  markFailed(args:FailJobArgs){return this.transition({...args,set:"status=?,last_error=?,completed_at=CURRENT_TIMESTAMP(3),worker_id=NULL,claim_token=NULL,lease_expires_at=NULL",values:[args.status,args.error],error:args.error})}
  async cancel(args:CancelJobArgs):Promise<JobTransitionResult>{
    const auth=requester(args.requester);const token=uuidv7();const reason=args.reason??null
    const cancelSql=`UPDATE ${this.t.jobs} SET status='cancelled',completed_at=CURRENT_TIMESTAMP(3),last_error=?,worker_id=NULL,claim_token=NULL,lease_expires_at=NULL WHERE id=? AND ${auth.sql} AND status NOT IN ('succeeded','failed','cancelled','dead_letter')`
    if(this.executionHistory==="best_effort"){
      const [result]=await this.pool.query<ResultSetHeader>(cancelSql,[reason,args.jobId,...auth.params])
      if(result.affectedRows!==1)return {applied:false,reason:"INVALID_STATE"}
      const [rows]=await this.pool.query<Row[]>(`SELECT attempt FROM ${this.t.jobs} WHERE id=?`,[args.jobId])
      return this.bestEffortHistory({id:token,jobId:args.jobId,attempt:Number(rows[0]?.attempt??0),workerId:"cancellation",status:"cancelled",error:reason})
    }
    const connection=await this.pool.getConnection()
    try{await connection.beginTransaction();const [rows]=await connection.query<Row[]>(`SELECT attempt FROM ${this.t.jobs} WHERE id=? AND ${auth.sql} AND status NOT IN ('succeeded','failed','cancelled','dead_letter') FOR UPDATE`,[args.jobId,...auth.params]);if(!rows[0]){await connection.rollback();return {applied:false,reason:"INVALID_STATE"}}await connection.query(cancelSql,[reason,args.jobId,...auth.params]);await this.insertHistory(connection,{id:token,jobId:args.jobId,attempt:Number(rows[0].attempt),workerId:"cancellation",status:"cancelled",error:reason});await connection.commit();return {applied:true,transitionToken:token}}
    catch(error){await connection.rollback();return {applied:false,reason:"HISTORY_FAILED",historyError:historyFailure(error)}}
    finally{connection.release()}
  }
  async findPending(args:FindPendingArgs){const auth=requester(args.requester);const params:unknown[]=[...auth.params];let filter="";if(args.jobType){filter=" AND job_type=?";params.push(args.jobType)}params.push(args.limit??100);const [rows]=await this.pool.query<Row[]>(`SELECT * FROM ${this.t.jobs} WHERE status IN ('pending','retrying') AND ${auth.sql}${filter} ORDER BY priority,created_at LIMIT ?`,params);return rows.map(decode)}
}
